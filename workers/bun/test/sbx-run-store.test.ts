import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { SbxRunExecutionStore } from "../src/execution-environment/sbx-run-store.ts";
import type { EnvironmentRef } from "../src/execution-environment/types.ts";
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
