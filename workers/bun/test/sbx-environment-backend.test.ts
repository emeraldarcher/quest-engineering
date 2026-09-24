import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import {
  SbxExecutionEnvironmentBackend,
  sbxEnvironmentName,
} from "../src/execution-environment/sbx-backend.ts";
import {
  SBX_EXECUTION_PROFILE_V1,
  SBX_PI_EXECUTION_PROFILE_V2,
  SBX_PI_PROFILE,
  SBX_PI_RUNTIME_NETWORK_TARGETS,
  SBX_TESTED_REVISION,
  SBX_TESTED_VERSION,
} from "../src/execution-environment/sbx-profile.ts";
import { ExecutionEnvironmentStore } from "../src/execution-environment/store.ts";
import { environmentSpecDigest } from "../src/execution-environment/tracked-backend.ts";
import { EnvironmentBackendError } from "../src/execution-environment/types.ts";
import { executionEnvironmentConformance } from "./execution-environment-conformance.ts";
import {
  FakeSbxClient,
  FakeSbxVerifier,
  fakeSbxState,
  sbxCommand,
  sbxSpec,
} from "./sbx-support.ts";

const roots: string[] = [];
const backends: SbxExecutionEnvironmentBackend[] = [];
afterEach(async () => {
  for (const backend of backends.splice(0)) backend.close();
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

executionEnvironmentConformance("Sbx", async () => {
  const fixture = await setup();
  return {
    backend: fixture.backend,
    primarySpec: sbxSpec("run-primary"),
    secondarySpec: sbxSpec("run-secondary"),
    command: sbxCommand,
    expectedResult: (label: string) => ({
      exitCode: 0,
      stdout: `${label}\n`,
      stderr: "",
    }),
    containerRuntimeMode: null,
    recoverStartsStopped: true,
    pathsAreNamespaceLocal: true,
    specMismatchCode: "environment_spec_mismatch",
    assertLauncher: (descriptor, lease) => {
      expect(descriptor.executable).toBe(process.execPath);
      expect(descriptor.cwd).toBe(fixture.root);
      expect(descriptor.args).toContain(lease.ref.environmentId);
      expect(descriptor.args).toContain("--command");
      expect(descriptor.environment.HOME).toBeUndefined();
      expect(lease.paneEnvironment.HOME).toBe(lease.paths.home);
    },
  };
});

test("durable Worker restart adopts exact physical environment without duplication", async () => {
  const root = await tempRoot();
  const state = fakeSbxState();
  const first = backend(root, state);
  const spec = sbxSpec("run-restart");
  const original = await first.ensure(spec);
  first.close();
  backends.splice(backends.indexOf(first), 1);

  const restarted = backend(root, state);
  const recovered = await restarted.recover(original.ref, spec);
  expect(recovered.ref).toEqual(original.ref);
  expect(state.createCalls).toBe(1);
  expect(state.sandboxes.size).toBe(1);
  expect((await recovered.exec(sbxCommand("preserved"))).stdout).toBe(
    "preserved\n",
  );
});

test("creation disables ambient credential variables and carries only ownership identity", async () => {
  const fixture = await setup();
  await fixture.backend.ensure(sbxSpec("run-create-environment"));
  const environment = fixture.state.createRequests[0]?.environment;
  expect(environment).toMatchObject({
    HOME: "/home/agent",
    GH_TOKEN: "none",
    GITHUB_TOKEN: "none",
    OPENAI_API_KEY: "none",
    QE_RUN_ID: "run-create-environment",
    QE_WORKER_ID: "worker-sbx-test",
  });
  expect(environment).not.toHaveProperty("QE_WORKER_TOKEN");
});

test("repository-owned Pi kit provisions one sandbox-scoped host resolver before verification", async () => {
  const root = await tempRoot();
  const state = fakeSbxState();
  const provisioned: string[] = [];
  const value = new SbxExecutionEnvironmentBackend({
    workerId: "worker-sbx-test",
    dataRoot: root,
    client: new FakeSbxClient(state),
    verifier: new FakeSbxVerifier(state),
    credentialProvisioner: {
      provision: async (sandboxName) => {
        provisioned.push(sandboxName);
        return { placeholder: "nonsecret-proxy-placeholder" };
      },
    },
    executionProfile: SBX_PI_PROFILE,
  });
  backends.push(value);
  const spec = sbxSpec("run-pi-profile");
  spec.profile = { ...SBX_PI_EXECUTION_PROFILE_V2 };
  spec.networkRequirements = [
    {
      capability: "model_provider",
      targets: [...SBX_PI_RUNTIME_NETWORK_TARGETS],
    },
  ];
  spec.credentialGrants = [
    {
      grantId: "host-openai",
      kind: "openai-codex-oauth",
      scope: "subscription",
    },
  ];
  spec.controlChannels = [{ kind: "worker_file_mailbox_v1", required: true }];
  const lease = await value.ensure(spec);
  const environmentName = sbxEnvironmentName(
    lease.ref.workerId,
    lease.ref.runId,
  );
  expect(state.createRequests[0]).toMatchObject({
    name: environmentName,
    agentReference: SBX_PI_PROFILE.agentReference,
    denyAllNetwork: false,
  });
  expect(provisioned).toEqual([environmentName]);
  expect(
    state.rules.some(
      (rule) =>
        rule.scope === `sandbox:${environmentName}` &&
        rule.decision === "deny" &&
        rule.resources.includes("registry.npmjs.org"),
    ),
  ).toBe(true);
  expect((await lease.launcher(sbxCommand("pi"))).args).toContain(
    SBX_PI_PROFILE.nativeAgent,
  );
});

test("lease transfers verify bytes and reject paths outside the canonical guest map", async () => {
  const fixture = await setup();
  const lease = await fixture.backend.ensure(sbxSpec("run-transfer"));
  const path = `${lease.paths.state}/imports/source.bundle`;
  const data = new TextEncoder().encode("bundle bytes");
  expect(await lease.writeFile({ path, data, mode: 0o600 })).toMatchObject({
    path,
    byteLength: data.byteLength,
  });
  expect(await lease.readFile({ path, maxBytes: 1024 })).toEqual(data);
  await expect(
    lease.writeFile({ path: "/host/escape", data }),
  ).rejects.toMatchObject({ operation: "transfer" });
});

test("creation response loss reconciles the deterministic physical identity", async () => {
  const fixture = await setup();
  fixture.state.loseCreateResponse = true;
  const lease = await fixture.backend.ensure(sbxSpec("run-response-loss"));
  expect(lease.ref.environmentId).toBeTruthy();
  expect(fixture.state.createCalls).toBe(1);
  expect(fixture.state.sandboxes.size).toBe(1);
});

test("failed initialization removes only a sandbox created by that operation", async () => {
  const root = await tempRoot();
  const state = fakeSbxState();
  const value = rejectingBackend(root, state);
  await expect(value.ensure(sbxSpec("run-init-failure"))).rejects.toMatchObject(
    {
      code: "environment_identity_mismatch",
      operation: "ensure",
    },
  );
  expect(state.createCalls).toBe(1);
  expect(state.sandboxes.size).toBe(0);
});

test("failed adoption preserves a pre-existing conflicting sandbox", async () => {
  const root = await tempRoot();
  const state = fakeSbxState();
  const spec = sbxSpec("run-foreign-conflict");
  const name = sbxEnvironmentName(spec.workerId, spec.runId);
  state.sandboxes.set(name, {
    name,
    id: "00000000-0000-4000-8000-000000000888",
    agent: "shell",
    status: "running",
  });
  const value = rejectingBackend(root, state);
  await expect(value.ensure(spec)).rejects.toMatchObject({
    code: "environment_identity_mismatch",
  });
  expect(state.createCalls).toBe(0);
  expect(state.sandboxes.has(name)).toBe(true);
});

test("same-Run concurrent ensure performs one physical create", async () => {
  const fixture = await setup();
  fixture.state.createDelayMs = 20;
  const spec = sbxSpec("run-concurrent");
  const [first, second] = await Promise.all([
    fixture.backend.ensure(spec),
    fixture.backend.ensure(structuredClone(spec)),
  ]);
  expect(first.ref).toEqual(second.ref);
  expect(fixture.state.createCalls).toBe(1);
});

test("separate backend objects converge through durable creation intent", async () => {
  const root = await tempRoot();
  const state = fakeSbxState();
  state.createDelayMs = 30;
  const first = backend(root, state, { processId: 101 });
  const second = backend(root, state, {
    processId: 202,
    isProcessAlive: (pid) => pid === 101,
  });
  const spec = sbxSpec("run-cross-process");
  const firstEnsure = first.ensure(spec);
  await Bun.sleep(5);
  const secondEnsure = second.ensure(spec);
  const [left, right] = await Promise.all([firstEnsure, secondEnsure]);
  expect(left.ref).toEqual(right.ref);
  expect(state.createCalls).toBe(1);
});

test("dead creator reconciliation adopts an exact name and creation identity", async () => {
  const root = await tempRoot();
  const state = fakeSbxState();
  const spec = sbxSpec("run-dead-creator");
  const name = sbxEnvironmentName(spec.workerId, spec.runId);
  const environmentId = "00000000-0000-4000-8000-000000000999";
  const store = new ExecutionEnvironmentStore(root);
  store.claimCreation({
    recordId: "record-dead-creator",
    backendKind: "sbx",
    workerId: spec.workerId,
    runId: spec.runId,
    displayName: name,
    incarnation: "incarnation-dead-creator",
    profileId: spec.profile.id,
    profileDigest: spec.profile.digest,
    specDigest: environmentSpecDigest(spec),
    creationToken: "dead-token",
    creatorPid: 101,
    nativeVersion: SBX_TESTED_VERSION,
    nativeRevision: SBX_TESTED_REVISION,
    nativeApiVersion: "0.31.0",
  });
  store.close();
  state.sandboxes.set(name, {
    name,
    id: environmentId,
    agent: "shell",
    status: "running",
  });

  const recovered = backend(root, state, {
    processId: 202,
    isProcessAlive: () => false,
  });
  const lease = await recovered.ensure(spec);
  expect(lease.ref).toEqual({
    backendKind: "sbx",
    environmentId,
    incarnation: "incarnation-dead-creator",
    workerId: spec.workerId,
    runId: spec.runId,
    profile: SBX_EXECUTION_PROFILE_V1,
  });
  expect(state.createCalls).toBe(0);
});

test("native UUID/name conflicts are incompatible and never remove the foreign sandbox", async () => {
  const fixture = await setup();
  const spec = sbxSpec("run-native-conflict");
  const lease = await fixture.backend.ensure(spec);
  const [name, original] = [...fixture.state.sandboxes.entries()][0] as [
    string,
    { name: string; id: string; agent: string; status: string },
  ];
  fixture.state.sandboxes.set(name, {
    ...original,
    id: "00000000-0000-4000-8000-000000000889",
  });

  expect(await fixture.backend.inspect(lease.ref)).toMatchObject({
    state: "incompatible",
    usable: false,
  });
  await expect(fixture.backend.recover(lease.ref, spec)).rejects.toMatchObject({
    code: "environment_identity_mismatch",
  });
  await expect(fixture.backend.remove(lease.ref)).rejects.toMatchObject({
    code: "environment_identity_mismatch",
  });
  expect(fixture.state.sandboxes.has(name)).toBe(true);
});

test("inspection becomes degraded when backend security readiness regresses", async () => {
  const fixture = await setup();
  const lease = await fixture.backend.ensure(
    sbxSpec("run-readiness-regression"),
  );
  fixture.state.sshForwarding = true;
  expect(await fixture.backend.inspect(lease.ref)).toMatchObject({
    state: "degraded",
    usable: false,
    diagnostics: expect.arrayContaining([
      expect.objectContaining({ code: "ssh_agent_forwarding_enabled" }),
    ]),
  });
});

test("missing durable physical environment fails closed without replacement", async () => {
  const fixture = await setup();
  const spec = sbxSpec("run-missing");
  const lease = await fixture.backend.ensure(spec);
  const [name] = fixture.state.sandboxes.keys();
  fixture.state.sandboxes.delete(name as string);

  await expect(fixture.backend.ensure(spec)).rejects.toMatchObject({
    code: "environment_not_found",
  });
  expect((await fixture.backend.inspect(lease.ref)).state).toBe("missing");
  expect(fixture.state.createCalls).toBe(1);
});

test("newer capability-compatible SBX versions can provision without exact pinning", async () => {
  const fixture = await setup();
  fixture.state.version.clientVersion = "v0.44.0";
  fixture.state.version.clientRevision = "compatible-newer-revision";
  fixture.state.version.serverVersion = "v0.44.0";
  fixture.state.version.serverRevision = "compatible-newer-revision";
  expect(
    (await fixture.backend.ensure(sbxSpec("run-compatible-newer"))).ref
      .environmentId,
  ).toBeTruthy();
});

test("an externally stopped sandbox cannot execute through an old running lease", async () => {
  const fixture = await setup();
  const spec = sbxSpec("run-externally-stopped");
  const lease = await fixture.backend.ensure(spec);
  const sandbox = [...fixture.state.sandboxes.values()][0];
  if (!sandbox) throw new Error("expected fake sandbox");
  sandbox.status = "stopped";
  await expect(lease.exec(sbxCommand("must-not-run"))).rejects.toMatchObject({
    code: "environment_not_usable",
    operation: "exec",
  });
  expect((await fixture.backend.recover(lease.ref, spec)).ref).toEqual(
    lease.ref,
  );
});

test("generic lease exec returns nonzero status without changing semantics", async () => {
  const fixture = await setup();
  const lease = await fixture.backend.ensure(sbxSpec("run-nonzero"));
  expect(
    await lease.exec({
      executable: "/bin/false",
      args: [],
      cwd: lease.paths.workspace,
    }),
  ).toEqual({
    exitCode: 1,
    stdout: "",
    stderr: "synthetic failure\n",
  });
});

async function setup() {
  const root = await tempRoot();
  const state = fakeSbxState();
  return { root, state, backend: backend(root, state) };
}

function backend(
  root: string,
  state: ReturnType<typeof fakeSbxState>,
  overrides: {
    processId?: number;
    isProcessAlive?: (processId: number) => boolean;
  } = {},
): SbxExecutionEnvironmentBackend {
  const client = new FakeSbxClient(state);
  const value = new SbxExecutionEnvironmentBackend({
    workerId: "worker-sbx-test",
    dataRoot: root,
    client,
    verifier: new FakeSbxVerifier(state),
    reconciliationPollMs: 2,
    reconciliationAttempts: 100,
    ...overrides,
  });
  backends.push(value);
  return value;
}

function rejectingBackend(
  root: string,
  state: ReturnType<typeof fakeSbxState>,
): SbxExecutionEnvironmentBackend {
  const reject = async (): Promise<never> => {
    throw new EnvironmentBackendError(
      "environment_identity_mismatch",
      "synthetic guest identity conflict",
    );
  };
  const value = new SbxExecutionEnvironmentBackend({
    workerId: "worker-sbx-test",
    dataRoot: root,
    client: new FakeSbxClient(state),
    verifier: { initialize: reject, verify: reject },
    reconciliationPollMs: 2,
    reconciliationAttempts: 100,
  });
  backends.push(value);
  return value;
}

async function tempRoot(): Promise<string> {
  const parent = join(process.cwd(), ".pi", "tmp");
  await mkdir(parent, { recursive: true });
  const root = await mkdtemp(join(parent, "sbx-backend-"));
  roots.push(root);
  return root;
}
