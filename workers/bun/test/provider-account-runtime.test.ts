import { afterEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ProviderAccountEnvironmentManager,
  type ProviderAccountRuntimeAuthority,
} from "../src/execution-environment/provider-account.ts";
import { ClaudeSubscriptionSetupLauncher } from "../src/execution-environment/provider-account-setup-launcher.ts";
import {
  SBX_CLAUDE_ACCOUNT_PROFILE_V2,
  SBX_GUEST_PATHS,
} from "../src/execution-environment/sbx-profile.ts";
import { ExecutionEnvironmentStore } from "../src/execution-environment/store.ts";
import type {
  EnvironmentCapability,
  EnvironmentLease,
  EnvironmentRef,
  EnvironmentSpec,
  ExecutionEnvironmentBackend,
} from "../src/execution-environment/types.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

const capabilities: EnvironmentCapability[] = [
  { kind: "credentials", mode: "account_private_claude_oauth" },
  { kind: "network_policy", mode: "anthropic_account_only" },
  { kind: "harness_runtime", mode: "claude_code_managed_mod_v1" },
  { kind: "control_channel", mode: "worker_account_mailbox_v1" },
  { kind: "process.streamed", mode: "attached_only" },
];

test("credential generation 2 uses the exact retained environment provisioned at generation 1", async () => {
  const fixture = await runtimeFixture();
  try {
    const runtime = await fixture.manager.claudeCodeRuntime(fixture.input());
    expect(runtime.ref).toEqual(fixture.authority.ref);
    expect(runtime.ref.owner).toMatchObject({ credentialGeneration: 1 });
    expect(fixture.recoveredSpecs[0]?.owner).toMatchObject({
      credentialGeneration: 1,
    });
    expect(fixture.store.list()).toHaveLength(1);
    expect(fixture.store.list()[0]?.owner).toMatchObject({
      credentialGeneration: 1,
    });
    expect(fixture.state.credentialGeneration).toBe(2);
    expect(() => runtime.assertCurrent()).not.toThrow();
    expect(fixture.providerOrModelCommands).toBe(0);
  } finally {
    await fixture.close();
  }
});

test("stale credentials cannot use a current physical environment", async () => {
  const fixture = await runtimeFixture();
  try {
    await expect(
      fixture.manager.claudeCodeRuntime({
        ...fixture.input(),
        credentialGeneration: 1,
      }),
    ).rejects.toMatchObject({ code: "stale_environment_ref" });
    expect(fixture.recoveredSpecs).toHaveLength(0);
    const runtime = await fixture.manager.claudeCodeRuntime(fixture.input());
    fixture.state.credentialGeneration = 3;
    expect(() => runtime.assertCurrent()).toThrow("credential authority");
  } finally {
    await fixture.close();
  }
});

test("wrong account, environment, incarnation, Worker and profile fail before recovery", async () => {
  const fixture = await runtimeFixture();
  try {
    const ref = fixture.authority.ref;
    const wrongRefs: EnvironmentRef[] = [
      {
        ...ref,
        owner: {
          kind: "provider_account",
          providerAccountId: "another-account",
          credentialGeneration: 1,
        },
      },
      { ...ref, environmentId: "wrong-environment" },
      { ...ref, incarnation: "replaced-incarnation" },
      { ...ref, workerId: "another-worker" },
      { ...ref, profile: { ...ref.profile, digest: "wrong-digest" } },
      { ...ref, owner: { kind: "run", runId: "not-an-account" } },
    ];
    for (const wrong of wrongRefs) {
      await expect(
        fixture.manager.claudeCodeRuntime({
          ...fixture.input(),
          authority: { ...fixture.authority, ref: wrong },
        }),
      ).rejects.toMatchObject({ code: "stale_environment_ref" });
    }
    await expect(
      fixture.manager.claudeCodeRuntime({
        ...fixture.input(),
        providerAccountId: "another-account",
      }),
    ).rejects.toMatchObject({ code: "stale_environment_ref" });
    expect(fixture.recoveredSpecs).toHaveLength(0);
  } finally {
    await fixture.close();
  }
});

