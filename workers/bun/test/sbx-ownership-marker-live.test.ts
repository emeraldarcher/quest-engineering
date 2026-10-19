import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { decodeOwnershipMarkerV2 } from "../src/execution-environment/ownership-marker.ts";
import { SbxExecutionEnvironmentBackend } from "../src/execution-environment/sbx-backend.ts";
import { validateSbxGuestLaunchPaths } from "../src/execution-environment/sbx-launch-attestation.ts";
import {
  SBX_CLAUDE_BROKER_RUN_PROFILE,
  SBX_CLAUDE_BROKER_RUN_PROFILE_V1,
  SBX_DISPOSABLE_RESOURCE_POLICY,
} from "../src/execution-environment/sbx-profile.ts";
import type {
  EnvironmentLease,
  RunEnvironmentSpec,
} from "../src/execution-environment/types.ts";

const live = process.env.QE_LIVE_SBX === "1";

test.skipIf(!live)(
  "physical deny-all Run writes and validates canonical schema-v2 ownership without inference",
  async () => {
    const parent = join(process.cwd(), ".pi", "tmp");
    await mkdir(parent, { recursive: true });
    const root = await mkdtemp(join(parent, "sbx-ownership-marker-live-"));
    const workerId = `marker-live-worker-${randomUUID().slice(0, 12)}`;
    const runId = `marker-live-run-${randomUUID()}`;
    const backend = new SbxExecutionEnvironmentBackend({
      workerId,
      dataRoot: root,
      executionProfile: SBX_CLAUDE_BROKER_RUN_PROFILE,
      resourcePolicy: SBX_DISPOSABLE_RESOURCE_POLICY,
      reconciliationPollMs: 500,
      reconciliationAttempts: 120,
    });
    let lease: EnvironmentLease | null = null;
    try {
      lease = await backend.ensure(spec(workerId, runId));
      const controlRoot = `${lease.paths.control}/marker-live`;
      const bindingPath = `${controlRoot}/launch-binding.json`;
      const markerPath = `${lease.paths.state}/environment-ownership.json`;
      const executable = "/usr/bin/python3";
      const attestation = {
        schemaVersion: 1 as const,
        workerId,
        runId,
        environmentId: lease.ref.environmentId,
        incarnation: lease.ref.incarnation,
        profileId: lease.ref.profile.id,
        profileDigest: lease.ref.profile.digest,
        physicalLineageId: `lineage-${randomUUID()}`,
        workspacePath: lease.paths.workspace,
        homePath: lease.paths.home,
        harnessKind: "zero_inference_marker_proof",
      };
      await lease.workerExec({
        executable: "/usr/bin/install",
        args: ["-d", "-m", "0700", "-o", "1000", "-g", "1000", controlRoot],
      });
      await lease.writeFile({
        path: bindingPath,
        data: new TextEncoder().encode(`${JSON.stringify(attestation)}\n`),
        mode: 0o400,
      });
      const validation = {
        lease,
        attestation,
        ownershipMarkerPath: markerPath,
        launchBindingPath: bindingPath,
        requiredPaths: [
          markerPath,
          bindingPath,
          executable,
          lease.paths.workspace,
          lease.paths.home,
          controlRoot,
        ],
        workspacePath: lease.paths.workspace,
        guestExecutable: executable,
      };
      await expect(
        validateSbxGuestLaunchPaths(validation),
      ).resolves.toBeUndefined();

      const marker = decodeOwnershipMarkerV2(
        await lease.readFile({ path: markerPath, maxBytes: 64 * 1024 }),
      );
      expect(marker.schemaVersion).toBe(2);
      expect(marker.owner).toEqual({ kind: "run", runId });
      expect(marker).not.toHaveProperty("runId");
      expect(marker).toMatchObject({
        workerId,
        environmentId: lease.ref.environmentId,
        incarnation: lease.ref.incarnation,
        profileId: SBX_CLAUDE_BROKER_RUN_PROFILE_V1.id,
        profileDigest: SBX_CLAUDE_BROKER_RUN_PROFILE_V1.digest,
      });

      await expect(
        validateSbxGuestLaunchPaths({
          ...validation,
          attestation: { ...attestation, runId: `${runId}-wrong` },
        }),
      ).rejects.toThrow("owner.runId");

      const removedOwner = structuredClone(lease.ref.owner);
      const physicalEvidence = {
        environmentId: lease.ref.environmentId,
        incarnation: lease.ref.incarnation,
        workerId,
        owner: removedOwner,
        profile: structuredClone(lease.ref.profile),
      };
      let stop = await backend.stop(lease.ref);
      for (
        let attempt = 0;
        attempt < 120 && stop.state !== "stopped";
        attempt += 1
      ) {
        await Bun.sleep(500);
        stop = await backend.reconcileStop(lease.ref);
      }
      expect(stop.state).toBe("stopped");
      await backend.remove(lease.ref);
      expect(await backend.currentEnvironment(removedOwner)).toBeNull();
      lease = null;
      console.log(
        JSON.stringify({
          proof: "schema_v2_run_ownership_marker_zero_inference",
          ...physicalEvidence,
          markerAuthority: "owner.runId",
          topLevelRunIdPresent: false,
          wrongRunRejected: true,
          network: "deny_all",
          credentials: "none",
          harnessLaunched: false,
          providerTrafficRequested: false,
          modelRequestCreated: false,
          inferenceAuthorized: false,
          removed: true,
        }),
      );
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
  12 * 60_000,
);

function spec(workerId: string, runId: string): RunEnvironmentSpec {
  return {
    workerId,
    owner: { kind: "run", runId },
    layout: { kind: "run" },
    profile: SBX_CLAUDE_BROKER_RUN_PROFILE_V1,
    resourcePolicy: SBX_DISPOSABLE_RESOURCE_POLICY.identity,
    networkRequirements: [],
    credentialGrants: [],
    controlChannels: [],
    requiredCapabilities: [
      { kind: "environment_persistence", mode: "verified" },
      { kind: "credentials", mode: "none" },
      { kind: "network_policy", mode: "deny_all" },
    ],
    workspace: {
      workspaceId: `workspace-${runId}`,
      access: "none",
      materialization: {
        kind: "disposable_fixture",
        sourceIdentity: "fixture:ownership-marker-live",
        frozenBase: { kind: "fixture", value: "ownership-marker-v2" },
      },
    },
  };
}
