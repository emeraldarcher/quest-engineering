import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp } from "node:fs/promises";
import { basename, join, posix } from "node:path";
import { SbxExecutionEnvironmentBackend } from "../src/execution-environment/sbx-backend.ts";
import {
  SBX_DISPOSABLE_RESOURCE_POLICY,
  SBX_PI_DISCOVERY_SCRIPT,
  SBX_PI_EXECUTABLE,
  SBX_PI_EXECUTION_PROFILE_V1,
  SBX_PI_OAUTH_PROBE,
  SBX_PI_PROFILE,
  SBX_PI_RUNTIME_NETWORK_TARGETS,
} from "../src/execution-environment/sbx-profile.ts";
import type {
  EnvironmentLease,
  EnvironmentSpec,
} from "../src/execution-environment/types.ts";

const enabled = process.env.QE_RUN_SBX_PI_LIVE === "1";

test.skipIf(!enabled)(
  "live repository-owned Pi profile proves host OAuth discovery without inference",
  async () => {
    const parent = join(process.cwd(), ".pi", "tmp");
    await mkdir(parent, { recursive: true });
    const dataRoot = await mkdtemp(join(parent, "sbx-pi-live-"));
    const runId = `pi-live-${randomUUID()}`;
    const workerId = `pi-live-worker-${randomUUID()}`;
    const backend = new SbxExecutionEnvironmentBackend({
      workerId,
      dataRoot,
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
      profile: SBX_PI_EXECUTION_PROFILE_V1,
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
        { kind: "credentials", mode: "host_proxy_openai_oauth" },
        { kind: "network_policy", mode: "openai_subscription_only" },
        { kind: "harness_runtime", mode: "pi_native_extensions" },
        { kind: "control_channel", mode: "worker_file_mailbox_v1" },
      ],
    };
    let ref: Awaited<ReturnType<typeof backend.ensure>>["ref"] | null = null;
    try {
      const lease = await backend.ensure(spec);
      ref = lease.ref;
      const oauth = await lease.exec({
        executable: "/usr/bin/node",
        args: [SBX_PI_OAUTH_PROBE],
        cwd: lease.paths.workspace,
        timeoutMs: 60_000,
      });
      expect(oauth.exitCode).toBe(0);
      expect(JSON.parse(oauth.stdout)).toEqual({
        schemaVersion: 1,
        provider: "OpenAI (ChatGPT Plus/Pro)",
        subscription: true,
        credentialFileSentinelOnly: true,
        credentialFileExpiryValid: true,
        refreshSentinelOnly: true,
        accountSentinelValid: true,
        expiryValid: true,
      });

      const discovery = await lease.exec({
        executable: "/usr/bin/node",
        args: [SBX_PI_DISCOVERY_SCRIPT],
        cwd: lease.paths.workspace,
        timeoutMs: 60_000,
      });
      expect(discovery.exitCode).toBe(0);
      const value = JSON.parse(discovery.stdout) as {
        authenticated: boolean;
        models: Array<{ provider: string; model: string }>;
      };
      expect(value.authenticated).toBe(true);
      expect(value.models.length).toBeGreaterThan(0);
      expect(
        value.models.every((model) => model.provider === "openai-codex"),
      ).toBe(true);

      await proveMailboxRoundTrip(lease);
      await provePiTuiReadinessWithoutInference(
        lease,
        `${value.models[0]?.provider}/${value.models[0]?.model}`,
      );
    } finally {
      if (ref) await backend.remove(ref);
      backend.close();
    }
  },
  180_000,
);

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
      "import{mkdir,readFile,rename,writeFile}from'node:fs/promises';import{dirname}from'node:path';const request=JSON.parse(process.env.QE_REQUEST);await mkdir(dirname(process.env.QE_REQUEST_PATH),{recursive:true});await mkdir(dirname(process.env.QE_RESPONSE_PATH),{recursive:true});const temporary=process.env.QE_REQUEST_PATH+'.tmp';await writeFile(temporary,JSON.stringify(request)+'\\n',{mode:0o600});await rename(temporary,process.env.QE_REQUEST_PATH);const deadline=Date.now()+15000;while(Date.now()<deadline){try{const response=JSON.parse(await readFile(process.env.QE_RESPONSE_PATH,'utf8'));process.stdout.write(JSON.stringify(response)+'\\n');process.exit(0)}catch(error){if(error?.code!=='ENOENT')throw error}await new Promise(resolve=>setTimeout(resolve,50))}throw new Error('mailbox timeout')",
    ],
    environment: {
      QE_REQUEST: JSON.stringify(request),
      QE_REQUEST_PATH: requestPath,
      QE_RESPONSE_PATH: responsePath,
    },
    timeoutMs: 20_000,
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
  expect(JSON.parse((await guest).stdout)).toEqual({
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
      "import{writeFile}from'node:fs/promises';export default function(pi){pi.on('session_start',async(_event,ctx)=>{if(ctx?.mode!=='tui')throw new Error('Pi did not enter TUI mode');await writeFile(process.env.QE_TUI_READY,JSON.stringify({ready:true,mode:ctx.mode})+'\\n',{mode:0o600});setTimeout(()=>process.exit(0),100)})}\n",
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
  const timeout = setTimeout(() => child.kill("SIGKILL"), 30_000);
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]).finally(() => clearTimeout(timeout));
  expect(exitCode, `${stdout}\n${stderr}`).toBe(0);
  expect(
    JSON.parse(
      new TextDecoder().decode(
        await lease.readFile({ path: marker, maxBytes: 64 * 1024 }),
      ),
    ),
  ).toEqual({ ready: true, mode: "tui" });
}
