import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { basename, join, posix } from "node:path";
import { resolveHostPiOpenAiCredential } from "../src/execution-environment/pi-host-credential.ts";
import {
  SbxExecutionEnvironmentBackend,
  sbxEnvironmentName,
} from "../src/execution-environment/sbx-backend.ts";
import {
  CliSbxClient,
  type SbxPolicyRule,
} from "../src/execution-environment/sbx-client.ts";
import {
  createSbxPiProxyPlaceholder,
  SBX_PI_PROXY_EXPIRY,
  SBX_PI_PROXY_REFRESH_SENTINEL,
} from "../src/execution-environment/sbx-pi-credential.ts";
import {
  SBX_DISPOSABLE_RESOURCE_POLICY,
  SBX_PI_DISCOVERY_SCRIPT,
  SBX_PI_EXECUTABLE,
  SBX_PI_EXECUTION_PROFILE_V2,
  SBX_PI_PROFILE,
  SBX_PI_RESOURCE_PROBE,
  SBX_PI_RUNTIME_NETWORK_TARGETS,
} from "../src/execution-environment/sbx-profile.ts";
import { applyConfiguredPiModelScope } from "../src/execution-environment/sbx-run.ts";
import type {
  EnvironmentLease,
  EnvironmentSpec,
} from "../src/execution-environment/types.ts";
import { AccountAvailabilityEvidenceStore } from "../src/harnesses/account-availability.ts";

const enabled = process.env.QE_RUN_SBX_PI_LIVE === "1";
const sbxBin = process.env.QE_SBX_BIN ?? "/opt/homebrew/bin/sbx";

