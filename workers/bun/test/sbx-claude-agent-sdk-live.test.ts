import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { SbxExecutionEnvironmentBackend } from "../src/execution-environment/sbx-backend.ts";
import type {
  SbxClient,
  SbxSandboxSummary,
} from "../src/execution-environment/sbx-client.ts";
import { CliSbxClient } from "../src/execution-environment/sbx-client.ts";
import {
  SBX_CLAUDE_AGENT_SDK_VERSION,
  SBX_CLAUDE_CODE_VERSION,
  SBX_CLAUDE_LINUX_ARM64_SHA256,
  SBX_CLAUDE_LINUX_X64_SHA256,
  SBX_CLAUDE_SDK_MODULE,
  SBX_CLAUDE_SDK_PACKAGE_JSON,
  SBX_CLAUDE_WRAPPER,
  SBX_CLAUDE_WRAPPER_SHA256,
  SBX_CLAUDE_WRAPPER_VERSION,
  SBX_CLAUDE_ZOD_MODULE,
  SBX_CODING_EXECUTION_PROFILE_V3,
  SBX_CODING_PROFILE,
  SBX_DISPOSABLE_RESOURCE_POLICY,
  SBX_GUEST_PATHS,
  SBX_MIXED_RUNTIME_NETWORK_TARGETS,
} from "../src/execution-environment/sbx-profile.ts";
import type {
  SbxEnvironmentVerifier,
  SbxVerifiedEnvironment,
} from "../src/execution-environment/sbx-verifier.ts";
import type { DurableEnvironmentRecord } from "../src/execution-environment/store.ts";
import type {
  EnvironmentCapability,
  EnvironmentSpec,
  StreamedProcess,
  StreamedProcessStreamEvent,
} from "../src/execution-environment/types.ts";
import {
  classifyClaudeSubscriptionAuthStatus,
  claudeSubscriptionEnvironment,
} from "../src/harnesses/claude-agent-sdk/auth.ts";

const live = process.env.QE_LIVE_SBX_CLAUDE === "1";
const authPreflightLive = process.env.QE_LIVE_SBX_CLAUDE_AUTH_PREFLIGHT === "1";

/**
 * Bounded auth-status-only proof. It never invokes login or the SDK wrapper.
 * The first status call recreates the historical non-secret disable sentinel;
 * the second uses the production explicit environment policy.
 */
