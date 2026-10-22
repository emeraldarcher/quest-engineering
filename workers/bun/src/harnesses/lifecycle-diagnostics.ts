import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import type {
  EnvironmentRef,
  StreamedProcessExit,
  StreamedProcessHandle,
} from "../execution-environment/types.ts";

export const MANAGED_HARNESS_LIFECYCLE_PROTOCOL =
  "managed_harness_lifecycle_v1" as const;

export const LIFECYCLE_PROGRESS = [
  "process_launch_requested",
  "process_spawned",
  "stream_observation_registered",
  "probe_write_requested",
  "probe_write_acknowledged",
  "protocol_frame_observed",
  "protocol_frame_validated",
] as const;
export const LIFECYCLE_STAGES = [
  ...LIFECYCLE_PROGRESS,
  "protocol_frame_rejected",
  "protocol_observation_failed",
  "attestation_timeout_fired",
  "cancellation_requested",
  "cancellation_acknowledged",
  "process_exit_observed",
] as const;
export type LifecycleStage = (typeof LIFECYCLE_STAGES)[number];
export type Observation =
  | "observed"
  | "not_observed"
  | "unobservable_at_this_layer"
  | "unknown";

export interface LifecycleContext {
  lineageId?: string;
  harnessKind: string;
  harnessProtocol: string;
  reservedNativeSessionId: string;
  environment: EnvironmentRef;
}
export interface LifecycleEvent {
  stage: LifecycleStage;
  observedAt: string;
  elapsedMs: number;
  operationId?: string;
  exit?: StreamedProcessExit;
}
export interface LifecycleEvidence {
  schemaVersion: 1;
  protocol: typeof MANAGED_HARNESS_LIFECYCLE_PROTOCOL;
  preparationId: string;
  context: LifecycleContext;
  process: {
    processGeneration: string;
    backendProcessId: string;
    processStartIdentity: string;
  } | null;
  lastProvenStage: (typeof LIFECYCLE_PROGRESS)[number] | null;
  observations: Record<LifecycleStage, Observation>;
  modExecution: "unestablished";
  modEntrypoint: "unobservable_at_this_layer";
  modReady: "unobservable_at_this_layer";
  nativeProbeParsed: "unobservable_at_this_layer";
  nativeInitConstructed: "unobservable_at_this_layer";
  nativeInitSubmitted: "unobservable_at_this_layer";
  nativeAttestationInterval: "unknown" | "response_observed";
  processStateAtTimeout: "unknown" | "terminal_observed";
  persistence: "available" | "unknown";
  events: LifecycleEvent[];
}

/** Worker-local, non-authoritative evidence. Never accepts native text/payloads. */
export class ManagedHarnessLifecycleStore {
  private available = false;

  constructor(private readonly db: Database) {
    try {
      db.exec(`CREATE TABLE IF NOT EXISTS managed_harness_lifecycle(
        preparation_id TEXT PRIMARY KEY,
        evidence_json TEXT NOT NULL
      ) STRICT;`);
      this.available = true;
    } catch {
      // Diagnostics are not a new prerequisite for harness correctness.
    }
  }

  begin(context: LifecycleContext): ManagedHarnessLifecycle | null {
    try {
      return new ManagedHarnessLifecycle(context, (evidence) => {
        if (!this.available) return false;
        try {
          this.db
            .query(
              `INSERT INTO managed_harness_lifecycle VALUES (?,?)
               ON CONFLICT(preparation_id) DO UPDATE SET evidence_json=excluded.evidence_json`,
            )
            .run(evidence.preparationId, JSON.stringify(evidence));
          return true;
        } catch {
          return false;
        }
      });
    } catch {
      return null;
    }
  }

  get(preparationId: string): LifecycleEvidence | null {
    if (!this.available) return null;
    try {
      const row = this.db
        .query(
          "SELECT evidence_json FROM managed_harness_lifecycle WHERE preparation_id=?",
        )
        .get(preparationId) as { evidence_json: string } | null;
      return row ? (JSON.parse(row.evidence_json) as LifecycleEvidence) : null;
    } catch {
      return null;
    }
  }
}