test.skipIf(!enabled)(
  "live repository-owned Pi profile proves host OAuth discovery without inference",
  async () => {
    const parent = join(process.cwd(), ".pi", "tmp");
    await mkdir(parent, { recursive: true });
    const dataRoot = await mkdtemp(join(parent, "sbx-pi-live-"));
    const runId = `pi-live-${randomUUID()}`;
    const workerId = `pi-live-worker-${randomUUID()}`;
    const client = new CliSbxClient(sbxBin);
    const initialGlobalPolicy = globalPolicySnapshot(await client.policies());
    const initialSecretInventory = await secretInventorySnapshot();
    expect(
      initialGlobalPolicy.some((rule) => rule.resourceType === "network"),
    ).toBe(false);
    const forceRefresh = process.env.QE_FORCE_SBX_PI_OAUTH_REFRESH === "1";
    const refreshedHostCredential = await resolveHostPiOpenAiCredential({
      forceRefresh,
    });
    if (forceRefresh)
      expect(refreshedHostCredential.persistedRotation).toBe(true);
    const backend = new SbxExecutionEnvironmentBackend({
      workerId,
      dataRoot,
      client,
      executionProfile: SBX_PI_PROFILE,
    });
    const spec: EnvironmentSpec = {
      workerId,
      runId,
      workspace: {
        workspaceId: `workspace-${runId}`,
        access: "none",
        materialization: {
          kind: "disposable_fixture",
          sourceIdentity: "qe-pi-live-no-inference",
          frozenBase: { kind: "fixture", value: "none" },
        },
      },
      profile: SBX_PI_EXECUTION_PROFILE_V2,
      resourcePolicy: SBX_DISPOSABLE_RESOURCE_POLICY.identity,
      networkRequirements: [
        {
          capability: "model_provider",
          targets: SBX_PI_RUNTIME_NETWORK_TARGETS,
        },
      ],
      credentialGrants: [
        {
          grantId: "host-openai-oauth",
          kind: "openai-codex-oauth",
          scope: "subscription",
        },
      ],
      controlChannels: [{ kind: "worker_file_mailbox_v1", required: true }],
      requiredCapabilities: [
        { kind: "credentials", mode: "host_pi_oauth_dynamic_proxy" },
        { kind: "network_policy", mode: "openai_subscription_only" },
        { kind: "harness_runtime", mode: "pi_native_extensions" },
        { kind: "control_channel", mode: "worker_file_mailbox_v1" },
      ],
    };
    let ref: Awaited<ReturnType<typeof backend.ensure>>["ref"] | null = null;
    let scopeProbeSandbox: string | null = null;
    try {
      let lease = await backend.ensure(spec);
      ref = lease.ref;
      const environmentName = sbxEnvironmentName(workerId, runId);
      const placeholder = createSbxPiProxyPlaceholder(
        refreshedHostCredential.accountId,
        environmentName,
      );
      expect(
        await directoryContains(dataRoot, refreshedHostCredential.accessToken),
      ).toBe(false);
      expect(
        await secretInventoryContains(refreshedHostCredential.accessToken),
      ).toBe(false);
      const guestEnvironment = await lease.exec({
        executable: "/usr/bin/env",
        args: [],
      });
      expect(guestEnvironment.stdout).not.toContain(
        refreshedHostCredential.accessToken,
      );
      const guestAuth = new TextDecoder().decode(
        await lease.readFile({
          path: "/home/agent/.pi/agent/auth.json",
          maxBytes: 64 * 1024,
        }),
      );
      expect(guestAuth).not.toContain(refreshedHostCredential.accessToken);
      expect(guestAuth).toContain(placeholder);
      expect(
        new TextDecoder()
          .decode(
            await lease.readFile({
              path: "/home/agent/.pi/agent/qe-auth-generation",
              maxBytes: 128,
            }),
          )
          .trim(),
      ).toBe(refreshedHostCredential.authGeneration);
      expect(globalPolicySnapshot(await client.policies())).toEqual(
        initialGlobalPolicy,
      );
      const packageRegistry = await lease.exec({
        executable: "/usr/bin/curl",
        args: [
          "--fail",
          "--silent",
          "--show-error",
          "--max-time",
          "10",
          "https://registry.npmjs.org/",
        ],
        timeoutMs: 30_000,
      });
      expect(packageRegistry.exitCode).not.toBe(0);
      const resource = await lease.exec({
        executable: "/usr/bin/node",
        args: [SBX_PI_RESOURCE_PROBE],
        cwd: lease.paths.workspace,
        timeoutMs: 60_000,
      });
      expect(resource.exitCode, `${resource.stdout}\n${resource.stderr}`).toBe(
        0,
      );
      expect(JSON.parse(resource.stdout)).toEqual({
        schemaVersion: 3,
        authenticated: true,
        status: 200,
        metadataAuthority: "advisory",
        metadataConclusive: false,
        modelCount: expect.any(Number),
      });

      const discovery = await lease.exec({
        executable: "/usr/bin/node",
        args: [SBX_PI_DISCOVERY_SCRIPT],
        cwd: lease.paths.workspace,
        timeoutMs: 60_000,
      });
      expect(
        discovery.exitCode,
        `${discovery.stdout}\n${discovery.stderr}`,
      ).toBe(0);
      const value = JSON.parse(discovery.stdout) as {
        schemaVersion: number;
        authenticated: boolean;
        accountScope: string;
        authGeneration: string;
        metadata: {
          authority: "advisory";
          conclusive: false;
          status: number | null;
          observedAt: string;
          modelCount: number | null;
        };
        diagnostics: string[];
        models: Array<{
          provider: string;
          model: string;
          displayName: string;
          reasoning: string[];
          accountAvailability: "unknown";
        }>;
      };
      expect(value.schemaVersion).toBe(3);
      expect(value.authenticated, JSON.stringify(value)).toBe(true);
      expect(value.accountScope).toMatch(/^[a-f0-9]{64}$/);
      expect(value.authGeneration).toMatch(/^[a-f0-9]{64}$/);
      expect(value.metadata).toMatchObject({
        authority: "advisory",
        conclusive: false,
      });
      expect(value.models).toHaveLength(8);
      expect(value.models.some((model) => model.model === "gpt-6-astra")).toBe(
        true,
      );
      expect(
        value.models.every(
          (model) =>
            model.provider === "openai-codex" &&
            model.accountAvailability === "unknown",
        ),
      ).toBe(true);
      const availability = new AccountAvailabilityEvidenceStore(
        join(dataRoot, "pi-account-availability.json"),
      );
      const seedPaths = (process.env.QE_PI_ACCOUNT_EVIDENCE_SEEDS ?? "")
        .split(",")
        .map((path) => path.trim())
        .filter(Boolean);
      for (const path of seedPaths) await availability.importFile(path);
      const annotatedModels = await availability.annotate(
        value.models.map((model) => ({
          provider: model.provider,
          model: model.model,
          displayName: model.displayName,
          accountAvailability: "unknown" as const,
          reasoningCapability:
            model.reasoning.length > 0
              ? { kind: "enumerated" as const, values: model.reasoning }
              : { kind: "unsupported" as const },
        })),
        {
          accountScope: value.accountScope,
          authGeneration: value.authGeneration,
          profileId: SBX_PI_EXECUTION_PROFILE_V2.id,
          profileDigest: SBX_PI_EXECUTION_PROFILE_V2.digest,
        },
      );
      const workerCatalog = applyConfiguredPiModelScope(
        {
          authenticated: value.authenticated,
          diagnostics: value.diagnostics,
          accountScope: value.accountScope,
          authGeneration: value.authGeneration,
          metadata: value.metadata,
          models: annotatedModels,
        },
        undefined,
      );
      expect(workerCatalog.authenticated).toBe(true);
      expect(workerCatalog.models).toHaveLength(value.models.length);
      expect(workerCatalog.models.map((model) => model.model)).toEqual(
        value.models.map((model) => model.model),
      );
      if (seedPaths.length > 0) {
        expect(
          workerCatalog.models.find(
            (model) => model.model === "gpt-5.3-codex-spark",
          )?.accountAvailability,
        ).toBe("verified_unavailable");
        expect(
          workerCatalog.models.find((model) => model.model === "gpt-5.6-sol")
            ?.accountAvailability,
        ).toBe("verified_available");
        expect(
          workerCatalog.models
            .filter(
              (model) =>
                model.model !== "gpt-5.3-codex-spark" &&
                model.model !== "gpt-5.6-sol",
            )
            .every((model) => model.accountAvailability === "unknown"),
        ).toBe(true);
      }
      expect(workerCatalog.models).toEqual(
        expect.arrayContaining(
          workerCatalog.models.filter(
            (model) => model.reasoningCapability.kind !== "unknown",
          ),
        ),
      );
      const runtime = await lease.exec({
        executable: "/usr/bin/node",
        args: [
          "-e",
          "const fs=require('fs');const p='/opt/qe/pi/node_modules/@earendil-works/pi-coding-agent/package.json';process.stdout.write(JSON.parse(fs.readFileSync(p,'utf8')).version)",
        ],
      });
      expect(runtime.exitCode).toBe(0);
      console.log(
        JSON.stringify({
          event: "sbx_pi_dynamic_discovery_no_inference",
          models: workerCatalog.models.map((model) => ({
            provider: model.provider,
            model: model.model,
            accountAvailability: model.accountAvailability,
            reasoningCapability: model.reasoningCapability,
          })),
          piVersion: runtime.stdout.trim(),
          profile: SBX_PI_EXECUTION_PROFILE_V2,
          configuredModelScope: "omitted",
          prompts: 0,
          providerCycles: 0,
        }),
      );

      await proveMailboxRoundTrip(lease);
      const firstModel = workerCatalog.models.find(
        (model) => model.accountAvailability !== "verified_unavailable",
      );
      if (firstModel)
        await provePiTuiReadinessWithoutInference(
          lease,
          `${firstModel.provider}/${firstModel.model}`,
        );

      scopeProbeSandbox = `qe-pi-scope-${randomUUID().slice(0, 12)}`;
      await client.create({
        name: scopeProbeSandbox,
        agentReference: SBX_PI_PROFILE.agentReference,
        denyAllNetwork: false,
        cpus: 1,
        memory: "1g",
        privateDockerDisk: "1g",
        environment: {},
      });
      await client.denyNetwork(scopeProbeSandbox, ["registry.npmjs.org"]);
      await seedProxyCredential(
        client,
        scopeProbeSandbox,
        placeholder,
        refreshedHostCredential.accountId,
      );
      const crossSandbox = await client.exec(
        scopeProbeSandbox,
        {
          executable: "/usr/bin/node",
          args: [SBX_PI_RESOURCE_PROBE],
          timeoutMs: 60_000,
        },
        { allowNonZero: true },
      );
      expect(crossSandbox.exitCode).not.toBe(0);
      await client.remove(scopeProbeSandbox);
      scopeProbeSandbox = null;

      await backend.stop(ref);
      lease = await backend.recover(ref, spec);
      const afterRestart = await lease.exec({
        executable: "/usr/bin/node",
        args: [SBX_PI_RESOURCE_PROBE],
        timeoutMs: 60_000,
      });
      expect(afterRestart.exitCode).toBe(0);

      await client.removeDynamicSecret(environmentName, placeholder);
      const afterRevocation = await lease.exec({
        executable: "/usr/bin/node",
        args: [SBX_PI_RESOURCE_PROBE],
        timeoutMs: 60_000,
      });
      expect(afterRevocation.exitCode).toBe(0);
      expect(JSON.parse(afterRevocation.stdout)).toMatchObject({
        schemaVersion: 3,
        metadataAuthority: "advisory",
        metadataConclusive: false,
        status: 401,
      });
    } finally {
      if (scopeProbeSandbox)
        await client.remove(scopeProbeSandbox).catch(() => undefined);
      if (ref) await backend.remove(ref);
      backend.close();
      expect(globalPolicySnapshot(await client.policies())).toEqual(
        initialGlobalPolicy,
      );
      expect(await secretInventorySnapshot()).toEqual(initialSecretInventory);
      await rm(dataRoot, { recursive: true, force: true });
    }
  },
  15 * 60_000,
);

