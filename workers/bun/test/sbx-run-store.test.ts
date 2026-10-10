import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import type { WorkerConfig } from "../src/config.ts";
import {
  SBX_CODING_EXECUTION_PROFILE_V2,
  SBX_CODING_EXECUTION_PROFILE_V3,
} from "../src/execution-environment/sbx-profile.ts";
import { SbxRunExecutionManager } from "../src/execution-environment/sbx-run.ts";
import { SbxRunExecutionStore } from "../src/execution-environment/sbx-run-store.ts";
import type { EnvironmentRef } from "../src/execution-environment/types.ts";
import type { HarnessSetupContext } from "../src/harnesses/types.ts";
import type {
  PrivateGitChangeExport,
  PrivateLineageWorkspace,
} from "../src/workspace/private-git.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

test("Run-bound setup rejects mismatched harness, Workspace, and access before environment creation", async () => {
  const parent = join(process.cwd(), ".pi", "tmp");
  await mkdir(parent, { recursive: true });
  const root = await mkdtemp(join(parent, "sbx-run-setup-guard-"));
  roots.push(root);
  let ensureCount = 0;
  const worktree = {
    state: "ready",
    runId: "run-1",
    workspaceId: "workspace-1",
    bindingId: "binding-1",
    canonicalRoot: "/host/run-1",
    baseRevision: "base-1",
  };
  const manager = new SbxRunExecutionManager(
    {
      workerId: "worker-1",
      dataRoot: root,
      enabledHarnesses: ["claude_agent_sdk"],
      workspaceBindings: [
        {
          binding_id: "binding-1",
          workspace_id: "workspace-1",
          max_access: "read_only",
        },
      ],
    } as unknown as WorkerConfig,
    { verify: async () => worktree } as never,
    {
      backend: {
        ensure: async () => {
          ensureCount += 1;
          throw new Error("environment creation must not be reached");
        },
        close: () => undefined,
      } as never,
      privateGit: { close: () => undefined } as never,
    },
  );
  const context = {
    setupId: "setup-1",
    setupGeneration: 1,
    actionId: "action-1",
    runId: "run-1",
    occurrenceId: "occurrence-1",
    memberKey: "member-1",
    harnessKind: "claude_agent_sdk",
    physicalLineageId: "physical-1",
    logicalLineageId: "logical-1",
    workspaceId: "workspace-1",
    worktreeId: "worktree-1",
    workspaceBindingId: "binding-1",
    canonicalRoot: "/host/run-1",
    workspaceAccess: "read_only",
    profile: SBX_CODING_EXECUTION_PROFILE_V3,
    configuration: {
      model: { provider: "anthropic", model: "claude-test" },
      reasoning: "high",
      reasoningCapability: { kind: "enumerated", values: ["high"] },
      toolPolicy: { kind: "exact", tools: ["workspace.filesystem"] },
      toolEnforcement: "exact",
      resolvedToolProfile: { tools: ["workspace.filesystem"] },
    },
  } satisfies HarnessSetupContext;
  try {
    await expect(
      manager.prepareHarnessSetup({ ...context, harnessKind: "fake" }),
    ).rejects.toThrow("does not match");
    await expect(
      manager.prepareHarnessSetup({
        ...context,
        profile: SBX_CODING_EXECUTION_PROFILE_V2,
      }),
    ).rejects.toThrow("does not match");
    await expect(
      manager.prepareHarnessSetup({ ...context, workspaceId: "workspace-2" }),
    ).rejects.toThrow("exact ready Run worktree");
    await expect(
      manager.prepareHarnessSetup({
        ...context,
        workspaceAccess: "read_write",
      }),
    ).rejects.toThrow("exceeds the authorized source binding");
    expect(ensureCount).toBe(0);
  } finally {
    await manager.close();
  }
});

test("teardown health never rewrites completed Product export but active loss needs attention", async () => {
  const parent = join(process.cwd(), ".pi", "tmp");
  await mkdir(parent, { recursive: true });
  const root = await mkdtemp(join(parent, "sbx-run-stop-semantics-"));
  roots.push(root);
  const store = new SbxRunExecutionStore(root);
  const ref = (environmentId: string, runId: string) =>
    ({
      backendKind: "sbx",
      environmentId,
      incarnation: `incarnation-${environmentId}`,
      workerId: "worker-stop-semantics",
      runId,
      profile: { id: "qe-coding-execution-v1", digest: "profile" },
    }) as EnvironmentRef;
  const workspace = (lineageId: string) =>
    ({
      physicalLineageId: lineageId,
      repositoryId: `repository-${lineageId}`,
    }) as PrivateLineageWorkspace;
  store.ready({
    lineageId: "completed-lineage",
    actionId: "completed-action",
    runId: "completed-run",
    environmentRef: ref("completed-environment", "completed-run"),
    workspace: workspace("completed-lineage"),
    extensionSetDigest: "extensions",
  });
  store.bindExport("completed-lineage", "completed-action", {
    exportId: "verified-export",
    checkpointId: "verified-checkpoint",
    bundlePath: join(root, "verified.bundle"),
    manifest: { resultTree: "verified-result-tree" },
  } as PrivateGitChangeExport);
  store.ready({
    lineageId: "active-lineage",
    actionId: "active-action",
    runId: "active-run",
    environmentRef: ref("active-environment", "active-run"),
    workspace: workspace("active-lineage"),
    extensionSetDigest: "extensions",
  });
  const stopStatus = {
    state: "uncertain",
    intent: "recorded",
    invocation: "ambiguous",
    observation: "unavailable",
    stopId: "stop-cycle",
  } as const;
  const backend = {
    inspect: async (environmentRef: EnvironmentRef) => ({
      ref: environmentRef,
      state: "degraded",
      usable: false,
      stop: stopStatus,
    }),
    reconcileStop: async (environmentRef: EnvironmentRef) => ({
      ref: environmentRef,
      ...stopStatus,
    }),
    close: () => undefined,
  };
  const manager = new SbxRunExecutionManager(
    {
      workerId: "worker-stop-semantics",
      dataRoot: root,
      enabledHarnesses: ["pi", "antigravity"],
    } as unknown as WorkerConfig,
    {} as never,
    {
      backend: backend as never,
      privateGit: { close: () => undefined } as never,
      store,
    },
  );
  try {
    expect(await manager.reconcileDurableOwnership()).toEqual([
      "completed-lineage: environment_stop_uncertain_unavailable",
      "active-lineage: environment_stop_uncertain_unavailable",
    ]);
    expect(store.get("completed-lineage")).toMatchObject({
      state: "ready",
      failureCode: null,
      changeExport: {
        exportId: "verified-export",
        manifest: { resultTree: "verified-result-tree" },
      },
    });
    expect(store.get("active-lineage")).toMatchObject({
      state: "attention_required",
      failureCode: "environment_stop_uncertain_unavailable",
      changeExport: null,
    });
  } finally {
    await manager.close();
  }
});