test("replacement environment at the same credential generation rejects E1 and accepts current E2", async () => {
  const fixture = await runtimeFixture();
  try {
    const oldAuthority = fixture.authority;
    const first = await fixture.manager.claudeCodeRuntime(fixture.input());
    const firstRecord = fixture.store.byRef(first.ref);
    if (!firstRecord) throw new Error("Missing first environment record");
    fixture.store.retire(firstRecord.recordId);
    const replacement = seedEnvironment(
      fixture.store,
      "environment-2",
      "incarnation-2",
    );
    fixture.state.ref = replacement;
    const nextAuthority = fixture.authorityFor(replacement);
    await expect(
      fixture.manager.claudeCodeRuntime({
        ...fixture.input(),
        authority: oldAuthority,
      }),
    ).rejects.toThrow("physical authority");
    expect(() => first.assertCurrent()).toThrow();
    const second = await fixture.manager.claudeCodeRuntime({
      ...fixture.input(),
      authority: nextAuthority,
    });
    expect(second.ref).toEqual(replacement);
    expect(second.ref.owner).toMatchObject({ credentialGeneration: 1 });
    expect(fixture.state.credentialGeneration).toBe(2);
  } finally {
    await fixture.close();
  }
});

test("stop/start of the same cell requires current lifecycle and routing, not credential rollover", async () => {
  const fixture = await runtimeFixture();
  try {
    const runtime = await fixture.manager.claudeCodeRuntime(fixture.input());
    const record = fixture.store.byRef(runtime.ref);
    if (!record) throw new Error("Missing retained environment record");
    const id = record.recordId;
    fixture.store.markState(id, "stopped");
    expect(() => runtime.assertCurrent()).toThrow("execution authority");
    await expect(
      fixture.manager.claudeCodeRuntime(fixture.input()),
    ).rejects.toMatchObject({ code: "stale_environment_ref" });
    fixture.state.available = false;
    expect(() => runtime.assertCurrent()).toThrow("lifecycle authority");
    fixture.store.markState(id, "running");
    fixture.state.available = true;
    fixture.state.workerCurrent = false;
    await expect(
      fixture.manager.claudeCodeRuntime(fixture.input()),
    ).rejects.toThrow("Worker authority");
    fixture.state.workerCurrent = true;
    expect(
      (await fixture.manager.claudeCodeRuntime(fixture.input())).ref,
    ).toEqual(runtime.ref);
    expect(fixture.state.credentialGeneration).toBe(2);
  } finally {
    await fixture.close();
  }
});

test("Worker reconstruction reuses generation-1 provenance with generation-2 credential authority", async () => {
  const fixture = await runtimeFixture();
  try {
    const before = await fixture.manager.claudeCodeRuntime(fixture.input());
    await fixture.restart();
    const after = await fixture.manager.claudeCodeRuntime(fixture.input());
    expect(after.ref).toEqual(before.ref);
    expect(fixture.store.list()).toHaveLength(1);
    expect(fixture.store.list()[0]?.owner).toMatchObject({
      credentialGeneration: 1,
    });
    expect(fixture.providerOrModelCommands).toBe(0);
  } finally {
    await fixture.close();
  }
});

test("recovery cannot replace the cell or bypass authority invalidation across await", async () => {
  const fixture = await runtimeFixture();
  try {
    fixture.onRecover = () => {
      fixture.state.workerCurrent = false;
    };
    await expect(
      fixture.manager.claudeCodeRuntime(fixture.input()),
    ).rejects.toThrow("Worker authority");
    fixture.state.workerCurrent = true;
    fixture.onRecover = () => undefined;
    fixture.returnWrongRef = true;
    await expect(
      fixture.manager.claudeCodeRuntime(fixture.input()),
    ).rejects.toMatchObject({ code: "stale_environment_ref" });
  } finally {
    await fixture.close();
  }
});