function globalPolicySnapshot(rules: readonly SbxPolicyRule[]) {
  return rules
    .filter((rule) => rule.scope === "global")
    .map((rule) => ({
      id: rule.id,
      policyId: rule.policyId,
      scope: rule.scope,
      appliesTo: rule.appliesTo,
      resourceType: rule.resourceType,
      decision: rule.decision,
      resources: [...rule.resources].sort(),
      status: rule.status,
    }))
    .sort((left, right) => left.id.localeCompare(right.id));
}

async function directoryContains(
  root: string,
  sensitiveValue: string,
): Promise<boolean> {
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      if (await directoryContains(path, sensitiveValue)) return true;
    } else if (
      entry.isFile() &&
      (await readFile(path)).includes(Buffer.from(sensitiveValue, "utf8"))
    ) {
      return true;
    }
  }
  return false;
}

async function secretInventorySnapshot(): Promise<unknown> {
  const child = Bun.spawn([sbxBin, "secret", "ls", "--json"], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    child.exited,
  ]);
  if (exitCode !== 0) throw new Error("Could not inspect SBX secret metadata");
  return JSON.parse(stdout);
}

async function secretInventoryContains(
  sensitiveValue: string,
): Promise<boolean> {
  return JSON.stringify(await secretInventorySnapshot()).includes(
    sensitiveValue,
  );
}