/** One preparation, one immutable physical attachment; silence is not nonexecution. */
export class ManagedHarnessLifecycle {
  readonly preparationId = randomUUID();
  private readonly context: LifecycleContext;
  private handle: StreamedProcessHandle | null = null;
  private readonly events = new Map<LifecycleStage, LifecycleEvent>();
  private readonly started = performance.now();
  private persistence: "available" | "unknown" = "unknown";

  constructor(
    context: LifecycleContext,
    private readonly persist: (evidence: LifecycleEvidence) => boolean = () =>
      false,
  ) {
    this.context = {
      ...(context.lineageId ? { lineageId: id(context.lineageId) } : {}),
      harnessKind: id(context.harnessKind),
      harnessProtocol: id(context.harnessProtocol),
      reservedNativeSessionId: id(context.reservedNativeSessionId),
      environment: safeEnvironment(context.environment),
    };
  }

  bindProcess(handle: StreamedProcessHandle): void {
    try {
      if (
        this.handle ||
        handle.contractVersion !== 1 ||
        JSON.stringify(safeEnvironment(handle.environment)) !==
          JSON.stringify(this.context.environment) ||
        handle.backendKind !== this.context.environment.backendKind
      )
        return;
      this.handle = {
        contractVersion: 1,
        backendKind: handle.backendKind,
        environment: this.context.environment,
        processGeneration: id(handle.processGeneration),
        backendProcessId: id(handle.backendProcessId),
        processStartIdentity: id(handle.processStartIdentity),
        // Executable paths and all unknown input fields are deliberately excluded.
        executable: "",
      };
      this.record("process_spawned", handle);
    } catch {
      // Invalid diagnostic metadata must not affect the harness.
    }
  }

  record(
    stage: LifecycleStage,
    source?: StreamedProcessHandle,
    details: { operationId?: string; exit?: StreamedProcessExit } = {},
  ): void {
    try {
      if (
        !LIFECYCLE_STAGES.includes(stage) ||
        this.events.has(stage) ||
        (this.events.has("attestation_timeout_fired") &&
          (LIFECYCLE_PROGRESS as readonly LifecycleStage[]).includes(stage)) ||
        (stage === "process_launch_requested"
          ? Boolean(source || this.handle)
          : !source || !this.matches(source))
      )
        return;
      const event: LifecycleEvent = {
        stage,
        observedAt: new Date().toISOString(),
        elapsedMs: Math.max(0, Math.round(performance.now() - this.started)),
      };
      if (details.operationId) event.operationId = id(details.operationId);
      if (stage === "process_exit_observed" && details.exit)
        event.exit = safeExit(details.exit);
      this.events.set(stage, event);
      const evidence = this.snapshot();
      evidence.persistence = "available";
      this.persistence = this.persist(evidence) ? "available" : "unknown";
    } catch {
      this.persistence = "unknown";
    }
  }

  observeInit(
    frame: Record<string, unknown>,
    source: StreamedProcessHandle,
  ): void {
    if (
      frame.type === "system" &&
      frame.subtype === "init" &&
      frame.session_id === this.context.reservedNativeSessionId
    )
      this.record("protocol_frame_observed", source);
  }

  snapshot(): LifecycleEvidence {
    const progress = [...LIFECYCLE_PROGRESS]
      .reverse()
      .find((stage) => this.events.has(stage));
    const order = [...this.events.keys()];
    const timeoutIndex = order.indexOf("attestation_timeout_fired");
    const exitIndex = order.indexOf("process_exit_observed");
    const exit = this.events.get("process_exit_observed")?.exit;
    return {
      schemaVersion: 1,
      protocol: MANAGED_HARNESS_LIFECYCLE_PROTOCOL,
      preparationId: this.preparationId,
      context: structuredClone(this.context),
      process: this.handle
        ? {
            processGeneration: this.handle.processGeneration,
            backendProcessId: this.handle.backendProcessId,
            processStartIdentity: this.handle.processStartIdentity,
          }
        : null,
      lastProvenStage: progress ?? null,
      observations: Object.fromEntries(
        LIFECYCLE_STAGES.map((stage) => [
          stage,
          this.events.has(stage) ? "observed" : "not_observed",
        ]),
      ) as Record<LifecycleStage, Observation>,
      modExecution: "unestablished",
      modEntrypoint: "unobservable_at_this_layer",
      modReady: "unobservable_at_this_layer",
      nativeProbeParsed: "unobservable_at_this_layer",
      nativeInitConstructed: "unobservable_at_this_layer",
      nativeInitSubmitted: "unobservable_at_this_layer",
      nativeAttestationInterval:
        this.events.has("protocol_frame_observed") ||
        this.events.has("protocol_frame_validated")
          ? "response_observed"
          : "unknown",
      processStateAtTimeout:
        timeoutIndex >= 0 &&
        exitIndex >= 0 &&
        exitIndex < timeoutIndex &&
        exit &&
        exit.kind !== "observation_unavailable"
          ? "terminal_observed"
          : "unknown",
      persistence: this.persistence,
      events: structuredClone([...this.events.values()]),
    };
  }

