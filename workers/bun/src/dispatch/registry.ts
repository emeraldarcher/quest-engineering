import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import {
  type NativeSessionRef,
  parseNativeSessionRef,
  serializeNativeSessionRef,
  validateNativeSessionRef,
} from "../harnesses/native-session.ts";
import {
  type HarnessTransportBinding,
  parseTransportBinding,
  serializeTransportBinding,
} from "../harnesses/transport-binding.ts";
import type {
  HarnessCapabilities,
  HarnessExecutionHandle,
  HarnessSessionState,
  HumanAttention,
  HumanInterventionLifecycle,
  InteractiveHarnessSession,
} from "../harnesses/types.ts";
import {
  parseHarnessExecutionHandle,
  serializeHarnessExecutionHandle,
  validateHarnessExecutionHandle,
  validateInteractiveHarnessSession,
} from "../harnesses/types.ts";
import type {
  ExecuteAction,
  JsonValue,
  LocalDispatchState,
  ReconcileDispatch,
} from "../protocol/types.ts";

export interface HarnessLineage {
  lineageId: string;
  logicalLineageId: string;
  configurationJson: string;
  /** Native model-provider provenance; harness identity is separate. */
  provider: string;
  harnessKind: string;
  sessionState: HarnessSessionState;
  capabilities: HarnessCapabilities;
  attention: HumanAttention | null;
  intervention: HumanInterventionLifecycle | null;
  startedAt: string;
  lastActivityAt: string;
  resultControlPath: string;
  ownershipToken: string;
  activeActionId: string | null;
  /** Durable provider-neutral execution identity. */
  executionHandle: HarnessExecutionHandle | null;
  nativeSession: NativeSessionRef | null;
  /** Adapter-owned durable state; generic orchestration never interprets it. */
  transportBinding: HarnessTransportBinding | null;
  /** Optional interactive capability. Headless lineages validly keep this null. */
  interactive: InteractiveHarnessSession | null;
}

export interface StructuredCompletionRequirement {
  /** Every QE Action requires one nonce-bound semantic result, including `{}`. */
  structuredResultRequired: true;
  outputs: Array<{ name: string; kind: string }>;
  physicalExportRequired: boolean;
}

export interface DispatchRecord {
  action: ExecuteAction;
  state: LocalDispatchState;
  lineageId: string | null;
  resultNonce: string;
  resultDirectory: string;
  /** Frozen from the typed Step output contract when the Action is accepted. */
  completionRequirement: StructuredCompletionRequirement;
  outputs: Record<string, JsonValue> | null;
  failure: Record<string, JsonValue> | null;
  promptIntentAt: string | null;
  promptAcceptedAt: string | null;
  nativeActivityAt: string | null;
  providerTurnSettledAt: string | null;
  nativeIdleAt: string | null;
  structuredResultReceivedAt: string | null;
  stalledAt: string | null;
  settledAt: string | null;
  promptEvidence: Record<string, JsonValue> | null;
  promptAuthorizedAt: string | null;
  serverAcknowledgedAt: string | null;
}

export interface Acceptance {
  created: boolean;
  dispatch: DispatchRecord;
}

export type PhysicalProcessTransitionMode =
  | "prepared_process_adopted"
  | "fresh_process_fallback";

export interface PhysicalProcessTransition {
  sourceActionId: string;
  sourceAttemptId: string;
  targetActionId: string;
  targetAttemptId: string;
  sourceLineageId: string;
  targetLineageId: string;
  mode: PhysicalProcessTransitionMode;
  recordedAt: string;
}

interface PhysicalProcessTransitionRow {
  source_action_id: string;
  source_attempt_id: string;
  target_action_id: string;
  target_attempt_id: string;
  source_lineage_id: string;
  target_lineage_id: string;
  mode: PhysicalProcessTransitionMode;
  recorded_at: string;
}

interface DispatchRow {
  action_id: string;
  action_json: string;
  action_hash: string;
  state: LocalDispatchState;
  lineage_id: string | null;
  result_nonce: string;
  result_directory: string;
  completion_requirement_json: string | null;
  outputs_json: string | null;
  failure_json: string | null;
  prompt_intent_at: string | null;
  prompt_accepted_at: string | null;
  native_activity_at: string | null;
  provider_turn_settled_at: string | null;
  native_idle_at: string | null;
  structured_result_received_at: string | null;
  stalled_at: string | null;
  settled_at: string | null;
  prompt_evidence_json: string | null;
  prompt_authorized_at: string | null;
  server_acknowledged_at: string | null;
}
interface LineageRow {
  lineage_id: string;
  logical_lineage_id: string;
  configuration_json: string;
  configuration_hash: string;
  provider: string;
  harness_kind: string;
  session_state: HarnessSessionState;
  capabilities_json: string;
  attention_json: string | null;
  intervention_json: string | null;
  started_at: string;
  last_activity_at: string;
  result_control_path: string;
  ownership_token: string;
  active_action_id: string | null;
  execution_handle_json: string | null;
  transport_binding_json: string | null;
  native_session_json: string | null;
  interactive_json: string | null;
}

export const DISPATCH_REGISTRY_SCHEMA_VERSION = 1 as const;

export class IncompatibleContinuationConfigurationError extends Error {
  readonly code = "incompatible_continuation_configuration";
  constructor(logicalLineageId: string) {
    super(
      `Continuation configuration differs for logical lineage ${logicalLineageId}.`,
    );
  }
}

export class IncompatibleWorkerDatabaseError extends Error {
  readonly code = "incompatible_worker_database";
  constructor(databasePath: string, detail: string) {
    super(
      `Worker dispatch database ${databasePath} is incompatible with schema version ${DISPATCH_REGISTRY_SCHEMA_VERSION}: ${detail} Reset this greenfield development database before restarting the Worker.`,
    );
  }
}

export class DispatchRegistry {
  readonly databasePath: string;
  readonly dataRoot: string;
  private readonly db: Database;