test("SBX Run execution store preserves host tree continuity while rotating Action export", async () => {
  const parent = join(process.cwd(), ".pi", "tmp");
  await mkdir(parent, { recursive: true });
  const root = await mkdtemp(join(parent, "sbx-run-store-"));
  roots.push(root);
  const store = new SbxRunExecutionStore(root);
  const environmentRef = {
    backendKind: "sbx",
    environmentId: "environment-1",
    environmentName: "qe-run-1",
    incarnation: "incarnation-1",
    workerId: "worker-1",
    runId: "run-1",
    profile: { id: "qe-pi-execution-v1", digest: "profile" },
    specDigest: "spec",
  } as EnvironmentRef;
  const workspace = {
    physicalLineageId: "lineage-1",
    repositoryId: "repository-1",
  } as PrivateLineageWorkspace;
  store.ready({
    lineageId: "lineage-1",
    actionId: "action-1",
    runId: "run-1",
    environmentRef,
    workspace,
    extensionSetDigest: "extensions-1",
  });
  const launchProvenance = {
    schemaVersion: 1 as const,
    executable: "/opt/qe/bin/bun",
    cwd: root,
    argvSha256: "host-argv",
    environmentKeys: [],
    launcherContractVersion: 1 as const,
    launcherEntrypoint: "/qe/sbx-launcher.ts",
    launcherEntrypointSha256: "launcher-digest",
    guestExecutable: "/opt/qe/pi/bin/pi",
    guestCwd: "/qe/workspace",
    guestArgvSha256: "guest-argv",
    physicalLineageId: "lineage-1",
    environmentId: "environment-1",
    incarnation: "incarnation-1",
    profileId: "qe-pi-execution-v1",
    profileDigest: "profile",
  };
  store.bindLaunch("lineage-1", "action-1", launchProvenance);
  const changeExport = {
    exportId: "export-1",
    checkpointId: "checkpoint-1",
    bundlePath: join(root, "bundle"),
    manifest: { resultTree: "tree-1" },
  } as PrivateGitChangeExport;
  store.bindExport("lineage-1", "action-1", changeExport);
  expect(store.get("lineage-1")).toMatchObject({
    actionId: "action-1",
    changeExport: { exportId: "export-1" },
    hostResultTree: "tree-1",
    launchProvenance: {
      executable: "/opt/qe/bin/bun",
      guestExecutable: "/opt/qe/pi/bin/pi",
      launcherEntrypointSha256: "launcher-digest",
      physicalLineageId: "lineage-1",
    },
  });

  expect(() =>
    store.ready({
      lineageId: "lineage-1",
      actionId: "action-2",
      runId: "run-1",
      environmentRef,
      workspace,
      extensionSetDigest: "extensions-2",
    }),
  ).toThrow("conflicts");
  store.ready({
    lineageId: "lineage-1",
    actionId: "action-2",
    runId: "run-1",
    environmentRef,
    workspace,
    extensionSetDigest: "extensions-1",
  });
  expect(store.get("lineage-1")).toMatchObject({
    actionId: "action-2",
    changeExport: null,
    recoveryExport: { exportId: "export-1" },
    hostResultTree: "tree-1",
    launchProvenance: null,
  });
  store.ready({
    lineageId: "lineage-2",
    actionId: "action-3",
    runId: "run-1",
    environmentRef,
    workspace: { ...workspace, physicalLineageId: "lineage-2" },
    extensionSetDigest: "extensions-1",
    inheritedHostResultTree: "tree-1",
    inheritedRecoveryExport: changeExport,
  });
  expect(store.get("lineage-2")).toMatchObject({
    hostResultTree: "tree-1",
    recoveryExport: { exportId: "export-1" },
  });
  const replacementRef = {
    ...environmentRef,
    environmentId: "environment-2",
    incarnation: "incarnation-2",
  };
  store.ready({
    lineageId: "lineage-1",
    actionId: "action-2",
    runId: "run-1",
    environmentRef: replacementRef,
    workspace,
    extensionSetDigest: "extensions-1",
    replacementOf: environmentRef,
  });
  expect(store.get("lineage-1")).toMatchObject({
    environmentRef: {
      environmentId: "environment-2",
      incarnation: "incarnation-2",
    },
    recoveryExport: { exportId: "export-1" },
  });
  store.close();
});
