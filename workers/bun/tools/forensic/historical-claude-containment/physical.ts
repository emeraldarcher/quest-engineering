import type {
  SbxClient,
  SbxSandboxSummary,
} from "../../../src/execution-environment/sbx-client.ts";
import { DETACHED_PROCESS_CANCELLATION_PROGRAM } from "../../../src/execution-environment/sbx-detached-process.ts";
import {
  type CancellationSubmissionResult,
  ContainmentError,
  type HistoricalTargetIdentity,
  type PhysicalObservation,
  type PhysicalProcessController,
} from "./types.ts";

const OWNERSHIP_MARKER_PATH = "/qe/state/environment-ownership.json";

export const PIDFD_INSPECTION_PROGRAM = [
  "import hashlib,json,os,pathlib,sys",
  "marker=pathlib.Path(sys.argv[1])",
  "expected_marker=sys.argv[2]",
  "pid_text=os.environ.get('QE_PID','')",
  "def done(status,code,**extra): print(json.dumps({'status':status,**extra},separators=(',',':'))); raise SystemExit(code)",
  "if not marker.is_file() or hashlib.sha256(marker.read_bytes()).hexdigest()!=expected_marker: done('marker_mismatch',4)",
  "if not pid_text.isdigit(): done('identity_mismatch',4)",
  "pid=int(pid_text)",
  "try: fd=os.pidfd_open(pid,0)",
  "except ProcessLookupError: done('process_absent',3)",
  "except Exception: done('pidfd_unavailable',5)",
  "try:",
  " p=pathlib.Path('/proc')/pid_text",
  " if not p.is_dir(): done('process_absent',3)",
  " stat=(p/'stat').read_text(); close=stat.rfind(')'); fields=stat[close+2:].split()",
  " state=fields[0]; start=fields[19]; exe=os.readlink(p/'exe') if (p/'exe').exists() else ''",
  " if state=='Z': done('process_terminal',3,startIdentity=start,observedExecutable=exe)",
  " if start!=sys.argv[3]: done('pid_reuse',4,startIdentity=start,observedExecutable=exe)",
  " if exe!=sys.argv[4]: done('executable_mismatch',4,startIdentity=start,observedExecutable=exe)",
  " done('live_exact',0,pidfdOpened=True,startIdentity=start,observedExecutable=exe)",
  "finally: os.close(fd)",
].join("\n");

export const PIDFD_CANCELLATION_PROGRAM = DETACHED_PROCESS_CANCELLATION_PROGRAM;