  private matches(source: StreamedProcessHandle): boolean {
    return (
      this.handle !== null &&
      source.contractVersion === 1 &&
      source.backendKind === this.handle.backendKind &&
      source.processGeneration === this.handle.processGeneration &&
      source.backendProcessId === this.handle.backendProcessId &&
      source.processStartIdentity === this.handle.processStartIdentity &&
      JSON.stringify(safeEnvironment(source.environment)) ===
        JSON.stringify(this.context.environment)
    );
  }
}

function id(value: string): string {
  if (typeof value !== "string" || !/^[a-zA-Z0-9_.:-]{1,256}$/.test(value))
    throw new Error("Invalid lifecycle identity.");
  return value;
}

function safeEnvironment(ref: EnvironmentRef): EnvironmentRef {
  const owner = ref.owner;
  if (
    owner.kind === "provider_account" &&
    (!Number.isSafeInteger(owner.credentialGeneration) ||
      owner.credentialGeneration < 1)
  )
    throw new Error("Invalid lifecycle owner.");
  return {
    backendKind: id(ref.backendKind),
    workerId: id(ref.workerId),
    environmentId: id(ref.environmentId),
    incarnation: id(ref.incarnation),
    owner:
      owner.kind === "provider_account"
        ? {
            kind: "provider_account",
            providerAccountId: id(owner.providerAccountId),
            credentialGeneration: owner.credentialGeneration,
          }
        : { kind: "run", runId: id(owner.runId) },
    profile: { id: id(ref.profile.id), digest: id(ref.profile.digest) },
  };
}

const SAFE_SIGNALS = new Set([
  "SIGHUP",
  "SIGINT",
  "SIGQUIT",
  "SIGILL",
  "SIGTRAP",
  "SIGABRT",
  "SIGIOT",
  "SIGBUS",
  "SIGFPE",
  "SIGKILL",
  "SIGUSR1",
  "SIGSEGV",
  "SIGUSR2",
  "SIGPIPE",
  "SIGALRM",
  "SIGTERM",
  "SIGSTKFLT",
  "SIGCHLD",
  "SIGCONT",
  "SIGSTOP",
  "SIGTSTP",
  "SIGTTIN",
  "SIGTTOU",
  "SIGURG",
  "SIGXCPU",
  "SIGXFSZ",
  "SIGVTALRM",
  "SIGPROF",
  "SIGWINCH",
  "SIGIO",
  "SIGPOLL",
  "SIGPWR",
  "SIGSYS",
  "SIGUNUSED",
  "SIGBREAK",
  "SIGRTMIN",
  "SIGRTMAX",
]);

function safeExit(exit: StreamedProcessExit): StreamedProcessExit {
  switch (exit.kind) {
    case "exited":
      if (exit.exitCode !== 0) break;
      return { kind: "exited", exitCode: 0 };
    case "exited_nonzero":
      if (!Number.isSafeInteger(exit.exitCode) || exit.exitCode === 0) break;
      return { kind: "exited_nonzero", exitCode: exit.exitCode };
    case "signaled":
      if (!SAFE_SIGNALS.has(exit.signal)) break;
      return { kind: exit.kind, signal: exit.signal };
    case "observation_unavailable":
      // Never copy an arbitrary backend error code or message.
      return {
        kind: "observation_unavailable",
        errorCode: "streamed_process_stream_unavailable",
      };
  }
  throw new Error("Invalid lifecycle exit.");
}