test.skipIf(!authPreflightLive)(
  "live SBX classifies the historical API-key selector and isolates clean subscription preflight",
  async () => {
    const parent = join(process.cwd(), ".pi", "tmp");
    await mkdir(parent, { recursive: true });
    const root = await mkdtemp(join(parent, "sbx-claude-auth-preflight-"));
    const client = new CliSbxClient(process.env.QE_SBX_BIN);
    const verifier = new ZeroInferenceClaudeVerifier(client);
    const backend = new SbxExecutionEnvironmentBackend({
      workerId: "worker-claude-auth-preflight",
      dataRoot: root,
      client,
      verifier,
      executionProfile: SBX_CODING_PROFILE,
      credentialProvisioner: { provision: async () => undefined },
      reconciliationPollMs: 500,
      reconciliationAttempts: 120,
    });
    let lease: Awaited<ReturnType<typeof backend.ensure>> | null = null;
    try {
      lease = await backend.ensure(
        claudeProofSpec(
          `claude-auth-preflight-${Date.now()}`,
          "worker-claude-auth-preflight",
        ),
      );
      const configDirectory = `${SBX_GUEST_PATHS.state}/claude-auth-preflight/config`;
      await lease.workerExec({
        executable: "/usr/bin/install",
        args: [
          "-d",
          "-m",
          "0700",
          "-o",
          "1000",
          "-g",
          "1000",
          configDirectory,
          `${configDirectory}/.tmp`,
        ],
      });
      const runtime = verifier.provenance?.runtime;
      if (typeof runtime !== "string")
        throw new Error("Pinned Claude runtime proof is unavailable.");
      const environment = claudeSubscriptionEnvironment(configDirectory);
      const historical = await lease.exec(
        authStatusCommand(runtime, lease.paths.workspace, {
          ...environment,
          ANTHROPIC_API_KEY: "none",
        }),
      );
      expect(
        classifyClaudeSubscriptionAuthStatus(historical, configDirectory),
      ).toMatchObject({
        authState: "forbidden_auth_method",
        authMethod: "api_key",
      });

      const isolated = await lease.exec(
        authStatusCommand(runtime, lease.paths.workspace, environment),
      );
      expect(
        classifyClaudeSubscriptionAuthStatus(isolated, configDirectory),
      ).toMatchObject({
        authState: "authentication_required",
        authMethod: "none",
      });
      const credentialMetadata = await lease.exec({
        executable: "/usr/bin/env",
        args: [
          "-i",
          "/usr/bin/python3",
          "-c",
          "import os,sys;sys.exit(43 if os.path.exists(sys.argv[1]) else 0)",
          `${configDirectory}/.credentials.json`,
        ],
        cwd: lease.paths.workspace,
        environment: {},
        timeoutMs: 30_000,
      });
      expect(credentialMetadata.exitCode).toBe(0);
    } finally {
      if (lease) {
        await backend.stop(lease.ref).catch(() => undefined);
        for (let attempt = 0; attempt < 120; attempt += 1) {
          const stopped = await backend
            .reconcileStop(lease.ref)
            .catch(() => null);
          if (stopped?.state === "stopped") break;
          await Bun.sleep(500);
        }
        await backend.remove(lease.ref).catch(() => undefined);
      }
      await backend.close().catch(() => undefined);
      await rm(root, { recursive: true, force: true });
    }
  },
  20 * 60 * 1_000,
);

/**
 * Zero-inference proof. It installs and verifies the real immutable v3 kit,
 * starts the real QE wrapper through EnvironmentLease.spawnStreamed, and
 * proves authentication_required before query() can be constructed. The
 * validation verifier intentionally provisions no Pi/Antigravity credential
 * and performs no model/provider request.
 */