function seedEnvironment(
  store: ExecutionEnvironmentStore,
  environmentId: string,
  incarnation: string,
): EnvironmentRef {
  const owner = {
    kind: "provider_account",
    providerAccountId: "account-runtime",
    credentialGeneration: 1,
  } as const;
  const claim = store.claimCreation({
    recordId: randomUUID(),
    backendKind: "sbx",
    workerId: "worker-runtime",
    owner,
    displayName: `fixture-${environmentId}`,
    incarnation,
    profileId: SBX_CLAUDE_ACCOUNT_PROFILE_V2.id,
    profileDigest: SBX_CLAUDE_ACCOUNT_PROFILE_V2.digest,
    specDigest: "runtime-fixture",
    creationToken: randomUUID(),
    creatorPid: process.pid,
    nativeVersion: "fixture",
    nativeRevision: "fixture",
    nativeApiVersion: "fixture",
  });
  store.bindPhysical({
    recordId: claim.record.recordId,
    environmentId,
    nativeAgent: "fixture",
    markerDigest: "fixture",
    state: "running",
    capabilities,
    diagnostics: [],
  });
  return {
    backendKind: "sbx",
    workerId: "worker-runtime",
    owner,
    environmentId,
    incarnation,
    profile: SBX_CLAUDE_ACCOUNT_PROFILE_V2,
  };
}

async function runtimeFixture() {
  const root = await mkdtemp(join(tmpdir(), "qe-account-runtime-"));
  roots.push(root);
  let store = new ExecutionEnvironmentStore(root);
  const firstRef = seedEnvironment(store, "environment-1", "incarnation-1");
  const state = {
    credentialGeneration: 2,
    ref: firstRef,
    available: true,
    workerCurrent: true,
  };
  const recoveredSpecs: EnvironmentSpec[] = [];
  const fixture = {
    state,
    recoveredSpecs,
    providerOrModelCommands: 0,
    returnWrongRef: false,
    onRecover: () => undefined,
    get store() {
      return store;
    },
    manager: undefined as unknown as ProviderAccountEnvironmentManager,
    authority: undefined as unknown as ProviderAccountRuntimeAuthority,
    authorityFor: (ref: EnvironmentRef): ProviderAccountRuntimeAuthority => ({
      providerAccountId: "account-runtime",
      credentialGeneration: 2,
      ref: structuredClone(ref),
      assertCurrent: () => {
        if (state.credentialGeneration !== 2)
          throw new Error("stale credential authority");
        if (JSON.stringify(state.ref) !== JSON.stringify(ref))
          throw new Error("stale physical authority");
        if (!state.available) throw new Error("stale lifecycle authority");
        if (!state.workerCurrent) throw new Error("stale Worker authority");
      },
    }),
    input: () => ({
      providerAccountId: "account-runtime",
      credentialGeneration: 2,
      authority: fixture.authority,
    }),
    close: async () => {
      await fixture.manager.close();
      store.close();
    },
    restart: async () => {
      await fixture.manager.close();
      store.close();
      store = new ExecutionEnvironmentStore(root);
      fixture.manager = manager();
      fixture.authority = fixture.authorityFor(state.ref);
    },
  };
  function manager() {
    const backend = {
      recover: async (ref: EnvironmentRef, spec: EnvironmentSpec) => {
        recoveredSpecs.push(structuredClone(spec));
        fixture.onRecover();
        return {
          ref: fixture.returnWrongRef ? { ...ref, incarnation: "wrong" } : ref,
          paths: SBX_GUEST_PATHS,
          capabilities,
          workerExec: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
          exec: async () => {
            fixture.providerOrModelCommands++;
            throw new Error("No auth or model commands permitted");
          },
          spawnStreamed: async () => {
            fixture.providerOrModelCommands++;
            throw new Error("No process launch permitted");
          },
        } as unknown as EnvironmentLease;
      },
      close: async () => undefined,
    } as unknown as ExecutionEnvironmentBackend;
    return new ProviderAccountEnvironmentManager(
      { workerId: "worker-runtime", dataRoot: root, provider: "pi" },
      {
        backend,
        store,
        fake: false,
        setupLauncher: new ClaudeSubscriptionSetupLauncher(),
      },
    );
  }
  fixture.manager = manager();
  fixture.authority = fixture.authorityFor(firstRef);
  return fixture;
}
