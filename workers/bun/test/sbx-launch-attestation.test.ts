import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { verifyEnvironmentAttestation } from "../src/harnesses/pi/sbx-herdr-state-extension.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

test("guest attestation binds exact environment, profile, lineage, workspace, and HOME", async () => {
  const fixture = await setup();

  await expect(
    verifyEnvironmentAttestation(fixture.environment, fixture.workspace),
  ).resolves.toEqual(fixture.expected);

  await writeFile(
    fixture.binding,
    `${JSON.stringify({ ...fixture.expected, physicalLineageId: "stale-lineage" })}\n`,
  );
  await expect(
    verifyEnvironmentAttestation(fixture.environment, fixture.workspace),
  ).rejects.toThrow("launch binding mismatch for physicalLineageId");
});

test("guest attestation rejects stale incarnation, wrong cwd, HOME, and missing paths", async () => {
  const fixture = await setup();
  await writeFile(
    fixture.marker,
    `${JSON.stringify({ ...fixture.markerValue, incarnation: "stale-incarnation" })}\n`,
  );
  await expect(
    verifyEnvironmentAttestation(fixture.environment, fixture.workspace),
  ).rejects.toThrow("ownership marker mismatch for incarnation");

  await writeFile(fixture.marker, `${JSON.stringify(fixture.markerValue)}\n`);
  await expect(
    verifyEnvironmentAttestation(fixture.environment, fixture.root),
  ).rejects.toThrow("Pi cwd does not match");
  await expect(
    verifyEnvironmentAttestation(
      { ...fixture.environment, HOME: fixture.root },
      fixture.workspace,
    ),
  ).rejects.toThrow("Pi HOME does not match");
  await expect(
    verifyEnvironmentAttestation(
      {
        ...fixture.environment,
        QE_SBX_REQUIRED_GUEST_PATHS_JSON: JSON.stringify([
          ...fixture.requiredPaths,
          join(fixture.root, "missing"),
        ]),
      },
      fixture.workspace,
    ),
  ).rejects.toThrow();
});

async function setup() {
  const parent = join(process.cwd(), ".pi", "tmp");
  await mkdir(parent, { recursive: true });
  const root = await mkdtemp(join(parent, "sbx-attestation-"));
  roots.push(root);
  const workspace = join(root, "workspace");
  const home = join(root, "home");
  const control = join(root, "control");
  await Promise.all([mkdir(workspace), mkdir(home), mkdir(control)]);
  const marker = join(root, "environment-ownership.json");
  const binding = join(control, "launch-binding.json");
  const expected = {
    schemaVersion: 1,
    workerId: "worker-1",
    runId: "run-1",
    environmentId: "environment-1",
    incarnation: "incarnation-1",
    profileId: "qe-pi-execution-v1",
    profileDigest: "sha256:profile",
    physicalLineageId: "lineage-1",
    workspacePath: workspace,
    homePath: home,
  };
  const markerValue = {
    schemaVersion: 1,
    backendKind: "sbx",
    workerId: expected.workerId,
    runId: expected.runId,
    environmentId: expected.environmentId,
    displayName: "sandbox-1",
    incarnation: expected.incarnation,
    profileId: expected.profileId,
    profileDigest: expected.profileDigest,
    specDigest: "sha256:spec",
  };
  await writeFile(marker, `${JSON.stringify(markerValue)}\n`);
  await writeFile(binding, `${JSON.stringify(expected)}\n`);
  const requiredPaths = [marker, binding, workspace, home, control];
  const environment: NodeJS.ProcessEnv = {
    HOME: home,
    QE_SBX_ATTESTATION_JSON: JSON.stringify(expected),
    QE_SBX_OWNERSHIP_MARKER_PATH: marker,
    QE_SBX_LAUNCH_BINDING_PATH: binding,
    QE_SBX_REQUIRED_GUEST_PATHS_JSON: JSON.stringify(requiredPaths),
  };
  return {
    root,
    workspace,
    marker,
    binding,
    expected,
    markerValue,
    requiredPaths,
    environment,
  };
}