test.skipIf(!live)(
  "live SBX validates pinned Claude artifacts and unauthenticated headless wrapper with zero inference",
  async () => {
    const parent = join(process.cwd(), ".pi", "tmp");
    await mkdir(parent, { recursive: true });
    const root = await mkdtemp(join(parent, "sbx-claude-live-"));
    const client = new CliSbxClient(process.env.QE_SBX_BIN);
    const verifier = new ZeroInferenceClaudeVerifier(client);
    const backend = new SbxExecutionEnvironmentBackend({
      workerId: "worker-claude-zero-inference",
      dataRoot: root,
      client,
      verifier,
      executionProfile: SBX_CODING_PROFILE,
      credentialProvisioner: { provision: async () => undefined },
      reconciliationPollMs: 500,
      reconciliationAttempts: 120,
    });
    let streamProcess: StreamedProcess | null = null;
    try {
      const spec = claudeProofSpec(`claude-proof-${Date.now()}`);
      const lease = await backend.ensure(spec);
      expect(lease.ref.profile).toEqual(SBX_CODING_EXECUTION_PROFILE_V3);
      expect(lease.capabilities).toContainEqual(
        expect.objectContaining({
          kind: "process.streamed",
          mode: "attached_only",
        }),
      );
      expect(verifier.provenance).toMatchObject({
        sdk: SBX_CLAUDE_AGENT_SDK_VERSION,
        code: SBX_CLAUDE_CODE_VERSION,
        wrapperExecutable: true,
        wrapperSha256: SBX_CLAUDE_WRAPPER_SHA256,
        credentialsPresent: false,
        hostUsersVisible: false,
        sshAgentVisible: false,
      });

      const configDirectory = `${SBX_GUEST_PATHS.state}/claude-proof/config`;
      const controlDirectory = `${SBX_GUEST_PATHS.control}/claude-proof`;
      await lease.workerExec({
        executable: "/usr/bin/install",
        args: [
          "-d",
          "-m",
          "0700",
          "-o",
          "1000",
          "-g",
          "1000",
          configDirectory,
          `${configDirectory}/.tmp`,
          controlDirectory,
        ],
      });
      const runtime = verifier.provenance?.runtime as string;
      const runtimeSha256 = verifier.provenance?.sha256 as string;
      const generation = crypto.randomUUID();
      const initializeRequest = crypto.randomUUID();
      streamProcess = await lease.spawnStreamed({
        executable: SBX_CLAUDE_WRAPPER,
        args: [],
        cwd: lease.paths.workspace,
        environment: {
          HOME: configDirectory,
          CLAUDE_CONFIG_DIR: configDirectory,
          TMPDIR: `${configDirectory}/.tmp`,
          PATH: "/usr/local/bin:/usr/bin:/bin",
          LANG: "C.UTF-8",
          BROWSER: "/bin/false",
          CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
          CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
          DISABLE_AUTOUPDATER: "1",
          DISABLE_TELEMETRY: "1",
          DISABLE_ERROR_REPORTING: "1",
        },
      });
      const stdout = ndjson(streamProcess.stdout);
      await streamProcess.write(
        new TextEncoder().encode(
          `${JSON.stringify({
            protocol_version: 2,
            generation,
            type: "initialize",
            request_id: initializeRequest,
            configuration: {
              backend: "sdk",
              wrapper_version: SBX_CLAUDE_WRAPPER_VERSION,
              sdk_version: SBX_CLAUDE_AGENT_SDK_VERSION,
              claude_code_version: SBX_CLAUDE_CODE_VERSION,
              runtime_sha256: runtimeSha256,
              claude_executable: runtime,
              sdk_module: SBX_CLAUDE_SDK_MODULE,
              sdk_package_json: SBX_CLAUDE_SDK_PACKAGE_JSON,
              zod_module: SBX_CLAUDE_ZOD_MODULE,
              workspace: lease.paths.workspace,
              workspace_access: "none",
              config_dir: configDirectory,
              control_descriptor: `${controlDirectory}/descriptor.json`,
              temp_dir: `${configDirectory}/.tmp`,
              model: "claude-zero-inference-proof",
              effort: "high",
              tools: [],
              native_session_id: null,
              runtime_models: [],
              fake: null,
            },
          })}\n`,
        ),
      );
      expect(await stdout.next()).toMatchObject({
        value: {
          type: "ready",
          request_id: initializeRequest,
          authentication: "authentication_required",
          setup_available: true,
          wrapper_version: SBX_CLAUDE_WRAPPER_VERSION,
          sdk_version: SBX_CLAUDE_AGENT_SDK_VERSION,
          claude_code_version: SBX_CLAUDE_CODE_VERSION,
          runtime_sha256: runtimeSha256,
          models: [],
          query_state: "not_invoked",
          query_invocation_count: 0,
        },
      });
      await streamProcess.write(
        new TextEncoder().encode(
          `${JSON.stringify({
            protocol_version: 2,
            generation,
            type: "shutdown",
            request_id: crypto.randomUUID(),
          })}\n`,
        ),
      );
      expect(await stdout.next()).toMatchObject({
        value: { type: "shutdown", accepted: true },
      });
      expect(await streamProcess.exit).toEqual({ kind: "exited", exitCode: 0 });
      streamProcess = null;

      const inspection = await backend.inspect(lease.ref);
      expect(inspection.state).toBe("running");
      await backend.stop(lease.ref);
      for (let attempt = 0; attempt < 120; attempt += 1) {
        const stopped = await backend.reconcileStop(lease.ref);
        if (stopped.state === "stopped") break;
        await Bun.sleep(500);
      }
      await backend.remove(lease.ref);
    } finally {
      await streamProcess?.cancel().catch(() => undefined);
      await backend.close().catch(() => undefined);
      await rm(root, { recursive: true, force: true });
    }
  },
  20 * 60 * 1_000,
);

class ZeroInferenceClaudeVerifier implements SbxEnvironmentVerifier {
  provenance: Record<string, unknown> | null = null;

