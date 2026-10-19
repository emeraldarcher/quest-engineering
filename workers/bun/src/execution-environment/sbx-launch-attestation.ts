import {
  decodeOwnershipMarkerV2,
  mismatchedRunOwnershipMarkerFieldsV2,
  type RunOwnershipExpectationV2,
} from "./ownership-marker.ts";
import type { EnvironmentLease } from "./types.ts";

const MAX_ATTESTATION_BYTES = 64 * 1024;

export interface SbxLaunchAttestationV1 extends RunOwnershipExpectationV2 {
  schemaVersion: 1;
  physicalLineageId: string;
  workspacePath: string;
  homePath: string;
  harnessKind: string;
}

export interface SbxGuestLaunchPathValidation {
  lease: EnvironmentLease;
  attestation: SbxLaunchAttestationV1;
  ownershipMarkerPath: string;
  launchBindingPath: string;
  requiredPaths: readonly string[];
  workspacePath: string;
  guestExecutable: string;
}

/**
 * Reads and strictly decodes the production marker before any harness process
 * can launch. The schema-v2 Run authority is exclusively owner.runId.
 */
export async function validateSbxGuestLaunchPaths(
  input: SbxGuestLaunchPathValidation,
): Promise<void> {
  const marker = await readOwnershipMarker(input);
  const bad = mismatchedRunOwnershipMarkerFieldsV2(marker, input.attestation);
  const bindingBad = await launchBindingMismatches(input);
  const probe = await input.lease.exec({
    executable: "/usr/bin/python3",
    args: [
      "-c",
      "import json,os,pathlib,sys; paths=json.loads(os.environ['QE_PATHS']); missing=[p for p in paths if not pathlib.Path(p).exists()]; exe=os.environ['QE_EXECUTABLE']; executable=os.path.isfile(exe) and os.access(exe,os.X_OK); workspace=pathlib.Path(os.environ['QE_WORKSPACE']).is_dir(); print(json.dumps({'missing':missing,'executable':executable,'workspace':workspace},separators=(',',':'))); sys.exit(0 if not missing and executable and workspace else 41)",
    ],
    environment: {
      QE_PATHS: JSON.stringify(input.requiredPaths),
      QE_EXECUTABLE: input.guestExecutable,
      QE_WORKSPACE: input.workspacePath,
    },
    timeoutMs: 30_000,
  });
  const physical = decodePhysicalProbe(probe.stdout);
  if (
    bad.length > 0 ||
    bindingBad.length > 0 ||
    probe.exitCode !== 0 ||
    physical.missing.length > 0 ||
    !physical.executable ||
    !physical.workspace
  )
    throw launchMismatch(
      `SBX guest launch-path validation failed: ${JSON.stringify({
        bad,
        binding_bad: bindingBad,
        missing: physical.missing,
        executable: physical.executable,
        workspace: physical.workspace,
      })}`,
    );
}

async function readOwnershipMarker(input: SbxGuestLaunchPathValidation) {
  try {
    return decodeOwnershipMarkerV2(
      await input.lease.readFile({
        path: input.ownershipMarkerPath,
        maxBytes: MAX_ATTESTATION_BYTES,
      }),
    );
  } catch (error) {
    throw launchMismatch(
      `SBX ownership marker validation failed: ${error instanceof Error ? error.message : "unknown marker failure"}`,
    );
  }
}

async function launchBindingMismatches(
  input: SbxGuestLaunchPathValidation,
): Promise<string[]> {
  let value: unknown;
  try {
    const bytes = await input.lease.readFile({
      path: input.launchBindingPath,
      maxBytes: MAX_ATTESTATION_BYTES,
    });
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    return ["launchBinding"];
  }
  if (!value || typeof value !== "object" || Array.isArray(value))
    return ["launchBinding"];
  const binding = value as Record<string, unknown>;
  const expectedKeys = Object.keys(input.attestation).sort();
  const actualKeys = Object.keys(binding).sort();
  if (
    actualKeys.length !== expectedKeys.length ||
    actualKeys.some((key, index) => key !== expectedKeys[index])
  )
    return ["fields"];
  return expectedKeys.filter(
    (key) =>
      binding[key] !== input.attestation[key as keyof SbxLaunchAttestationV1],
  );
}

function decodePhysicalProbe(value: string): {
  missing: string[];
  executable: boolean;
  workspace: boolean;
} {
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>;
    if (
      Object.keys(parsed).sort().join(",") !== "executable,missing,workspace" ||
      !Array.isArray(parsed.missing) ||
      parsed.missing.some((path) => typeof path !== "string") ||
      typeof parsed.executable !== "boolean" ||
      typeof parsed.workspace !== "boolean"
    )
      throw new Error("invalid probe shape");
    return {
      missing: parsed.missing as string[],
      executable: parsed.executable,
      workspace: parsed.workspace,
    };
  } catch {
    throw launchMismatch(
      "SBX guest launch-path probe returned invalid output.",
    );
  }
}

function launchMismatch(message: string): Error {
  return Object.assign(new Error(message), {
    code: "environment_launch_mismatch",
  });
}
