import { expect, test } from "bun:test";
import {
  createOwnershipMarkerV2,
  encodeOwnershipMarkerV2,
} from "../src/execution-environment/ownership-marker.ts";
import {
  type SbxLaunchAttestationV1,
  validateSbxGuestLaunchPaths,
} from "../src/execution-environment/sbx-launch-attestation.ts";
import type { EnvironmentLease } from "../src/execution-environment/types.ts";

const markerPath = "/qe/state/environment-ownership.json";
const bindingPath = "/qe/control/lineage/launch-binding.json";
const workspacePath = "/qe/workspaces/default";
const executable = "/opt/qe/runtime";
const attestation: SbxLaunchAttestationV1 = {
  schemaVersion: 1,
  workerId: "worker-launch-contract",
  runId: "run-launch-contract",
  environmentId: "environment-launch-contract",
  incarnation: "incarnation-launch-contract",
  profileId: "qe-claude-broker-run-v1",
  profileDigest: "sha256:profile-launch-contract",
  physicalLineageId: "lineage-launch-contract",
  workspacePath,
  homePath: "/qe/state/lineage/home",
  harnessKind: "claude_code",
};

function productionMarker() {
  return createOwnershipMarkerV2(
    {
      workerId: attestation.workerId,
      owner: { kind: "run", runId: attestation.runId },
      environmentId: attestation.environmentId,
      state: "running",
      incarnation: attestation.incarnation,
      profileId: attestation.profileId,
      profileDigest: attestation.profileDigest,
      specDigest: "spec-launch-contract",
    },
    { id: attestation.environmentId, name: "qe-run-launch-contract" },
  );
}

function lease(
  marker: unknown = productionMarker(),
  binding: unknown = attestation,
): EnvironmentLease {
  const files = new Map([
    [
      markerPath,
      new TextEncoder().encode(
        typeof marker === "string"
          ? marker
          : encodeOwnershipMarkerV2(
              marker as ReturnType<typeof productionMarker>,
            ),
      ),
    ],
    [bindingPath, new TextEncoder().encode(JSON.stringify(binding))],
  ]);
  return {
    ref: {
      backendKind: "sbx",
      workerId: attestation.workerId,
      owner: { kind: "run", runId: attestation.runId },
      environmentId: attestation.environmentId,
      incarnation: attestation.incarnation,
      profile: {
        id: attestation.profileId,
        digest: attestation.profileDigest,
      },
    },
    paths: {
      workspace: workspacePath,
      state: "/qe/state",
      control: "/qe/control",
      home: "/home/agent",
      cache: "/home/agent/.cache",
      temp: "/tmp/qe",
    },
    capabilities: [],
    paneEnvironment: {},
    readFile: async ({ path }) => {
      const value = files.get(path);
      if (!value) throw new Error("missing test file");
      return value;
    },
    exec: async () => ({
      exitCode: 0,
      stdout: JSON.stringify({
        missing: [],
        executable: true,
        workspace: true,
      }),
      stderr: "",
    }),
    launcher: async () => {
      throw new Error("not used");
    },
    workerExec: async () => {
      throw new Error("not used");
    },
    writeFile: async () => {
      throw new Error("not used");
    },
    spawnStreamed: async () => {
      throw new Error("not used");
    },
    reconcileStreamedProcess: async () => {
      throw new Error("not used");
    },
  } as EnvironmentLease;
}

function validate(
  environment: EnvironmentLease,
  expected: SbxLaunchAttestationV1 = attestation,
) {
  return validateSbxGuestLaunchPaths({
    lease: environment,
    attestation: expected,
    ownershipMarkerPath: markerPath,
    launchBindingPath: bindingPath,
    requiredPaths: [markerPath, bindingPath, executable, workspacePath],
    workspacePath,
    guestExecutable: executable,
  });
}

test("production writer and decoder pass the production pre-launch validator", async () => {
  await expect(validate(lease())).resolves.toBeUndefined();
});

test("Run A marker cannot authorize Run B", async () => {
  await expect(
    validate(lease(), { ...attestation, runId: "run-b" }),
  ).rejects.toMatchObject({ code: "environment_launch_mismatch" });
  await expect(
    validate(lease(), { ...attestation, runId: "run-b" }),
  ).rejects.toThrow("owner.runId");
});

test("pre-launch rejects forged top-level Run identity before process launch", async () => {
  const forged = JSON.stringify({ ...productionMarker(), runId: "run-b" });
  await expect(validate(lease(forged))).rejects.toMatchObject({
    code: "environment_launch_mismatch",
  });
  await expect(validate(lease(forged))).rejects.toThrow(
    "unexpected or missing fields",
  );
});

test("pre-launch retains environment, incarnation, profile, and binding fences", async () => {
  await expect(
    validate(lease(), { ...attestation, environmentId: "environment-forged" }),
  ).rejects.toThrow("environmentId");
  await expect(
    validate(lease(), { ...attestation, incarnation: "incarnation-forged" }),
  ).rejects.toThrow("incarnation");
  await expect(
    validate(lease(), {
      ...attestation,
      profileDigest: "sha256:profile-forged",
    }),
  ).rejects.toThrow("profileDigest");
  await expect(
    validate(lease(productionMarker(), { ...attestation, runId: "run-b" })),
  ).rejects.toThrow("binding_bad");
});