async function seedProxyCredential(
  client: CliSbxClient,
  sandboxName: string,
  placeholder: string,
  accountId: string,
): Promise<void> {
  await client.exec(
    sandboxName,
    {
      executable: "/usr/bin/node",
      args: [
        "-e",
        'const{mkdirSync,writeFileSync}=require("node:fs");const path="/home/agent/.pi/agent/auth.json";mkdirSync("/home/agent/.pi/agent",{recursive:true,mode:0o700});writeFileSync(path,JSON.stringify({"openai-codex":{type:"oauth",access:process.env.QE_ACCESS,refresh:process.env.QE_REFRESH,expires:Number(process.env.QE_EXPIRY),accountId:process.env.QE_ACCOUNT}})+"\\n",{mode:0o600});',
      ],
      environment: {
        QE_ACCESS: placeholder,
        QE_ACCOUNT: accountId,
        QE_EXPIRY: String(SBX_PI_PROXY_EXPIRY),
        QE_REFRESH: SBX_PI_PROXY_REFRESH_SENTINEL,
      },
    },
    { user: "agent" },
  );
}

async function proveMailboxRoundTrip(lease: EnvironmentLease): Promise<void> {
  const mailbox = posix.join(lease.paths.control, "live-mailbox");
  const name = `${"a".repeat(64)}.json`;
  const requestPath = posix.join(mailbox, "requests", name);
  const responsePath = posix.join(mailbox, "responses", name);
  const request = {
    protocolVersion: 1,
    bridgeGeneration: "live-no-inference",
    contextToken: "sentinel-only",
    requestId: "live-mailbox-round-trip",
    operation: { type: "completion_status" },
  };
  const guest = lease.exec({
    executable: "/usr/bin/node",
    args: [
      "--input-type=module",
      "-e",
      "import{mkdir,readFile,rename,writeFile}from'node:fs/promises';import{dirname}from'node:path';const request=JSON.parse(process.env.QE_REQUEST);await mkdir(dirname(process.env.QE_REQUEST_PATH),{recursive:true});await mkdir(dirname(process.env.QE_RESPONSE_PATH),{recursive:true});const temporary=process.env.QE_REQUEST_PATH+'.tmp';await writeFile(temporary,JSON.stringify(request)+'\\n',{mode:0o600});await rename(temporary,process.env.QE_REQUEST_PATH);const deadline=Date.now()+90000;while(Date.now()<deadline){try{const response=JSON.parse(await readFile(process.env.QE_RESPONSE_PATH,'utf8'));process.stdout.write(JSON.stringify(response)+'\\n');process.exit(0)}catch(error){if(error?.code!=='ENOENT')throw error}await new Promise(resolve=>setTimeout(resolve,50))}throw new Error('mailbox timeout')",
    ],
    environment: {
      QE_REQUEST: JSON.stringify(request),
      QE_REQUEST_PATH: requestPath,
      QE_RESPONSE_PATH: responsePath,
    },
    timeoutMs: 120_000,
  });
  let observed: Uint8Array | null = null;
  for (let attempt = 0; attempt < 100 && !observed; attempt += 1) {
    observed = await lease
      .readFile({ path: requestPath, maxBytes: 64 * 1024 })
      .catch(() => null);
    if (!observed) await Bun.sleep(50);
  }
  expect(observed).not.toBeNull();
  expect(JSON.parse(new TextDecoder().decode(observed as Uint8Array))).toEqual(
    request,
  );
  await lease.writeFile({
    path: responsePath,
    data: new TextEncoder().encode(
      `${JSON.stringify({ ok: true, result: { accepted: true, completed: false } })}\n`,
    ),
    mode: 0o600,
  });
  const guestResult = await guest;
  expect(
    guestResult.exitCode,
    `${guestResult.stdout}\n${guestResult.stderr}`,
  ).toBe(0);
  expect(JSON.parse(guestResult.stdout)).toEqual({
    ok: true,
    result: { accepted: true, completed: false },
  });
}