  constructor(private readonly client: SbxClient) {}

  async initialize(
    record: DurableEnvironmentRecord,
    sandbox: SbxSandboxSummary,
  ): Promise<SbxVerifiedEnvironment> {
    await this.client.exec(
      sandbox.name,
      {
        executable: "/usr/bin/install",
        args: [
          "-d",
          "-m",
          "0700",
          "-o",
          "1000",
          "-g",
          "1000",
          SBX_GUEST_PATHS.workspace,
          SBX_GUEST_PATHS.state,
          SBX_GUEST_PATHS.control,
          SBX_GUEST_PATHS.cache,
          SBX_GUEST_PATHS.temp,
        ],
      },
      { user: "root" },
    );
    const marker = markerFor(record, sandbox);
    await this.client.exec(
      sandbox.name,
      {
        executable: "/usr/bin/python3",
        args: [
          "-c",
          "import json,os,pathlib; p=pathlib.Path(os.environ['P']); p.write_text(json.dumps(json.loads(os.environ['V']),separators=(',',':'))); os.chmod(p,0o600); os.chown(p,1000,1000)",
        ],
        environment: {
          P: `${SBX_GUEST_PATHS.state}/environment-ownership.json`,
          V: JSON.stringify(marker),
        },
      },
      { user: "root" },
    );
    return this.verify(record, sandbox);
  }

  async verify(
    record: DurableEnvironmentRecord,
    sandbox: SbxSandboxSummary,
  ): Promise<SbxVerifiedEnvironment> {
    const result = await this.client.exec(sandbox.name, {
      executable: "/usr/bin/node",
      args: [
        "-e",
        "const fs=require('node:fs'),c=require('node:crypto'); const p=JSON.parse(fs.readFileSync(process.env.P,'utf8')); const a=process.arch==='arm64'?'arm64':process.arch==='x64'?'x64':''; if(!a)process.exit(41); const runtime='/opt/qe/pi/node_modules/@anthropic-ai/claude-agent-sdk-linux-'+a+'/claude'; const mounts=fs.readFileSync('/proc/self/mountinfo','utf8'); console.log(JSON.stringify({sdk:p.version,code:p.claudeCodeVersion,arch:a,runtime,sha256:c.createHash('sha256').update(fs.readFileSync(runtime)).digest('hex'),wrapperExecutable:(fs.statSync(process.env.W).mode&0o111)!==0,wrapperSha256:c.createHash('sha256').update(fs.readFileSync(process.env.W)).digest('hex'),credentialsPresent:fs.existsSync(process.env.C),hostUsersVisible:mounts.includes('/Users/'),sshAgentVisible:Boolean(process.env.SSH_AUTH_SOCK&&fs.existsSync(process.env.SSH_AUTH_SOCK))}));",
      ],
      environment: {
        P: SBX_CLAUDE_SDK_PACKAGE_JSON,
        W: SBX_CLAUDE_WRAPPER,
        C: `${SBX_GUEST_PATHS.state}/claude-proof/config/.credentials.json`,
      },
      timeoutMs: 60_000,
    });
    if (result.exitCode !== 0)
      throw new Error("Claude artifact provenance probe failed.");
    const provenance = JSON.parse(result.stdout) as Record<string, unknown>;
    const expected =
      provenance.arch === "arm64"
        ? SBX_CLAUDE_LINUX_ARM64_SHA256
        : provenance.arch === "x64"
          ? SBX_CLAUDE_LINUX_X64_SHA256
          : null;
    if (
      provenance.sdk !== SBX_CLAUDE_AGENT_SDK_VERSION ||
      provenance.code !== SBX_CLAUDE_CODE_VERSION ||
      provenance.sha256 !== expected ||
      provenance.wrapperExecutable !== true ||
      provenance.wrapperSha256 !== SBX_CLAUDE_WRAPPER_SHA256 ||
      provenance.credentialsPresent !== false ||
      provenance.hostUsersVisible !== false ||
      provenance.sshAgentVisible !== false
    )
      throw new Error("Claude zero-inference artifact/security proof failed.");
    this.provenance = provenance;
    const marker = markerFor(record, sandbox);
    return {
      markerDigest: createHash("sha256")
        .update(JSON.stringify(marker))
        .digest("hex"),
      dockerDaemonId: "zero-inference-validation",
      capabilities: capabilities(),
      diagnostics: [],
    };
  }
}