  constructor(
    databasePath: string,
    dataRoot: string,
    private readonly harnessKind = "pi",
    private readonly harnessCapabilities:
      | HarnessCapabilities
      | ((kind: string) => HarnessCapabilities) = defaultHarnessCapabilities(),
  ) {
    mkdirSync(dataRoot, { recursive: true });
    this.databasePath = databasePath;
    this.dataRoot = dataRoot;
    this.db = new Database(databasePath, { create: true, strict: true });
    this.db.exec(
      "PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;",
    );
    try {
      this.bootstrapCurrentSchema();
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  close(): void {
    this.db.close();
  }

  accept(action: ExecuteAction): Acceptance {
    const actionJson = canonicalJson(action);
    const actionHash = digest(actionJson);
    return this.db
      .transaction(() => {
        const existing = this.row(action.action_id);
        if (existing) {
          if (
            existing.action_hash !== actionHash ||
            existing.action_json !== actionJson
          ) {
            throw new Error(`Action-ID conflict for ${action.action_id}.`);
          }
          return { created: false, dispatch: mapDispatch(existing) };
        }

        let lineageId: string | null = null;
        if (
          action.operational_recovery?.continuation_mode === "retained" &&
          action.operational_recovery.retained_lineage_id
        ) {
          const retainedId = action.operational_recovery.retained_lineage_id;
          const retained = this.db
            .query("SELECT * FROM harness_lineages WHERE lineage_id=?")
            .get(retainedId) as LineageRow | null;
          const expectedConfiguration = physicalConfiguration(action);
          if (
            !retained ||
            retained.harness_kind !==
              action.execution.configuration.harness_kind ||
            retained.logical_lineage_id !==
              action.execution.context.logical_lineage_id ||
            retained.configuration_json !== expectedConfiguration ||
            retained.active_action_id !== null ||
            ["closed", "unavailable"].includes(retained.session_state)
          )
            throw new Error(
              `Retained recovery lineage ${retainedId} is unavailable or incompatible.`,
            );
          lineageId = retainedId;
        } else if (action.execution.context.mode === "fresh") {
          this.retireResolvedFreshLineage(action);
          lineageId = crypto.randomUUID();
          const controlPath = this.lineageControlPath(lineageId);
          const configurationJson = physicalConfiguration(action);
          const createdAt = now();
          const requestedHarness =
            action.execution.configuration.harness_kind || this.harnessKind;
          const requestedCapabilities =
            typeof this.harnessCapabilities === "function"
              ? this.harnessCapabilities(requestedHarness)
              : this.harnessCapabilities;
          this.db
            .query(`INSERT INTO harness_lineages
          (lineage_id,logical_lineage_id,configuration_json,configuration_hash,provider,harness_kind,session_state,capabilities_json,attention_json,intervention_json,started_at,last_activity_at,result_control_path,ownership_token,active_action_id,created_at,updated_at)
          VALUES (?,?,?,?,?,?,?,?,?,?,?, ?,?,?,NULL,?,?)`)
            .run(
              lineageId,
              action.execution.context.logical_lineage_id,
              configurationJson,
              digest(configurationJson),
              action.execution.configuration.model.provider,
              requestedHarness,
              "starting",
              JSON.stringify(requestedCapabilities),
              null,
              null,
              createdAt,
              createdAt,
              controlPath,
              `qe-${digest(`${action.worker_id}:${lineageId}`).slice(0, 24)}`,
              createdAt,
              createdAt,
            );
        }

        const resultNonce = crypto.randomUUID();
        const resultDirectory = join(
          this.dataRoot,
          "results",
          digest(action.action_id),
          resultNonce,
        );
        this.db
          .query(`INSERT INTO dispatches
        (action_id,run_id,occurrence_id,attempt_id,semantic_step_key,action_json,action_hash,state,lineage_id,result_nonce,result_directory,completion_requirement_json,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
          .run(
            action.action_id,
            action.run_id,
            action.occurrence_id,
            action.attempt_id,
            action.semantic_step_key,
            actionJson,
            actionHash,
            "accepted",
            lineageId,
            resultNonce,
            resultDirectory,
            JSON.stringify(structuredCompletionRequirement(action)),
            now(),
            now(),
          );
        return { created: true, dispatch: this.get(action.action_id) };
      })
      .immediate();
  }

  adopt(input: {
    action: ExecuteAction;
    lineage: HarnessLineage;
    state: "accepted" | "running";
    resultNonce: string;
    resultDirectory: string;
  }): DispatchRecord {
    return this.db
      .transaction(() => {
        const existing = this.row(input.action.action_id);
        const lineage = input.lineage;
        const executionHandle = validateHarnessExecutionHandle(
          lineage.executionHandle ?? {
            schemaVersion: 1,
            harnessKind: lineage.harnessKind,
            executionId: lineage.lineageId,
            ...(lineage.nativeSession
              ? { nativeSession: lineage.nativeSession }
              : {}),
            ...(lineage.transportBinding
              ? { transportBinding: lineage.transportBinding }
              : {}),
          },
          lineage.harnessKind,
          lineage.lineageId,
        );
        if (existing) {
          const dispatch = mapDispatch(existing);
          const actionJson = canonicalJson(input.action);
          if (
            existing.action_hash !== digest(actionJson) ||
            dispatch.lineageId !== lineage.lineageId ||
            existing.result_nonce !== input.resultNonce ||
            existing.result_directory !== input.resultDirectory
          )
            throw new Error(
              `Adopted Action ${input.action.action_id} conflicts with durable dispatch identity.`,
            );
          const persisted = this.getLineage(lineage.lineageId);
          if (persisted.ownershipToken !== lineage.ownershipToken)
            throw new Error(
              `Adopted lineage ${lineage.lineageId} has conflicting ownership.`,
            );
          this.recordExecution(
            lineage.lineageId,
            executionHandle,
            lineage.interactive,
          );
          return this.get(input.action.action_id);
        }
        this.db
          .query(`INSERT INTO harness_lineages
        (lineage_id,logical_lineage_id,configuration_json,configuration_hash,provider,harness_kind,session_state,capabilities_json,attention_json,intervention_json,started_at,last_activity_at,result_control_path,ownership_token,active_action_id,execution_handle_json,transport_binding_json,native_session_json,interactive_json,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(lineage_id) DO NOTHING`)
          .run(
            lineage.lineageId,
            lineage.logicalLineageId,
            lineage.configurationJson,
            digest(lineage.configurationJson),
            lineage.provider,
            lineage.harnessKind,
            lineage.sessionState,
            JSON.stringify(lineage.capabilities),
            lineage.attention ? JSON.stringify(lineage.attention) : null,
            lineage.intervention ? JSON.stringify(lineage.intervention) : null,
            lineage.startedAt,
            lineage.lastActivityAt,
            lineage.resultControlPath,
            lineage.ownershipToken,
            input.action.action_id,
            serializeHarnessExecutionHandle(
              executionHandle,
              lineage.harnessKind,
              lineage.lineageId,
            ),
            serializeTransportBinding(
              executionHandle.transportBinding ?? null,
              lineage.harnessKind,
            ),
            serializeNativeSessionRef(
              executionHandle.nativeSession ?? null,
              lineage.harnessKind,
            ),
            lineage.interactive
              ? JSON.stringify(
                  validateInteractiveHarnessSession(lineage.interactive),
                )
              : null,
            now(),
            now(),
          );
        const persistedLineage = this.getLineage(lineage.lineageId);
        if (persistedLineage.ownershipToken !== lineage.ownershipToken) {
          throw new Error(
            `Adopted lineage ${lineage.lineageId} has conflicting ownership.`,
          );
        }
        this.db
          .query(
            `UPDATE harness_lineages SET active_action_id=?,execution_handle_json=?,transport_binding_json=?,native_session_json=?,interactive_json=?,updated_at=? WHERE lineage_id=?`,
          )
          .run(
            input.action.action_id,
            serializeHarnessExecutionHandle(
              executionHandle,
              lineage.harnessKind,
              lineage.lineageId,
            ),
            serializeTransportBinding(
              executionHandle.transportBinding ?? null,
              lineage.harnessKind,
            ),
            serializeNativeSessionRef(
              executionHandle.nativeSession ?? null,
              lineage.harnessKind,
            ),
            lineage.interactive
              ? JSON.stringify(
                  validateInteractiveHarnessSession(lineage.interactive),
                )
              : null,
            now(),
            lineage.lineageId,
          );
        const actionJson = canonicalJson(input.action);
        this.db
          .query(`INSERT INTO dispatches
        (action_id,run_id,occurrence_id,attempt_id,semantic_step_key,action_json,action_hash,state,lineage_id,result_nonce,result_directory,completion_requirement_json,prompt_intent_at,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
          .run(
            input.action.action_id,
            input.action.run_id,
            input.action.occurrence_id,
            input.action.attempt_id,
            input.action.semantic_step_key,
            actionJson,
            digest(actionJson),
            input.state,
            lineage.lineageId,
            input.resultNonce,
            input.resultDirectory,
            JSON.stringify(structuredCompletionRequirement(input.action)),
            now(),
            now(),
            now(),
          );
        return this.get(input.action.action_id);
      })
      .immediate();
  }

  get(actionId: string): DispatchRecord {
    const row = this.row(actionId);
    if (!row) throw new Error(`Unknown dispatch: ${actionId}`);
    return mapDispatch(row);
  }

  list(): DispatchRecord[] {
    return (
      this.db
        .query("SELECT * FROM dispatches ORDER BY rowid")
        .all() as DispatchRow[]
    ).map(mapDispatch);
  }

  listByOccurrence(occurrenceId: string): DispatchRecord[] {
    return (
      this.db
        .query("SELECT * FROM dispatches WHERE occurrence_id=? ORDER BY rowid")
        .all(occurrenceId) as DispatchRow[]
    ).map(mapDispatch);
  }

  resolveContinuation(action: ExecuteAction): HarnessLineage {
    const logicalLineageId = action.execution.context.logical_lineage_id;
    const row = this.db
      .query("SELECT * FROM harness_lineages WHERE logical_lineage_id=?")
      .get(logicalLineageId) as LineageRow | null;
    if (!row)
      throw new Error(
        `Unknown logical continuation lineage: ${logicalLineageId}.`,
      );
    const expected = physicalConfiguration(action);
    if (
      row.harness_kind !== action.execution.configuration.harness_kind ||
      row.configuration_json !== expected ||
      row.configuration_hash !== digest(expected)
    )
      throw new IncompatibleContinuationConfigurationError(logicalLineageId);
    return mapLineage(row);
  }

  assignLineage(actionId: string, lineageId: string): DispatchRecord {
    this.db
      .query(
        "UPDATE dispatches SET lineage_id=?,updated_at=? WHERE action_id=? AND lineage_id IS NULL",
      )
      .run(lineageId, now(), actionId);
    const dispatch = this.get(actionId);
    if (dispatch.lineageId !== lineageId)
      throw new Error(
        `Dispatch ${actionId} is already assigned to another lineage.`,
      );
    return dispatch;
  }

  getLineage(lineageId: string): HarnessLineage {
    const row = this.db
      .query("SELECT * FROM harness_lineages WHERE lineage_id=?")
      .get(lineageId) as LineageRow | null;
    if (!row) throw new Error(`Unknown harness lineage: ${lineageId}`);
    return mapLineage(row);
  }

  listLineages(): HarnessLineage[] {
    return (
      this.db
        .query("SELECT * FROM harness_lineages ORDER BY rowid")
        .all() as LineageRow[]
    ).map(mapLineage);
  }

  occupy(lineageId: string, actionId: string): void {
    this.db
      .transaction(() => {
        const lineage = this.getLineage(lineageId);
        if (lineage.activeActionId && lineage.activeActionId !== actionId) {
          throw new Error(
            `Harness lineage ${lineageId} is occupied by ${lineage.activeActionId}.`,
          );
        }
        this.db
          .query(
            "UPDATE harness_lineages SET active_action_id=?,intervention_json=CASE WHEN active_action_id=? THEN intervention_json ELSE NULL END,updated_at=? WHERE lineage_id=?",
          )
          .run(actionId, actionId, now(), lineageId);
      })
      .immediate();
  }

  recordExecution(
    lineageId: string,
    handle: HarnessExecutionHandle,
    interactive?: InteractiveHarnessSession | null,
  ): void {
    const lineage = this.getLineage(lineageId);
    const valid = validateHarnessExecutionHandle(
      handle,
      lineage.harnessKind,
      lineageId,
    );
    const persistedInteractive =
      interactive === undefined
        ? lineage.interactive
        : interactive
          ? validateInteractiveHarnessSession(interactive)
          : null;
    this.db
      .query(`UPDATE harness_lineages SET
      execution_handle_json=?,transport_binding_json=?,native_session_json=?,interactive_json=?,updated_at=?
      WHERE lineage_id=?`)
      .run(
        serializeHarnessExecutionHandle(valid, lineage.harnessKind, lineageId),
        serializeTransportBinding(
          valid.transportBinding ?? null,
          lineage.harnessKind,
        ),
        serializeNativeSessionRef(
          valid.nativeSession ?? null,
          lineage.harnessKind,
        ),
        persistedInteractive ? JSON.stringify(persistedInteractive) : null,
        now(),
        lineageId,
      );
  }

  recordNativeSession(
    lineageId: string,
    nativeSession: NativeSessionRef,
  ): void {
    const lineage = this.getLineage(lineageId);
    const valid = validateNativeSessionRef(nativeSession, lineage.harnessKind);
    if (!lineage.executionHandle)
      throw new Error(
        `Harness lineage ${lineageId} has no durable execution handle.`,
      );
    this.recordExecution(lineageId, {
      ...lineage.executionHandle,
      nativeSession: valid,
      ...(lineage.transportBinding
        ? { transportBinding: lineage.transportBinding }
        : {}),
    });
    this.db
      .query(
        "UPDATE harness_lineages SET last_activity_at=?,updated_at=? WHERE lineage_id=?",
      )
      .run(now(), now(), lineageId);
  }

  updateSession(
    lineageId: string,
    state: HarnessSessionState,
    attention: HumanAttention | null,
    lastActivityAt = now(),
    intervention?: HumanInterventionLifecycle | null,
  ): HarnessLineage {
    this.db
      .query(
        "UPDATE harness_lineages SET session_state=?,attention_json=?,intervention_json=COALESCE(?,intervention_json),last_activity_at=?,updated_at=? WHERE lineage_id=?",
      )
      .run(
        state,
        attention ? JSON.stringify(attention) : null,
        intervention ? JSON.stringify(intervention) : null,
        lastActivityAt,
        now(),
        lineageId,
      );
    return this.getLineage(lineageId);
  }

  physicalProcessTransition(
    targetActionId: string,
  ): PhysicalProcessTransition | null {
    const row = this.db
      .query(
        "SELECT * FROM physical_process_transitions WHERE target_action_id=?",
      )
      .get(targetActionId) as PhysicalProcessTransitionRow | null;
    return row ? mapPhysicalProcessTransition(row) : null;
  }

  adoptPreparedProcess(
    sourceActionId: string,
    targetActionId: string,
    lineageId: string,
  ): PhysicalProcessTransition {
    return this.db
      .transaction(() => {
        const existing = this.physicalProcessTransition(targetActionId);
        if (existing) {
          if (
            existing.sourceActionId !== sourceActionId ||
            existing.sourceLineageId !== lineageId ||
            existing.targetLineageId !== lineageId ||
            existing.mode !== "prepared_process_adopted"
          )
            throw new Error(
              `Physical-process transition for ${targetActionId} conflicts with durable ownership history.`,
            );
          return existing;
        }
        const { source, target, lineage } = this.assertPreparedTransfer(
          sourceActionId,
          targetActionId,
          lineageId,
        );
        const recordedAt = now();
        this.db
          .query(
            "UPDATE harness_lineages SET active_action_id=?,session_state='starting',attention_json=NULL,intervention_json=NULL,last_activity_at=?,updated_at=? WHERE lineage_id=? AND active_action_id IS NULL",
          )
          .run(targetActionId, recordedAt, recordedAt, lineageId);
        if (this.getLineage(lineageId).activeActionId !== targetActionId)
          throw new Error(
            `Prepared process lineage ${lineageId} could not be transferred atomically.`,
          );
        this.insertPhysicalProcessTransition({
          source,
          target,
          sourceLineage: lineage,
          targetLineageId: lineageId,
          mode: "prepared_process_adopted",
          recordedAt,
        });
        return this.physicalProcessTransition(
          targetActionId,
        ) as PhysicalProcessTransition;
      })
      .immediate();
  }

  replacePreparedProcessWithFresh(
    sourceActionId: string,
    targetActionId: string,
    sourceLineageId: string,
  ): HarnessLineage {
    return this.db
      .transaction(() => {
        const existing = this.physicalProcessTransition(targetActionId);
        if (existing) {
          if (
            existing.sourceActionId !== sourceActionId ||
            existing.sourceLineageId !== sourceLineageId ||
            existing.mode !== "fresh_process_fallback"
          )
            throw new Error(
              `Physical-process fallback for ${targetActionId} conflicts with durable ownership history.`,
            );
          return this.getLineage(existing.targetLineageId);
        }
        const { source, target, lineage } = this.assertPreparedTransfer(
          sourceActionId,
          targetActionId,
          sourceLineageId,
        );
        const recordedAt = now();
        this.db
          .query(
            "UPDATE harness_lineages SET logical_lineage_id=?,updated_at=? WHERE lineage_id=? AND active_action_id IS NULL",
          )
          .run(`retired:${sourceLineageId}`, recordedAt, sourceLineageId);
        const targetLineageId = crypto.randomUUID();
        const controlPath = this.lineageControlPath(targetLineageId);
        const configurationJson = physicalConfiguration(target.action);
        const requestedHarness =
          target.action.execution.configuration.harness_kind ||
          this.harnessKind;
        const requestedCapabilities =
          typeof this.harnessCapabilities === "function"
            ? this.harnessCapabilities(requestedHarness)
            : this.harnessCapabilities;
        this.db
          .query(`INSERT INTO harness_lineages
          (lineage_id,logical_lineage_id,configuration_json,configuration_hash,provider,harness_kind,session_state,capabilities_json,attention_json,intervention_json,started_at,last_activity_at,result_control_path,ownership_token,active_action_id,created_at,updated_at)
          VALUES (?,?,?,?,?,?,?,?,?,?,?, ?,?,?,?,?,?)`)
          .run(
            targetLineageId,
            target.action.execution.context.logical_lineage_id,
            configurationJson,
            digest(configurationJson),
            target.action.execution.configuration.model.provider,
            requestedHarness,
            "starting",
            JSON.stringify(requestedCapabilities),
            null,
            null,
            recordedAt,
            recordedAt,
            controlPath,
            `qe-${digest(`${target.action.worker_id}:${targetLineageId}`).slice(0, 24)}`,
            targetActionId,
            recordedAt,
            recordedAt,
          );
        this.db
          .query(
            "UPDATE dispatches SET lineage_id=?,updated_at=? WHERE action_id=? AND lineage_id=? AND state='accepted'",
          )
          .run(targetLineageId, recordedAt, targetActionId, sourceLineageId);
        if (this.get(targetActionId).lineageId !== targetLineageId)
          throw new Error(
            `Fresh fallback for ${targetActionId} could not rotate physical lineage atomically.`,
          );
        this.insertPhysicalProcessTransition({
          source,
          target,
          sourceLineage: lineage,
          targetLineageId,
          mode: "fresh_process_fallback",
          recordedAt,
        });
        return this.getLineage(targetLineageId);
      })
      .immediate();
  }

  private assertPreparedTransfer(
    sourceActionId: string,
    targetActionId: string,
    lineageId: string,
  ): {
    source: DispatchRecord;
    target: DispatchRecord;
    lineage: HarnessLineage;
  } {
    const source = this.get(sourceActionId);
    const target = this.get(targetActionId);
    const lineage = this.getLineage(lineageId);
    const recovery = target.action.operational_recovery;
    const sourceLifecycleAbsent =
      !source.promptIntentAt &&
      !source.promptAcceptedAt &&
      !source.nativeActivityAt &&
      !source.stalledAt &&
      !source.settledAt;
    if (
      source.state !== "failed" ||
      target.state !== "accepted" ||
      source.lineageId !== lineageId ||
      target.lineageId !== lineageId ||
      recovery?.authorization_kind !== "human" ||
      recovery.continuation_mode !== "retained" ||
      recovery.retained_lineage_id !== lineageId ||
      recovery.source_attempt_id !== source.action.attempt_id ||
      source.action.run_id !== target.action.run_id ||
      source.action.occurrence_id !== target.action.occurrence_id ||
      source.action.execution.execution_workspace.worktree_id !==
        target.action.execution.execution_workspace.worktree_id ||
      physicalConfiguration(source.action) !==
        physicalConfiguration(target.action) ||
      !sourceLifecycleAbsent ||
      target.promptIntentAt ||
      target.promptAcceptedAt ||
      target.nativeActivityAt ||
      target.stalledAt ||
      target.settledAt ||
      lineage.nativeSession ||
      lineage.sessionState !== "retained" ||
      lineage.activeActionId !== null
    )
      throw new Error(
        "Prepared native process does not satisfy the exact pre-prompt ownership-transfer contract.",
      );
    const conflicting = this.list().find(
      (dispatch) =>
        dispatch.action.action_id !== targetActionId &&
        dispatch.action.action_id !== sourceActionId &&
        this.retainsRecoveryOwnership(dispatch) &&
        (dispatch.lineageId === lineageId ||
          dispatch.action.execution.execution_workspace.worktree_id ===
            target.action.execution.execution_workspace.worktree_id),
    );
    if (conflicting)
      throw new Error(
        `Prepared process or worktree is already owned by ${conflicting.action.attempt_id}.`,
      );
    return { source, target, lineage };
  }

  private retainsRecoveryOwnership(dispatch: DispatchRecord): boolean {
    if (dispatch.state === "accepted" || dispatch.state === "running")
      return true;
    if (dispatch.state !== "uncertain" || !dispatch.lineageId) return false;
    const lineage = this.db
      .query(
        "SELECT logical_lineage_id,session_state,active_action_id FROM harness_lineages WHERE lineage_id=?",
      )
      .get(dispatch.lineageId) as {
      logical_lineage_id: string;
      session_state: string;
      active_action_id: string | null;
    } | null;
    if (!lineage) return true;
    return !(
      lineage.logical_lineage_id === `retired:${dispatch.lineageId}` &&
      lineage.active_action_id === null &&
      lineage.session_state === "unavailable"
    );
  }

  private insertPhysicalProcessTransition(input: {
    source: DispatchRecord;
    target: DispatchRecord;
    sourceLineage: HarnessLineage;
    targetLineageId: string;
    mode: PhysicalProcessTransitionMode;
    recordedAt: string;
  }): void {
    this.db
      .query(`INSERT INTO physical_process_transitions
        (source_action_id,source_attempt_id,target_action_id,target_attempt_id,source_lineage_id,target_lineage_id,mode,recorded_at)
        VALUES (?,?,?,?,?,?,?,?)`)
      .run(
        input.source.action.action_id,
        input.source.action.attempt_id,
        input.target.action.action_id,
        input.target.action.attempt_id,
        input.sourceLineage.lineageId,
        input.targetLineageId,
        input.mode,
        input.recordedAt,
      );
  }

  authorizePrompt(actionId: string): DispatchRecord {
    const timestamp = now();
    this.db
      .query(
        "UPDATE dispatches SET prompt_authorized_at=COALESCE(prompt_authorized_at,?),updated_at=? WHERE action_id=? AND state IN ('accepted','running')",
      )
      .run(timestamp, timestamp, actionId);
    return this.get(actionId);
  }

  markPromptIntent(actionId: string): void {
    const timestamp = now();
    this.db
      .query(
        "UPDATE dispatches SET prompt_intent_at=COALESCE(prompt_intent_at,?),updated_at=? WHERE action_id=?",
      )
      .run(timestamp, timestamp, actionId);
  }

  recordPromptEvidence(
    actionId: string,
    evidence: Record<string, JsonValue>,
  ): void {
    this.db
      .query(
        "UPDATE dispatches SET prompt_evidence_json=COALESCE(prompt_evidence_json,?),updated_at=? WHERE action_id=?",
      )
      .run(JSON.stringify(evidence), now(), actionId);
  }

  markPromptAccepted(actionId: string, acceptedAt = now()): void {
    this.db
      .query(
        "UPDATE dispatches SET prompt_accepted_at=COALESCE(prompt_accepted_at,?),state=CASE WHEN state='accepted' THEN 'running' ELSE state END,updated_at=? WHERE action_id=?",
      )
      .run(acceptedAt, now(), actionId);
  }

  markNativeActivity(actionId: string, observedAt = now()): void {
    this.db
      .query(
        "UPDATE dispatches SET native_activity_at=COALESCE(native_activity_at,?),native_idle_at=NULL,state=CASE WHEN state='accepted' THEN 'running' ELSE state END,updated_at=? WHERE action_id=? AND state IN ('accepted','running')",
      )
      .run(observedAt, now(), actionId);
  }

  markProviderTurnSettled(actionId: string, observedAt = now()): void {
    this.db
      .query(
        "UPDATE dispatches SET provider_turn_settled_at=COALESCE(provider_turn_settled_at,?),updated_at=? WHERE action_id=? AND state IN ('accepted','running')",
      )
      .run(observedAt, now(), actionId);
  }

  markNativeIdle(actionId: string, observedAt = now()): void {
    this.db
      .query(
        "UPDATE dispatches SET native_idle_at=?,updated_at=? WHERE action_id=? AND state IN ('accepted','running')",
      )
      .run(observedAt, now(), actionId);
  }

  markStructuredResultReceived(actionId: string, observedAt = now()): void {
    this.db
      .query(
        "UPDATE dispatches SET structured_result_received_at=COALESCE(structured_result_received_at,?),updated_at=? WHERE action_id=? AND state IN ('accepted','running')",
      )
      .run(observedAt, now(), actionId);
  }

  markStalled(actionId: string, observedAt = now()): void {
    this.db
      .query(
        "UPDATE dispatches SET stalled_at=COALESCE(stalled_at,?),state=CASE WHEN state='accepted' THEN 'running' ELSE state END,updated_at=? WHERE action_id=?",
      )
      .run(observedAt, now(), actionId);
  }

  markRunning(actionId: string): void {
    this.db
      .query(
        "UPDATE dispatches SET state='running',updated_at=? WHERE action_id=? AND state IN ('accepted','running')",
      )
      .run(now(), actionId);
  }

  recordObservationFailure(
    actionId: string,
    failure: Record<string, JsonValue>,
  ): void {
    this.db
      .query(
        "UPDATE dispatches SET failure_json=?,updated_at=? WHERE action_id=? AND state NOT IN ('completed','failed')",
      )
      .run(JSON.stringify(failure), now(), actionId);
  }

  resumeObservationUncertainty(actionId: string): DispatchRecord {
    return this.db
      .transaction(() => {
        const dispatch = this.get(actionId);
        if (
          dispatch.state !== "uncertain" ||
          !isRecoverableObservationUncertainty(dispatch)
        )
          return dispatch;
        this.db
          .query(
            "UPDATE dispatches SET state='running',updated_at=? WHERE action_id=? AND state='uncertain'",
          )
          .run(now(), actionId);
        return this.get(actionId);
      })
      .immediate();
  }

  complete(
    actionId: string,
    outputs: Record<string, JsonValue>,
  ): DispatchRecord {
    return this.db
      .transaction(() => {
        const dispatch = this.get(actionId);
        if (!dispatch.lineageId)
          throw new Error(
            `Completed dispatch ${actionId} has no harness lineage.`,
          );
        if (dispatch.state === "failed")
          throw new Error(`Cannot complete ${actionId} from failed.`);
        this.db
          .query(
            "UPDATE dispatches SET state='completed',outputs_json=?,failure_json=NULL,settled_at=COALESCE(settled_at,?),updated_at=? WHERE action_id=?",
          )
          .run(JSON.stringify(outputs), now(), now(), actionId);
        // Occupancy is physical harness execution state, not control-plane acknowledgement.
        this.db
          .query(
            "UPDATE harness_lineages SET active_action_id=NULL,session_state='retained',attention_json=NULL,last_activity_at=?,updated_at=? WHERE lineage_id=? AND active_action_id=?",
          )
          .run(now(), now(), dispatch.lineageId, actionId);
        return this.get(actionId);
      })
      .immediate();
  }

  fail(
    actionId: string,
    failure: Record<string, JsonValue>,
    uncertain = false,
  ): DispatchRecord {
    return this.db
      .transaction(() => {
        const dispatch = this.get(actionId);
        this.db
          .query(
            "UPDATE dispatches SET state=?,failure_json=?,updated_at=? WHERE action_id=? AND state!='completed'",
          )
          .run(
            uncertain ? "uncertain" : "failed",
            JSON.stringify(failure),
            now(),
            actionId,
          );
        if (dispatch.lineageId && !uncertain) {
          this.db
            .query(
              "UPDATE harness_lineages SET active_action_id=NULL,session_state='retained',attention_json=NULL,last_activity_at=?,updated_at=? WHERE lineage_id=? AND active_action_id=?",
            )
            .run(now(), now(), dispatch.lineageId, actionId);
        }
        return this.get(actionId);
      })
      .immediate();
  }

  cancel(
    actionId: string,
    failure: Record<string, JsonValue>,
  ): { dispatch: DispatchRecord; changed: boolean } {
    return this.db
      .transaction(() => {
        const dispatch = this.get(actionId);
        if (
          ["completed", "failed"].includes(dispatch.state) &&
          dispatch.serverAcknowledgedAt
        )
          throw new Error(
            `Cannot cancel server-acknowledged terminal dispatch ${actionId}.`,
          );
        if (
          dispatch.state === "failed" &&
          dispatch.failure?.code === "execution_cancelled" &&
          dispatch.failure.cancellation_request_id ===
            failure.cancellation_request_id
        )
          return { dispatch, changed: false };

        this.db
          .query(
            "UPDATE dispatches SET state='failed',outputs_json=NULL,failure_json=?,server_acknowledged_at=NULL,updated_at=? WHERE action_id=?",
          )
          .run(JSON.stringify(failure), now(), actionId);
        if (dispatch.lineageId) {
          this.db
            .query(
              "UPDATE harness_lineages SET active_action_id=NULL,session_state='retained',attention_json=NULL,last_activity_at=?,updated_at=? WHERE lineage_id=? AND active_action_id=?",
            )
            .run(now(), now(), dispatch.lineageId, actionId);
        }
        return { dispatch: this.get(actionId), changed: true };
      })
      .immediate();
  }

  acknowledgeServerTerminal(actionId: string): void {
    this.db
      .query(
        "UPDATE dispatches SET server_acknowledged_at=COALESCE(server_acknowledged_at,?),updated_at=? WHERE action_id=? AND state IN ('completed','failed')",
      )
      .run(now(), now(), actionId);
  }

  acknowledgeServerCompletion(actionId: string): void {
    this.acknowledgeServerTerminal(actionId);
  }

  reconcilePayloads(): ReconcileDispatch[] {
    return this.list().map((dispatch) => {
      const state = dispatch.state;
      return {
        action_id: dispatch.action.action_id,
        occurrence_id: dispatch.action.occurrence_id,
        attempt_id: dispatch.action.attempt_id,
        state,
        ...(state === "completed" && dispatch.outputs
          ? { outputs: dispatch.outputs }
          : {}),
        ...(state === "failed" || state === "uncertain"
          ? { failure: dispatch.failure ?? { reason: "execution_uncertain" } }
          : {}),
      };
    });
  }

  private lineageControlPath(lineageId: string): string {
    return join(this.dataRoot, "lineages", lineageId, "result-control.json");
  }

  private retireResolvedFreshLineage(action: ExecuteAction): void {
    const logicalLineageId = action.execution.context.logical_lineage_id;
    const existing = this.db
      .query("SELECT * FROM harness_lineages WHERE logical_lineage_id=?")
      .get(logicalLineageId) as LineageRow | null;
    if (!existing) return;

    const previous = this.db
      .query(
        "SELECT * FROM dispatches WHERE occurrence_id=? ORDER BY rowid DESC LIMIT 1",
      )
      .get(action.occurrence_id) as DispatchRow | null;
    const retainedWorkRecovery = Boolean(
      previous &&
        action.operational_recovery?.authorization_kind === "human" &&
        action.operational_recovery.continuation_mode === "fresh" &&
        action.operational_recovery.source_attempt_id ===
          (JSON.parse(previous.action_json) as ExecuteAction).attempt_id &&
        previous.state === "uncertain" &&
        previous.lineage_id === existing.lineage_id &&
        previous.failure_json &&
        (JSON.parse(previous.failure_json) as Record<string, JsonValue>)
          .code === "harness_contract_violation",
    );
    if (
      !previous ||
      (!retainedWorkRecovery && previous.state !== "failed") ||
      previous.lineage_id !== existing.lineage_id ||
      (existing.active_action_id !== null &&
        (!retainedWorkRecovery ||
          existing.active_action_id !== previous.action_id))
    )
      throw new Error(
        `Logical lineage ${logicalLineageId} is not available for a fresh retry.`,
      );

    if (retainedWorkRecovery)
      this.db
        .query(
          "UPDATE harness_lineages SET active_action_id=NULL,session_state='retained',attention_json=NULL,last_activity_at=?,updated_at=? WHERE lineage_id=? AND active_action_id=?",
        )
        .run(now(), now(), existing.lineage_id, previous.action_id);
    this.db
      .query(
        "UPDATE harness_lineages SET logical_lineage_id=?,updated_at=? WHERE lineage_id=?",
      )
      .run(`retired:${existing.lineage_id}`, now(), existing.lineage_id);
  }

  private row(actionId: string): DispatchRow | null {
    return this.db
      .query("SELECT * FROM dispatches WHERE action_id=?")
      .get(actionId) as DispatchRow | null;
  }

  private bootstrapCurrentSchema(): void {
    const tables = this.userTables();
    const version = this.schemaVersion();
    if (tables.length === 0 && version === 0) {
      this.createCurrentSchema();
    } else if (version !== DISPATCH_REGISTRY_SCHEMA_VERSION) {
      throw new IncompatibleWorkerDatabaseError(
        this.databasePath,
        `found schema version ${version}`,
      );
    }
    this.validateCurrentSchema();
    for (const row of this.db
      .query("SELECT * FROM harness_lineages ORDER BY rowid")
      .all() as LineageRow[])
      mapLineage(row);
  }

  private createCurrentSchema(): void {
    this.db.exec(`
      BEGIN IMMEDIATE;
      CREATE TABLE harness_lineages (
        lineage_id TEXT PRIMARY KEY,
        logical_lineage_id TEXT NOT NULL UNIQUE,
        configuration_json TEXT NOT NULL,
        configuration_hash TEXT NOT NULL,
        provider TEXT NOT NULL,
        harness_kind TEXT NOT NULL,
        session_state TEXT NOT NULL CHECK(session_state IN ('starting','waiting_for_activity','running','waiting_for_human','stalled','recovering','retained','closed','unavailable')),
        capabilities_json TEXT NOT NULL,
        attention_json TEXT,
        intervention_json TEXT,
        started_at TEXT NOT NULL,
        last_activity_at TEXT NOT NULL,
        result_control_path TEXT NOT NULL UNIQUE,
        ownership_token TEXT NOT NULL UNIQUE,
        active_action_id TEXT,
        execution_handle_json TEXT,
        transport_binding_json TEXT,
        native_session_json TEXT,
        interactive_json TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE dispatches (
        action_id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        occurrence_id TEXT NOT NULL,
        attempt_id TEXT NOT NULL,
        semantic_step_key TEXT NOT NULL,
        action_json TEXT NOT NULL,
        action_hash TEXT NOT NULL,
        state TEXT NOT NULL CHECK(state IN ('accepted','running','completed','failed','uncertain')),
        lineage_id TEXT REFERENCES harness_lineages(lineage_id),
        result_nonce TEXT NOT NULL,
        result_directory TEXT NOT NULL,
        completion_requirement_json TEXT NOT NULL,
        outputs_json TEXT,
        failure_json TEXT,
        prompt_intent_at TEXT,
        prompt_accepted_at TEXT,
        native_activity_at TEXT,
        provider_turn_settled_at TEXT,
        native_idle_at TEXT,
        structured_result_received_at TEXT,
        stalled_at TEXT,
        settled_at TEXT,
        prompt_evidence_json TEXT,
        prompt_authorized_at TEXT,
        server_acknowledged_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX dispatches_occurrence_id ON dispatches(occurrence_id);
      CREATE INDEX dispatches_attempt_id ON dispatches(attempt_id);
      CREATE INDEX dispatches_run_occurrence ON dispatches(run_id,occurrence_id);
      CREATE INDEX dispatches_state ON dispatches(state);
      CREATE TABLE physical_process_transitions (
        target_action_id TEXT PRIMARY KEY REFERENCES dispatches(action_id),
        source_action_id TEXT NOT NULL REFERENCES dispatches(action_id),
        source_attempt_id TEXT NOT NULL,
        target_attempt_id TEXT NOT NULL,
        source_lineage_id TEXT NOT NULL REFERENCES harness_lineages(lineage_id),
        target_lineage_id TEXT NOT NULL REFERENCES harness_lineages(lineage_id),
        mode TEXT NOT NULL CHECK(mode IN ('prepared_process_adopted','fresh_process_fallback')),
        recorded_at TEXT NOT NULL
      );
      CREATE UNIQUE INDEX physical_process_transitions_target_attempt ON physical_process_transitions(target_attempt_id);
      PRAGMA user_version = ${DISPATCH_REGISTRY_SCHEMA_VERSION};
      COMMIT;
    `);
  }

  private validateCurrentSchema(): void {
    const expected = {
      harness_lineages: [
        "lineage_id",
        "logical_lineage_id",
        "configuration_json",
        "configuration_hash",
        "provider",
        "harness_kind",
        "session_state",
        "capabilities_json",
        "attention_json",
        "intervention_json",
        "started_at",
        "last_activity_at",
        "result_control_path",
        "ownership_token",
        "active_action_id",
        "execution_handle_json",
        "transport_binding_json",
        "native_session_json",
        "interactive_json",
        "created_at",
        "updated_at",
      ],
      dispatches: [
        "action_id",
        "run_id",
        "occurrence_id",
        "attempt_id",
        "semantic_step_key",
        "action_json",
        "action_hash",
        "state",
        "lineage_id",
        "result_nonce",
        "result_directory",
        "completion_requirement_json",
        "outputs_json",
        "failure_json",
        "prompt_intent_at",
        "prompt_accepted_at",
        "native_activity_at",
        "provider_turn_settled_at",
        "native_idle_at",
        "structured_result_received_at",
        "stalled_at",
        "settled_at",
        "prompt_evidence_json",
        "prompt_authorized_at",
        "server_acknowledged_at",
        "created_at",
        "updated_at",
      ],
      physical_process_transitions: [
        "target_action_id",
        "source_action_id",
        "source_attempt_id",
        "target_attempt_id",
        "source_lineage_id",
        "target_lineage_id",
        "mode",
        "recorded_at",
      ],
    } as const;
    const expectedTables = Object.keys(expected).sort();
    const actualTables = this.userTables();
    if (JSON.stringify(actualTables) !== JSON.stringify(expectedTables))
      throw new IncompatibleWorkerDatabaseError(
        this.databasePath,
        `expected tables ${expectedTables.join(", ")}; found ${actualTables.join(", ") || "none"}`,
      );
    for (const [table, expectedColumns] of Object.entries(expected)) {
      const actualColumns = (
        this.db.query(`PRAGMA table_info(${table})`).all() as Array<{
          name: string;
        }>
      ).map((column) => column.name);
      if (JSON.stringify(actualColumns) !== JSON.stringify(expectedColumns))
        throw new IncompatibleWorkerDatabaseError(
          this.databasePath,
          `${table} does not match the current bootstrap schema`,
        );
    }
    const foreignKeyFailures = this.db
      .query("PRAGMA foreign_key_check")
      .all() as unknown[];
    if (foreignKeyFailures.length > 0)
      throw new IncompatibleWorkerDatabaseError(
        this.databasePath,
        "foreign-key validation failed",
      );
  }

  private schemaVersion(): number {
    return (
      this.db.query("PRAGMA user_version").get() as { user_version: number }
    ).user_version;
  }

  private userTables(): string[] {
    return (
      this.db
        .query(
          "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
        )
        .all() as Array<{ name: string }>
    ).map((row) => row.name);
  }
}

function mapDispatch(row: DispatchRow): DispatchRecord {
  return {
    action: JSON.parse(row.action_json) as ExecuteAction,
    state: row.state,
    lineageId: row.lineage_id,
    resultNonce: row.result_nonce,
    resultDirectory: row.result_directory,
    completionRequirement: row.completion_requirement_json
      ? (JSON.parse(
          row.completion_requirement_json,
        ) as StructuredCompletionRequirement)
      : structuredCompletionRequirement(
          JSON.parse(row.action_json) as ExecuteAction,
        ),
    outputs: row.outputs_json
      ? (JSON.parse(row.outputs_json) as Record<string, JsonValue>)
      : null,
    failure: row.failure_json
      ? (JSON.parse(row.failure_json) as Record<string, JsonValue>)
      : null,
    promptIntentAt: row.prompt_intent_at,
    promptAcceptedAt: row.prompt_accepted_at,
    nativeActivityAt: row.native_activity_at,
    providerTurnSettledAt: row.provider_turn_settled_at,
    nativeIdleAt: row.native_idle_at,
    structuredResultReceivedAt: row.structured_result_received_at,
    stalledAt: row.stalled_at,
    settledAt: row.settled_at,
    promptEvidence: row.prompt_evidence_json
      ? (JSON.parse(row.prompt_evidence_json) as Record<string, JsonValue>)
      : null,
    promptAuthorizedAt: row.prompt_authorized_at,
    serverAcknowledgedAt: row.server_acknowledged_at,
  };
}
function mapPhysicalProcessTransition(
  row: PhysicalProcessTransitionRow,
): PhysicalProcessTransition {
  return {
    sourceActionId: row.source_action_id,
    sourceAttemptId: row.source_attempt_id,
    targetActionId: row.target_action_id,
    targetAttemptId: row.target_attempt_id,
    sourceLineageId: row.source_lineage_id,
    targetLineageId: row.target_lineage_id,
    mode: row.mode,
    recordedAt: row.recorded_at,
  };
}
function persistedExecutionHandle(
  row: LineageRow,
): HarnessExecutionHandle | null {
  if (!row.execution_handle_json) {
    if (
      row.native_session_json ||
      row.transport_binding_json ||
      row.interactive_json
    )
      throw new Error(
        "Persisted harness recovery state has no execution handle.",
      );
    return null;
  }
  return parseHarnessExecutionHandle(
    row.execution_handle_json,
    row.harness_kind,
    row.lineage_id,
  );
}

function persistedCapabilities(serialized: string): HarnessCapabilities {
  let value: unknown;
  try {
    value = JSON.parse(serialized);
  } catch {
    throw new Error("Persisted harness capabilities are malformed.");
  }
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Persisted harness capabilities are invalid.");
  const record = value as Record<string, unknown>;
  const expected = Object.keys(defaultHarnessCapabilities()).sort();
  const actual = Object.keys(record).sort();
  if (
    JSON.stringify(actual) !== JSON.stringify(expected) ||
    Object.values(record).some((item) => typeof item !== "boolean")
  )
    throw new Error("Persisted harness capabilities are invalid.");
  return record as unknown as HarnessCapabilities;
}

function mapLineage(row: LineageRow): HarnessLineage {
  const capabilities = persistedCapabilities(row.capabilities_json);
  const transportBinding = parseTransportBinding(
    row.transport_binding_json,
    row.harness_kind,
  );
  const nativeSession = parseNativeSessionRef(
    row.native_session_json,
    row.harness_kind,
  );
  const executionHandle = persistedExecutionHandle(row);
  const interactive = row.interactive_json
    ? validateInteractiveHarnessSession(JSON.parse(row.interactive_json))
    : null;
  return {
    lineageId: row.lineage_id,
    logicalLineageId: row.logical_lineage_id,
    configurationJson: row.configuration_json,
    provider: row.provider,
    harnessKind: row.harness_kind,
    sessionState: row.session_state,
    capabilities,
    attention: row.attention_json
      ? (JSON.parse(row.attention_json) as HumanAttention)
      : null,
    intervention: row.intervention_json
      ? (JSON.parse(row.intervention_json) as HumanInterventionLifecycle)
      : null,
    startedAt: row.started_at,
    lastActivityAt: row.last_activity_at,
    resultControlPath: row.result_control_path,
    ownershipToken: row.ownership_token,
    activeActionId: row.active_action_id,
    executionHandle,
    nativeSession,
    transportBinding,
    interactive,
  };
}
export type TurnLifecyclePhase =
  | "preparing"
  | "prompt_intent"
  | "waiting_for_activity"
  | "working"
  | "awaiting_result"
  | "blocked"
  | "stalled"
  | "settled"
  | "uncertain";

export function isRecoverableObservationUncertainty(
  dispatch: Pick<DispatchRecord, "state" | "failure">,
): boolean {
  if (dispatch.state !== "uncertain") return false;
  const failure = dispatch.failure;
  if (failure?.code !== "timeout") return false;
  return (
    failure.capability === "session.inventory" ||
    failure.message === "Herdr request timed out: session.snapshot"
  );
}

export function turnLifecycle(
  dispatch: DispatchRecord,
  sessionState?: HarnessSessionState,
  attention: HumanAttention | null = null,
): {
  phase: TurnLifecyclePhase;
  promptIntentAt: string | null;
  promptAcceptedAt: string | null;
  nativeActivityAt: string | null;
  providerTurnSettledAt: string | null;
  nativeIdleAt: string | null;
  structuredResultReceivedAt: string | null;
  stalledAt: string | null;
  settledAt: string | null;
} {
  const phase: TurnLifecyclePhase =
    dispatch.state === "completed" ||
    dispatch.state === "failed" ||
    dispatch.settledAt
      ? "settled"
      : dispatch.state === "uncertain"
        ? "uncertain"
        : attention || sessionState === "waiting_for_human"
          ? "blocked"
          : dispatch.nativeIdleAt
            ? "awaiting_result"
            : dispatch.nativeActivityAt
              ? "working"
              : sessionState === "stalled" || dispatch.stalledAt
                ? "stalled"
                : dispatch.promptAcceptedAt
                  ? "waiting_for_activity"
                  : dispatch.promptIntentAt
                    ? "prompt_intent"
                    : "preparing";
  return {
    phase,
    promptIntentAt: dispatch.promptIntentAt,
    promptAcceptedAt: dispatch.promptAcceptedAt,
    nativeActivityAt: dispatch.nativeActivityAt,
    providerTurnSettledAt: dispatch.providerTurnSettledAt,
    nativeIdleAt: dispatch.nativeIdleAt,
    structuredResultReceivedAt: dispatch.structuredResultReceivedAt,
    stalledAt: dispatch.stalledAt,
    settledAt: dispatch.settledAt,
  };
}

export function structuredCompletionRequirement(
  action: ExecuteAction,
): StructuredCompletionRequirement {
  const outputs = action.execution.work.declared_outputs.map((output) => ({
    name: output.name,
    kind: output.kind,
  }));
  if (
    JSON.stringify(outputs.map((output) => output.name)) !==
    JSON.stringify(action.declared_outputs)
  )
    throw new Error(
      `Action ${action.action_id} has inconsistent typed output declarations.`,
    );
  return {
    structuredResultRequired: true,
    outputs,
    physicalExportRequired: outputs.some(
      (output) => output.kind === "change_set",
    ),
  };
}

export function physicalConfiguration(action: ExecuteAction): string {
  const configuration = action.execution.configuration;
  return canonicalJson({
    harness_kind: configuration.harness_kind,
    model: configuration.model,
    reasoning: configuration.reasoning,
    reasoning_capability: configuration.reasoning_capability,
    tool_policy: configuration.tool_policy,
    tool_enforcement: configuration.tool_enforcement,
    resolved_tool_profile: {
      tools: [...configuration.resolved_tool_profile.tools].sort(),
    },
    logical_workspace_id: action.execution.logical_workspace.workspace_id,
    workspace_binding_id:
      action.execution.execution_workspace.workspace_binding_id,
    worktree_id: action.execution.execution_workspace.worktree_id,
    workspace_root: action.execution.execution_workspace.canonical_root,
    workspace_access: action.execution.execution_workspace.access,
  });
}
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, nested]) => `${JSON.stringify(key)}:${canonicalJson(nested)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}
function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
function now(): string {
  return new Date().toISOString();
}

function defaultHarnessCapabilities(): HarnessCapabilities {
  return {
    structuredResult: false,
    continuation: true,
    retainedSessionRecovery: true,
    structuredAttention: false,
    nativeBlocking: true,
    canAttachTerminal: true,
    canSendInput: true,
    canInterrupt: true,
    canDetectAttention: true,
    canResume: true,
    canObserveStructuredEvents: true,
    structuredConfirmation: false,
    structuredTextResponse: false,
    structuredChoiceResponse: false,
    structuredMultilineResponse: false,
    nativePromptControl: false,
    conversationalTakeover: false,
    automationResume: false,
  };
}