async function provePiTuiReadinessWithoutInference(
  lease: EnvironmentLease,
  model: string,
): Promise<void> {
  expect(model.startsWith("openai-codex/")).toBe(true);
  const entries = [
    "step-result-extension.ts",
    "workspace-permission-extension.ts",
    "human-assistance-extension.ts",
    "sbx-herdr-state-extension.ts",
  ].map((name) => join(import.meta.dir, "../src/harnesses/pi", name));
  const built = await Bun.build({
    entrypoints: entries,
    target: "node",
    format: "esm",
    splitting: false,
    naming: "[name].mjs",
  });
  expect(built.success).toBe(true);
  const extensionRoot = posix.join(lease.paths.state, "live-pi-extensions");
  await lease.workerExec({
    executable: "/usr/bin/install",
    args: ["-d", "-m", "0700", "-o", "1000", "-g", "1000", extensionRoot],
  });
  const extensionPaths: string[] = [];
  for (const output of built.outputs) {
    const path = posix.join(extensionRoot, basename(output.path));
    await lease.writeFile({
      path,
      data: new Uint8Array(await output.arrayBuffer()),
      mode: 0o500,
    });
    extensionPaths.push(path);
  }
  extensionPaths.sort();
  const marker = posix.join(lease.paths.state, "live-pi-tui-ready.json");
  const probe = posix.join(extensionRoot, "live-tui-probe.mjs");
  await lease.writeFile({
    path: probe,
    data: new TextEncoder().encode(
      "import{writeFileSync}from'node:fs';export default function(){writeFileSync(process.env.QE_TUI_READY,JSON.stringify({extensionLoaded:true})+'\\n',{mode:0o600})}\n",
    ),
    mode: 0o500,
  });
  extensionPaths.push(probe);
  const controlRoot = posix.join(lease.paths.control, "live-pi-tui");
  const launch = await lease.launcher({
    executable: SBX_PI_EXECUTABLE,
    args: [
      "--model",
      model,
      "--no-extensions",
      ...extensionPaths.flatMap((path) => ["--extension", path]),
      "--no-skills",
      "--no-prompt-templates",
      "--no-context-files",
      "--tools",
      "qe_step_result,qe_request_human_assistance",
      "--name",
      "qe-live-no-inference",
    ],
    cwd: lease.paths.workspace,
    environment: {
      QE_HARNESS_CONTROL_PATH: posix.join(controlRoot, "harness-control.json"),
      QE_SBX_CONTROL_MAILBOX: posix.join(controlRoot, "mailbox"),
      QE_RESULT_CONTROL_PATH: posix.join(controlRoot, "result-control.json"),
      QE_ATTENTION_CONTROL_PATH: posix.join(
        controlRoot,
        "attention-control.json",
      ),
      QE_RECOVERY_CONTROL_PATH: posix.join(
        controlRoot,
        "recovery-control.json",
      ),
      QE_SBX_RUNTIME_STATE_PATH: posix.join(controlRoot, "runtime-state.json"),
      QE_WORKSPACE_ACCESS: "none",
      QE_WORKSPACE_ROOT: lease.paths.workspace,
      QE_ALLOWED_PI_TOOLS: "qe_step_result,qe_request_human_assistance",
      QE_ARTIFACT_ROOT: posix.join(lease.paths.state, "execution-artifacts"),
      QE_TUI_READY: marker,
    },
  });
  const child = Bun.spawn(
    [
      "/usr/bin/python3",
      "-c",
      "import os,pty,sys; status=pty.spawn(sys.argv[1:]); raise SystemExit(os.waitstatus_to_exitcode(status))",
      launch.executable,
      ...launch.args,
    ],
    {
      cwd: launch.cwd,
      env: { ...process.env, ...launch.environment },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const stdoutPromise = new Response(child.stdout).text();
  const stderrPromise = new Response(child.stderr).text();
  let markerData: Uint8Array | null = null;
  for (let attempt = 0; attempt < 20 && !markerData; attempt += 1) {
    markerData = await lease
      .readFile({ path: marker, maxBytes: 64 * 1024 })
      .catch(() => null);
    if (!markerData) await Bun.sleep(500);
  }
  expect(markerData).not.toBeNull();
  child.kill("SIGTERM");
  const force = setTimeout(() => child.kill("SIGKILL"), 10_000);
  const [stdout, stderr, exitCode] = await Promise.all([
    stdoutPromise,
    stderrPromise,
    child.exited,
  ]).finally(() => clearTimeout(force));
  expect(exitCode, `${stdout}\n${stderr}`).not.toBe(137);
  expect(stdout.includes("\u001b[")).toBe(true);
  expect(
    JSON.parse(new TextDecoder().decode(markerData as Uint8Array)),
  ).toEqual({ extensionLoaded: true });
}