function markerFor(
  record: DurableEnvironmentRecord,
  sandbox: SbxSandboxSummary,
) {
  return {
    schemaVersion: 1,
    backendKind: "sbx",
    workerId: record.workerId,
    runId: record.runId,
    environmentId: sandbox.id,
    displayName: sandbox.name,
    incarnation: record.incarnation,
    profileId: record.profileId,
    profileDigest: record.profileDigest,
    specDigest: record.specDigest,
  };
}

function capabilities(): EnvironmentCapability[] {
  return [
    { kind: "filesystem_namespace", mode: "isolated" },
    { kind: "home", mode: "private" },
    { kind: "host_filesystem", mode: "unexposed" },
    { kind: "container_runtime", mode: "isolated" },
    { kind: "environment_exec", mode: "available" },
    { kind: "environment_persistence", mode: "verified" },
    { kind: "harness_runtime", mode: "claude_agent_sdk_headless_v1" },
    { kind: "process.streamed", mode: "attached_only" },
  ];
}

function authStatusCommand(
  runtime: string,
  workspace: string,
  environment: Record<string, string>,
) {
  return {
    executable: "/usr/bin/env",
    args: [
      "-i",
      ...Object.entries(environment)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([name, value]) => `${name}=${value}`),
      runtime,
      "auth",
      "status",
    ],
    cwd: workspace,
    environment: {},
    timeoutMs: 30_000,
  };
}

function claudeProofSpec(
  runId: string,
  workerId = "worker-claude-zero-inference",
): EnvironmentSpec {
  return {
    workerId,
    runId,
    workspace: {
      workspaceId: runId,
      access: "none",
      materialization: {
        kind: "disposable_fixture",
        sourceIdentity: "claude-zero-inference-proof",
        frozenBase: { kind: "git_commit", value: "none" },
      },
    },
    profile: SBX_CODING_EXECUTION_PROFILE_V3,
    resourcePolicy: SBX_DISPOSABLE_RESOURCE_POLICY.identity,
    // These are non-secret descriptors required by the composed profile. The
    // validation backend uses an explicit no-op credential provisioner, so no
    // host auth state is read or installed.
    networkRequirements: [
      {
        capability: "model_provider",
        targets: SBX_MIXED_RUNTIME_NETWORK_TARGETS,
      },
    ],
    credentialGrants: [
      {
        grantId: "zero-inference-openai-descriptor",
        kind: "openai-codex-oauth",
        scope: "subscription",
      },
      {
        grantId: "zero-inference-antigravity-descriptor",
        kind: "antigravity-oauth",
        scope: "subscription",
      },
    ],
    controlChannels: [{ kind: "worker_file_mailbox_v1", required: true }],
    requiredCapabilities: [
      { kind: "filesystem_namespace", mode: "isolated" },
      { kind: "host_filesystem", mode: "unexposed" },
      { kind: "environment_exec", mode: "available" },
      { kind: "harness_runtime", mode: "claude_agent_sdk_headless_v1" },
      { kind: "process.streamed", mode: "attached_only" },
    ],
  };
}

async function* ndjson(stream: AsyncIterable<StreamedProcessStreamEvent>) {
  const decoder = new TextDecoder();
  let buffered = "";
  for await (const event of stream) {
    if (event.kind !== "data") continue;
    buffered += decoder.decode(event.data, { stream: true });
    for (;;) {
      const index = buffered.indexOf("\n");
      if (index < 0) break;
      const line = buffered.slice(0, index);
      buffered = buffered.slice(index + 1);
      if (line) yield JSON.parse(line) as Record<string, unknown>;
    }
  }
}