export class SbxPidfdPhysicalProcessController
  implements PhysicalProcessController
{
  constructor(
    private readonly client: SbxClient,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  async inspect(
    target: HistoricalTargetIdentity,
  ): Promise<PhysicalObservation> {
    const observedAt = this.now();
    let sandbox: SbxSandboxSummary | null;
    try {
      const located = locateSandbox(await this.client.list(), target);
      if (located.kind === "absent")
        return {
          kind: "target_absent",
          reason: "environment_absent",
          environmentStatus: null,
          observedAt,
        };
      if (located.kind === "mismatch")
        return {
          kind: "identity_mismatch",
          reason: "environment_identity",
          observedAt,
        };
      sandbox = located.sandbox;
    } catch {
      return { kind: "unavailable", reason: "sbx_inventory", observedAt };
    }
    if (sandbox.agent !== target.environmentNativeAgent)
      return {
        kind: "identity_mismatch",
        reason: "environment_identity",
        observedAt,
      };
    if (sandbox.status === "stopped")
      return {
        kind: "target_absent",
        reason: "environment_stopped",
        environmentStatus: sandbox.status,
        observedAt,
      };
    if (sandbox.status !== "running")
      return { kind: "unavailable", reason: "sbx_inventory", observedAt };
    try {
      const result = await this.client.exec(
        sandbox.name,
        processCommand(PIDFD_INSPECTION_PROGRAM, target),
        { allowNonZero: true },
      );
      return decodeInspection(
        result.exitCode,
        result.stdout,
        sandbox.status,
        observedAt,
      );
    } catch {
      return { kind: "unavailable", reason: "sbx_exec", observedAt };
    }
  }

  async cancelOnce(
    target: HistoricalTargetIdentity,
    containmentOperationId: string,
  ): Promise<CancellationSubmissionResult> {
    let located: ReturnType<typeof locateSandbox>;
    try {
      located = locateSandbox(await this.client.list(), target);
    } catch {
      throw new ContainmentError(
        "physical_observation_unavailable",
        "SBX inventory is unavailable before the cancellation boundary.",
      );
    }
    if (located.kind === "absent")
      return {
        kind: "not_submitted_target_absent",
        observedAt: this.now(),
      };
    if (located.kind === "mismatch")
      return {
        kind: "not_submitted_identity_mismatch",
        observedAt: this.now(),
      };
    if (located.sandbox.status === "stopped")
      return {
        kind: "not_submitted_target_absent",
        observedAt: this.now(),
      };
    if (
      located.sandbox.agent !== target.environmentNativeAgent ||
      located.sandbox.status !== "running"
    )
      return {
        kind: "not_submitted_identity_mismatch",
        observedAt: this.now(),
      };
    try {
      const result = await this.client.exec(
        located.sandbox.name,
        {
          ...processCommand(PIDFD_CANCELLATION_PROGRAM, target),
          environment: {
            QE_PID: target.backendProcessId,
            QE_CANCELLATION_ID: containmentOperationId,
          },
        },
        { allowNonZero: true },
      );
      const status = resultObject(result.stdout).status;
      if (result.exitCode === 0 && status === "signalled")
        return { kind: "acknowledged", observedAt: this.now() };
      if (status === "gone")
        return {
          kind: "not_submitted_target_absent",
          observedAt: this.now(),
        };
      if (status === "identity_mismatch")
        return {
          kind: "not_submitted_identity_mismatch",
          observedAt: this.now(),
        };
      return { kind: "uncertain", observedAt: this.now() };
    } catch {
      return { kind: "uncertain", observedAt: this.now() };
    }
  }

  private now(): string {
    return this.clock().toISOString();
  }
}

function processCommand(program: string, target: HistoricalTargetIdentity) {
  const identityArguments = [
    target.environmentMarkerDigest,
    target.processStartIdentity,
    target.observedExecutable,
  ];
  return {
    executable: "/usr/bin/python3",
    args: [
      "-I",
      "-c",
      program,
      ...(program === PIDFD_CANCELLATION_PROGRAM
        ? identityArguments
        : [OWNERSHIP_MARKER_PATH, ...identityArguments]),
    ],
    environment: { QE_PID: target.backendProcessId },
    timeoutMs: 30_000,
  };
}

function locateSandbox(
  sandboxes: readonly SbxSandboxSummary[],
  target: HistoricalTargetIdentity,
):
  | { kind: "exact"; sandbox: SbxSandboxSummary }
  | { kind: "absent" }
  | { kind: "mismatch" } {
  const byIdentity = sandboxes.filter(
    (sandbox) => sandbox.id === target.environmentId,
  );
  const byName = sandboxes.filter(
    (sandbox) => sandbox.name === target.environmentDisplayName,
  );
  if (byIdentity.length === 0 && byName.length === 0) return { kind: "absent" };
  if (
    byIdentity.length !== 1 ||
    byName.length !== 1 ||
    byIdentity[0] !== byName[0]
  )
    return { kind: "mismatch" };
  return { kind: "exact", sandbox: byIdentity[0] as SbxSandboxSummary };
}

function decodeInspection(
  exitCode: number,
  output: string,
  environmentStatus: string,
  observedAt: string,
): PhysicalObservation {
  let value: Record<string, unknown>;
  try {
    value = resultObject(output);
  } catch {
    return {
      kind: "unavailable",
      reason: "malformed_observation",
      observedAt,
    };
  }
  if (
    exitCode === 0 &&
    value.status === "live_exact" &&
    value.pidfdOpened === true &&
    typeof value.startIdentity === "string" &&
    typeof value.observedExecutable === "string"
  )
    return {
      kind: "live_exact",
      environmentStatus,
      pidfdOpened: true,
      observedStartIdentity: value.startIdentity,
      observedExecutable: value.observedExecutable,
      observedAt,
    };
  if (value.status === "process_absent")
    return {
      kind: "target_absent",
      reason: "process_absent",
      environmentStatus,
      observedAt,
    };
  if (value.status === "process_terminal")
    return {
      kind: "target_absent",
      reason: "process_terminal",
      environmentStatus,
      observedAt,
    };
  if (value.status === "marker_mismatch")
    return { kind: "identity_mismatch", reason: "marker_digest", observedAt };
  if (value.status === "pid_reuse")
    return { kind: "identity_mismatch", reason: "pid_reuse", observedAt };
  if (value.status === "executable_mismatch")
    return {
      kind: "identity_mismatch",
      reason: "process_executable",
      observedAt,
    };
  if (value.status === "identity_mismatch")
    return {
      kind: "identity_mismatch",
      reason: "process_start_identity",
      observedAt,
    };
  if (value.status === "pidfd_unavailable")
    return { kind: "unavailable", reason: "pidfd", observedAt };
  return { kind: "unavailable", reason: "malformed_observation", observedAt };
}

function resultObject(output: string): Record<string, unknown> {
  const value = JSON.parse(output);
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Malformed SBX containment observation.");
  return value as Record<string, unknown>;
}
