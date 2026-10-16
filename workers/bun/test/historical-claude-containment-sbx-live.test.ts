import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { cleanupExecutionEnvironment } from "../src/execution-environment/run-cleanup.ts";
import { SbxExecutionEnvironmentBackend } from "../src/execution-environment/sbx-backend.ts";
import { CliSbxClient } from "../src/execution-environment/sbx-client.ts";
import type { EnvironmentRef } from "../src/execution-environment/types.ts";
import { SbxPidfdPhysicalProcessController } from "../tools/forensic/historical-claude-containment/physical.ts";
import type { HistoricalTargetIdentity } from "../tools/forensic/historical-claude-containment/types.ts";
import { sbxSpec } from "./sbx-support.ts";

const live = process.env.QE_LIVE_CONTAINMENT_SBX === "1";

// Provider-free physical acceptance. This creates a disposable shell-profile
// sandbox and Python sleeper; it never opens historical state or provider paths.
test.skipIf(!live)(
  "disposable SBX process proves exact pidfd containment and physical settlement",
  async () => {
    const parent = join(process.cwd(), ".pi", "tmp");
    await mkdir(parent, { recursive: true });
    const root = await mkdtemp(join(parent, "containment-sbx-live-"));
    const backend = new SbxExecutionEnvironmentBackend({
      workerId: "worker-sbx-test",
      dataRoot: root,
      onStreamedProcessEvent: () => undefined,
    });
    let ref: EnvironmentRef | null = null;
    try {
      const spec = sbxSpec(`containment-${Date.now()}`);
      const lease = await backend.ensure(spec);
      ref = lease.ref;
      const process = await lease.spawnStreamed({
        executable: "/usr/bin/python3",
        args: ["-I", "-c", "import time; time.sleep(120)"],
        cwd: lease.paths.workspace,
        environment: {},
      });
      const environment = environmentEvidence(root, ref.environmentId);
      const target: HistoricalTargetIdentity = {
        setupAttemptId: randomUUID(),
        cancellationRequestId: randomUUID(),
        authorizationId: randomUUID(),
        authorizedAt: new Date().toISOString(),
        providerAccountId: "synthetic-provider-account",
        setupGeneration: 1,
        credentialGeneration: 1,
        environmentGeneration: 1,
        invocationWorkerGeneration: 1,
        invocationEnvironmentOperationId: randomUUID(),
        workerId: ref.workerId,
        backendKind: "sbx",
        environmentId: ref.environmentId,
        environmentIncarnation: ref.incarnation,
        environmentDisplayName: environment.displayName,
        environmentMarkerDigest: environment.markerDigest,
        environmentNativeAgent: environment.nativeAgent,
        profileId: ref.profile.id,
        profileDigest: ref.profile.digest,
        backendProcessId: process.handle.backendProcessId,
        processStartIdentity: process.handle.processStartIdentity,
        processGeneration: process.handle.processGeneration,
        executable: process.handle.executable,
        observedExecutable: process.handle.observedExecutable as string,
        authConfigurationIdentity: "synthetic-no-provider",
        authEnvironmentPolicy: "synthetic-no-provider",
        authEvidenceIdentity: "synthetic-no-provider",
        authInspectedAt: new Date().toISOString(),
      };
      const controller = new SbxPidfdPhysicalProcessController(
        new CliSbxClient(),
      );
      expect(await controller.inspect(target)).toMatchObject({
        kind: "live_exact",
        pidfdOpened: true,
      });
      expect(await controller.cancelOnce(target, randomUUID())).toMatchObject({
        kind: "acknowledged",
      });
      expect(await process.exit).toMatchObject({ kind: "signaled" });
      expect(await controller.inspect(target)).toMatchObject({
        kind: "target_absent",
      });
      expect(await convergeCleanup(backend, ref)).toBe("removed");
      ref = null;
    } finally {
      if (ref) await convergeCleanup(backend, ref).catch(() => undefined);
      await backend.close();
      await rm(root, { recursive: true, force: true });
    }
  },
  12 * 60_000,
);

function environmentEvidence(
  root: string,
  environmentId: string,
): { displayName: string; markerDigest: string; nativeAgent: string } {
  const database = new Database(join(root, "execution-environments.sqlite"), {
    readonly: true,
  });
  const row = database
    .query(
      `SELECT display_name,marker_digest,native_agent
       FROM execution_environments WHERE environment_id=?`,
    )
    .get(environmentId) as {
    display_name: string;
    marker_digest: string;
    native_agent: string;
  };
  database.close();
  return {
    displayName: row.display_name,
    markerDigest: row.marker_digest,
    nativeAgent: row.native_agent,
  };
}

async function convergeCleanup(
  backend: SbxExecutionEnvironmentBackend,
  ref: EnvironmentRef,
): Promise<string> {
  let outcome = await cleanupExecutionEnvironment(backend, ref);
  for (
    let attempt = 0;
    outcome.state !== "removed" && attempt < 120;
    attempt += 1
  ) {
    await Bun.sleep(500);
    outcome = await cleanupExecutionEnvironment(backend, ref);
  }
  return outcome.state;
}
