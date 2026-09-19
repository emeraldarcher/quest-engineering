import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type {
  HarnessCapabilities,
  HarnessSessionState,
  HumanAttention,
  HumanInterventionLifecycle,
} from "../harnesses/types.ts";
import type {
  ExecuteAction,
  JsonValue,
  LocalDispatchState,
  ReconcileDispatch,
} from "../protocol/types.ts";
import type { NativeSessionRef } from "../session-host/types.ts";

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
  herdrSession: string | null;
  herdrSessionIncarnation: string | null;
  workspaceId: string | null;
  tabId: string | null;
  paneId: string | null;
  terminalId: string | null;
  agentName: string | null;
  nativeSession: NativeSessionRef | null;
}

export interface DispatchRecord {
  action: ExecuteAction;
  state: LocalDispatchState;
  lineageId: string | null;
  resultNonce: string;
  resultDirectory: string;
  outputs: Record<string, JsonValue> | null;
  failure: Record<string, JsonValue> | null;
  promptIntentAt: string | null;
  promptAcceptedAt: string | null;
  nativeActivityAt: string | null;
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
  herdrSession: string | null;
  herdrSessionIncarnation: string | null;
  workspaceId: string | null;
  paneId: string | null;
  terminalId: string | null;
  agentName: string | null;
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
  herdr_session: string | null;
  herdr_session_incarnation: string | null;
  workspace_id: string | null;
  pane_id: string | null;
  terminal_id: string | null;
  agent_name: string | null;
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
  outputs_json: string | null;
  failure_json: string | null;
  prompt_intent_at: string | null;
  prompt_accepted_at: string | null;
  native_activity_at: string | null;
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
  herdr_session: string | null;
  herdr_session_incarnation: string | null;
  workspace_id: string | null;
  tab_id: string | null;
  pane_id: string | null;
  terminal_id: string | null;
  agent_name: string | null;
  native_session_json: string | null;
}

export class IncompatibleContinuationConfigurationError extends Error {
  readonly code = "incompatible_continuation_configuration";
  constructor(logicalLineageId: string) {
    super(
      `Continuation configuration differs for logical lineage ${logicalLineageId}.`,
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
    this.migrate();
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
            .query("SELECT * FROM provider_lineages WHERE lineage_id=?")
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
            .query(`INSERT INTO provider_lineages
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
        (action_id,run_id,occurrence_id,attempt_id,semantic_step_key,action_json,action_hash,state,lineage_id,result_nonce,result_directory,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`)
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
          if (
            !lineage.herdrSession ||
            !lineage.herdrSessionIncarnation ||
            !lineage.workspaceId ||
            !lineage.paneId ||
            !lineage.agentName
          )
            throw new Error(
              `Adopted lineage ${lineage.lineageId} has incomplete physical identity.`,
            );
          this.recordHost(lineage.lineageId, {
            herdrSession: lineage.herdrSession,
            ...(lineage.herdrSessionIncarnation
              ? {
                  herdrSessionIncarnation: lineage.herdrSessionIncarnation,
                }
              : {}),
            workspaceId: lineage.workspaceId,
            ...(lineage.tabId ? { tabId: lineage.tabId } : {}),
            paneId: lineage.paneId,
            ...(lineage.terminalId ? { terminalId: lineage.terminalId } : {}),
            agentName: lineage.agentName,
            ...(lineage.nativeSession
              ? { nativeSession: lineage.nativeSession }
              : {}),
          });
          return this.get(input.action.action_id);
        }
        this.db
          .query(`INSERT INTO provider_lineages
        (lineage_id,logical_lineage_id,configuration_json,configuration_hash,provider,harness_kind,session_state,capabilities_json,attention_json,intervention_json,started_at,last_activity_at,result_control_path,ownership_token,active_action_id,herdr_session,herdr_session_incarnation,workspace_id,tab_id,pane_id,terminal_id,agent_name,native_session_json,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(lineage_id) DO NOTHING`)
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
            lineage.herdrSession,
            lineage.herdrSessionIncarnation,
            lineage.workspaceId,
            lineage.tabId,
            lineage.paneId,
            lineage.terminalId,
            lineage.agentName,
            lineage.nativeSession
              ? JSON.stringify(lineage.nativeSession)
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
            `UPDATE provider_lineages SET active_action_id=?,herdr_session=?,herdr_session_incarnation=?,workspace_id=?,tab_id=?,pane_id=?,terminal_id=?,agent_name=?,native_session_json=?,updated_at=? WHERE lineage_id=?`,
          )
          .run(
            input.action.action_id,
            lineage.herdrSession,
            lineage.herdrSessionIncarnation,
            lineage.workspaceId,
            lineage.tabId,
            lineage.paneId,
            lineage.terminalId,
            lineage.agentName,
            lineage.nativeSession
              ? JSON.stringify(lineage.nativeSession)
              : null,
            now(),
            lineage.lineageId,
          );
        const actionJson = canonicalJson(input.action);
        this.db
          .query(`INSERT INTO dispatches
        (action_id,run_id,occurrence_id,attempt_id,semantic_step_key,action_json,action_hash,state,lineage_id,result_nonce,result_directory,prompt_intent_at,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
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
      .query("SELECT * FROM provider_lineages WHERE logical_lineage_id=?")
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
      .query("SELECT * FROM provider_lineages WHERE lineage_id=?")
      .get(lineageId) as LineageRow | null;
    if (!row) throw new Error(`Unknown harness lineage: ${lineageId}`);
    return mapLineage(row);
  }

  listLineages(): HarnessLineage[] {
    return (
      this.db
        .query("SELECT * FROM provider_lineages ORDER BY rowid")
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
            "UPDATE provider_lineages SET active_action_id=?,intervention_json=CASE WHEN active_action_id=? THEN intervention_json ELSE NULL END,updated_at=? WHERE lineage_id=?",
          )
          .run(actionId, actionId, now(), lineageId);
      })
      .immediate();
  }

  recordHost(
    lineageId: string,
    input: {
      herdrSession: string;
      herdrSessionIncarnation?: string;
      workspaceId: string;
      tabId?: string;
      paneId: string;
      terminalId?: string;
      agentName: string;
      nativeSession?: NativeSessionRef;
    },
  ): void {
    this.db
      .query(`UPDATE provider_lineages SET
      herdr_session=?,herdr_session_incarnation=COALESCE(?,herdr_session_incarnation),workspace_id=?,tab_id=?,pane_id=?,terminal_id=?,agent_name=?,native_session_json=?,updated_at=?
      WHERE lineage_id=?`)
      .run(
        input.herdrSession,
        input.herdrSessionIncarnation ?? null,
        input.workspaceId,
        input.tabId ?? null,
        input.paneId,
        input.terminalId ?? null,
        input.agentName,
        input.nativeSession ? JSON.stringify(input.nativeSession) : null,
        now(),
        lineageId,
      );
  }

  recordNativeSession(
    lineageId: string,
    nativeSession: NativeSessionRef,
  ): void {
    this.db
      .query(
        "UPDATE provider_lineages SET native_session_json=?,last_activity_at=?,updated_at=? WHERE lineage_id=?",
      )
      .run(JSON.stringify(nativeSession), now(), now(), lineageId);
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
        "UPDATE provider_lineages SET session_state=?,attention_json=?,intervention_json=COALESCE(?,intervention_json),last_activity_at=?,updated_at=? WHERE lineage_id=?",
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
            "UPDATE provider_lineages SET active_action_id=?,session_state='starting',attention_json=NULL,intervention_json=NULL,last_activity_at=?,updated_at=? WHERE lineage_id=? AND active_action_id IS NULL",
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
            "UPDATE provider_lineages SET logical_lineage_id=?,updated_at=? WHERE lineage_id=? AND active_action_id IS NULL",
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
          .query(`INSERT INTO provider_lineages
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
        "SELECT logical_lineage_id,session_state,active_action_id FROM provider_lineages WHERE lineage_id=?",
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
        (source_action_id,source_attempt_id,target_action_id,target_attempt_id,source_lineage_id,target_lineage_id,mode,herdr_session,herdr_session_incarnation,workspace_id,pane_id,terminal_id,agent_name,recorded_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(
        input.source.action.action_id,
        input.source.action.attempt_id,
        input.target.action.action_id,
        input.target.action.attempt_id,
        input.sourceLineage.lineageId,
        input.targetLineageId,
        input.mode,
        input.sourceLineage.herdrSession,
        input.sourceLineage.herdrSessionIncarnation,
        input.sourceLineage.workspaceId,
        input.sourceLineage.paneId,
        input.sourceLineage.terminalId,
        input.sourceLineage.agentName,
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
        "UPDATE dispatches SET native_activity_at=COALESCE(native_activity_at,?),state=CASE WHEN state='accepted' THEN 'running' ELSE state END,updated_at=? WHERE action_id=?",
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
            "UPDATE provider_lineages SET active_action_id=NULL,session_state='retained',attention_json=NULL,last_activity_at=?,updated_at=? WHERE lineage_id=? AND active_action_id=?",
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
              "UPDATE provider_lineages SET active_action_id=NULL,session_state='retained',attention_json=NULL,last_activity_at=?,updated_at=? WHERE lineage_id=? AND active_action_id=?",
            )
            .run(now(), now(), dispatch.lineageId, actionId);
        }
        return this.get(actionId);
      })
      .immediate();
  }

  acknowledgeServerCompletion(actionId: string): void {
    this.db
      .query(
        "UPDATE dispatches SET server_acknowledged_at=COALESCE(server_acknowledged_at,?),updated_at=? WHERE action_id=? AND state='completed'",
      )
      .run(now(), now(), actionId);
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
      .query("SELECT * FROM provider_lineages WHERE logical_lineage_id=?")
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
          "UPDATE provider_lineages SET active_action_id=NULL,session_state='retained',attention_json=NULL,last_activity_at=?,updated_at=? WHERE lineage_id=? AND active_action_id=?",
        )
        .run(now(), now(), existing.lineage_id, previous.action_id);
    this.db
      .query(
        "UPDATE provider_lineages SET logical_lineage_id=?,updated_at=? WHERE lineage_id=?",
      )
      .run(`retired:${existing.lineage_id}`, now(), existing.lineage_id);
  }

  private row(actionId: string): DispatchRow | null {
    return this.db
      .query("SELECT * FROM dispatches WHERE action_id=?")
      .get(actionId) as DispatchRow | null;
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS provider_lineages (
        lineage_id TEXT PRIMARY KEY,
        logical_lineage_id TEXT NOT NULL UNIQUE,
        configuration_json TEXT NOT NULL,
        configuration_hash TEXT NOT NULL,
        provider TEXT NOT NULL,
        harness_kind TEXT NOT NULL DEFAULT 'pi',
        session_state TEXT NOT NULL DEFAULT 'starting',
        capabilities_json TEXT NOT NULL DEFAULT '{}',
        attention_json TEXT,
        intervention_json TEXT,
        started_at TEXT NOT NULL DEFAULT '',
        last_activity_at TEXT NOT NULL DEFAULT '',
        result_control_path TEXT NOT NULL UNIQUE,
        ownership_token TEXT NOT NULL UNIQUE,
        active_action_id TEXT,
        herdr_session TEXT,
        herdr_session_incarnation TEXT,
        workspace_id TEXT,
        tab_id TEXT,
        pane_id TEXT,
        terminal_id TEXT,
        agent_name TEXT,
        native_session_json TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS dispatches (
        action_id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        occurrence_id TEXT NOT NULL,
        attempt_id TEXT NOT NULL,
        semantic_step_key TEXT NOT NULL,
        action_json TEXT NOT NULL,
        action_hash TEXT NOT NULL,
        state TEXT NOT NULL CHECK(state IN ('accepted','running','completed','failed','uncertain')),
        lineage_id TEXT REFERENCES provider_lineages(lineage_id),
        result_nonce TEXT NOT NULL,
        result_directory TEXT NOT NULL,
        outputs_json TEXT,
        failure_json TEXT,
        prompt_intent_at TEXT,
        prompt_accepted_at TEXT,
        native_activity_at TEXT,
        stalled_at TEXT,
        settled_at TEXT,
        prompt_evidence_json TEXT,
        prompt_authorized_at TEXT,
        server_acknowledged_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS dispatches_occurrence_id ON dispatches(occurrence_id);
      CREATE INDEX IF NOT EXISTS dispatches_attempt_id ON dispatches(attempt_id);
      CREATE INDEX IF NOT EXISTS dispatches_run_occurrence ON dispatches(run_id,occurrence_id);
      CREATE INDEX IF NOT EXISTS dispatches_state ON dispatches(state);
      CREATE TABLE IF NOT EXISTS physical_process_transitions (
        target_action_id TEXT PRIMARY KEY,
        source_action_id TEXT NOT NULL,
        source_attempt_id TEXT NOT NULL,
        target_attempt_id TEXT NOT NULL,
        source_lineage_id TEXT NOT NULL,
        target_lineage_id TEXT NOT NULL,
        mode TEXT NOT NULL CHECK(mode IN ('prepared_process_adopted','fresh_process_fallback')),
        herdr_session TEXT,
        herdr_session_incarnation TEXT,
        workspace_id TEXT,
        pane_id TEXT,
        terminal_id TEXT,
        agent_name TEXT,
        recorded_at TEXT NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS physical_process_transitions_target_attempt ON physical_process_transitions(target_attempt_id);
    `);
    this.ensureColumn("provider_lineages", "logical_lineage_id", "TEXT");
    this.ensureColumn("provider_lineages", "configuration_json", "TEXT");
    this.ensureColumn("provider_lineages", "configuration_hash", "TEXT");
    this.ensureColumn(
      "provider_lineages",
      "harness_kind",
      "TEXT NOT NULL DEFAULT 'pi'",
    );
    this.ensureColumn(
      "provider_lineages",
      "session_state",
      "TEXT NOT NULL DEFAULT 'starting'",
    );
    this.ensureColumn(
      "provider_lineages",
      "capabilities_json",
      "TEXT NOT NULL DEFAULT '{}'",
    );
    this.ensureColumn("provider_lineages", "attention_json", "TEXT");
    this.ensureColumn("provider_lineages", "intervention_json", "TEXT");
    this.ensureColumn("provider_lineages", "herdr_session_incarnation", "TEXT");
    this.ensureColumn("dispatches", "prompt_accepted_at", "TEXT");
    this.ensureColumn("dispatches", "native_activity_at", "TEXT");
    this.ensureColumn("dispatches", "stalled_at", "TEXT");
    this.ensureColumn("dispatches", "settled_at", "TEXT");
    this.ensureColumn("dispatches", "prompt_evidence_json", "TEXT");
    this.ensureColumn("dispatches", "prompt_authorized_at", "TEXT");
    this.ensureColumn(
      "provider_lineages",
      "started_at",
      "TEXT NOT NULL DEFAULT ''",
    );
    this.ensureColumn(
      "provider_lineages",
      "last_activity_at",
      "TEXT NOT NULL DEFAULT ''",
    );
    const timestamp = now();
    this.db
      .query(
        "UPDATE provider_lineages SET harness_kind=COALESCE(NULLIF(harness_kind,''),'pi'),session_state=COALESCE(NULLIF(session_state,''),'starting'),capabilities_json=CASE WHEN capabilities_json='{}' THEN ? ELSE capabilities_json END,started_at=COALESCE(NULLIF(started_at,''),created_at,?),last_activity_at=COALESCE(NULLIF(last_activity_at,''),updated_at,?)",
      )
      .run(
        JSON.stringify(
          typeof this.harnessCapabilities === "function"
            ? defaultHarnessCapabilities()
            : this.harnessCapabilities,
        ),
        timestamp,
        timestamp,
      );
    const capabilityRows = this.db
      .query(
        "SELECT lineage_id,harness_kind,capabilities_json FROM provider_lineages",
      )
      .all() as Array<{
      lineage_id: string;
      harness_kind: string;
      capabilities_json: string;
    }>;
    for (const row of capabilityRows) {
      const persisted = JSON.parse(
        row.capabilities_json,
      ) as Partial<HarnessCapabilities>;
      // Existing live Pi processes were launched with their original extension
      // set. Missing capability fields must remain false; only newly-created
      // lineages may advertise conversational takeover.
      const upgraded = {
        ...defaultHarnessCapabilities(),
        ...persisted,
      };
      this.db
        .query(
          "UPDATE provider_lineages SET capabilities_json=? WHERE lineage_id=?",
        )
        .run(JSON.stringify(upgraded), row.lineage_id);
    }
    this.removeLegacyPiProviderConstraint();
    this.db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS provider_lineages_logical_lineage ON provider_lineages(logical_lineage_id) WHERE logical_lineage_id IS NOT NULL;
      CREATE INDEX IF NOT EXISTS dispatches_occurrence_id ON dispatches(occurrence_id);
      CREATE INDEX IF NOT EXISTS dispatches_attempt_id ON dispatches(attempt_id);
      CREATE INDEX IF NOT EXISTS dispatches_run_occurrence ON dispatches(run_id,occurrence_id);
      CREATE INDEX IF NOT EXISTS dispatches_state ON dispatches(state);
    `);
  }

  private removeLegacyPiProviderConstraint(): void {
    const row = this.db
      .query(
        "SELECT sql FROM sqlite_master WHERE type='table' AND name='provider_lineages'",
      )
      .get() as { sql: string } | null;
    if (!row?.sql.includes("CHECK(provider='pi')")) return;
    this.db.exec(`
      PRAGMA foreign_keys=OFF;
      DROP INDEX IF EXISTS dispatches_occurrence_id;
      DROP INDEX IF EXISTS dispatches_attempt_id;
      DROP INDEX IF EXISTS dispatches_run_occurrence;
      DROP INDEX IF EXISTS dispatches_state;
      DROP INDEX IF EXISTS provider_lineages_logical_lineage;
      BEGIN IMMEDIATE;
      ALTER TABLE dispatches RENAME TO dispatches_pi_legacy;
      ALTER TABLE provider_lineages RENAME TO provider_lineages_pi_legacy;
      CREATE TABLE provider_lineages (
        lineage_id TEXT PRIMARY KEY,
        logical_lineage_id TEXT NOT NULL UNIQUE,
        configuration_json TEXT NOT NULL,
        configuration_hash TEXT NOT NULL,
        provider TEXT NOT NULL,
        harness_kind TEXT NOT NULL,
        session_state TEXT NOT NULL,
        capabilities_json TEXT NOT NULL,
        attention_json TEXT,
        intervention_json TEXT,
        started_at TEXT NOT NULL,
        last_activity_at TEXT NOT NULL,
        result_control_path TEXT NOT NULL UNIQUE,
        ownership_token TEXT NOT NULL UNIQUE,
        active_action_id TEXT,
        herdr_session TEXT,
        herdr_session_incarnation TEXT,
        workspace_id TEXT,
        tab_id TEXT,
        pane_id TEXT,
        terminal_id TEXT,
        agent_name TEXT,
        native_session_json TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      INSERT INTO provider_lineages
        (lineage_id,logical_lineage_id,configuration_json,configuration_hash,provider,harness_kind,session_state,capabilities_json,attention_json,intervention_json,started_at,last_activity_at,result_control_path,ownership_token,active_action_id,herdr_session,herdr_session_incarnation,workspace_id,tab_id,pane_id,terminal_id,agent_name,native_session_json,created_at,updated_at)
      SELECT lineage_id,logical_lineage_id,configuration_json,configuration_hash,provider,harness_kind,session_state,capabilities_json,attention_json,intervention_json,started_at,last_activity_at,result_control_path,ownership_token,active_action_id,herdr_session,herdr_session_incarnation,workspace_id,tab_id,pane_id,terminal_id,agent_name,native_session_json,created_at,updated_at
      FROM provider_lineages_pi_legacy;
      CREATE TABLE dispatches (
        action_id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        occurrence_id TEXT NOT NULL,
        attempt_id TEXT NOT NULL,
        semantic_step_key TEXT NOT NULL,
        action_json TEXT NOT NULL,
        action_hash TEXT NOT NULL,
        state TEXT NOT NULL CHECK(state IN ('accepted','running','completed','failed','uncertain')),
        lineage_id TEXT REFERENCES provider_lineages(lineage_id),
        result_nonce TEXT NOT NULL,
        result_directory TEXT NOT NULL,
        outputs_json TEXT,
        failure_json TEXT,
        prompt_intent_at TEXT,
        prompt_accepted_at TEXT,
        native_activity_at TEXT,
        stalled_at TEXT,
        settled_at TEXT,
        prompt_evidence_json TEXT,
        prompt_authorized_at TEXT,
        server_acknowledged_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      INSERT INTO dispatches
        (action_id,run_id,occurrence_id,attempt_id,semantic_step_key,action_json,action_hash,state,lineage_id,result_nonce,result_directory,outputs_json,failure_json,prompt_intent_at,prompt_accepted_at,native_activity_at,stalled_at,settled_at,prompt_evidence_json,prompt_authorized_at,server_acknowledged_at,created_at,updated_at)
      SELECT action_id,run_id,occurrence_id,attempt_id,semantic_step_key,action_json,action_hash,state,lineage_id,result_nonce,result_directory,outputs_json,failure_json,prompt_intent_at,prompt_accepted_at,native_activity_at,stalled_at,settled_at,prompt_evidence_json,prompt_authorized_at,server_acknowledged_at,created_at,updated_at FROM dispatches_pi_legacy;
      DROP TABLE dispatches_pi_legacy;
      DROP TABLE provider_lineages_pi_legacy;
      COMMIT;
      PRAGMA foreign_keys=ON;
    `);
  }

  private ensureColumn(
    table: string,
    column: string,
    definition: string,
  ): void {
    const columns = this.db
      .query(`PRAGMA table_info(${table})`)
      .all() as Array<{ name: string }>;
    if (!columns.some((item) => item.name === column))
      this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

function mapDispatch(row: DispatchRow): DispatchRecord {
  return {
    action: JSON.parse(row.action_json) as ExecuteAction,
    state: row.state,
    lineageId: row.lineage_id,
    resultNonce: row.result_nonce,
    resultDirectory: row.result_directory,
    outputs: row.outputs_json
      ? (JSON.parse(row.outputs_json) as Record<string, JsonValue>)
      : null,
    failure: row.failure_json
      ? (JSON.parse(row.failure_json) as Record<string, JsonValue>)
      : null,
    promptIntentAt: row.prompt_intent_at,
    promptAcceptedAt: row.prompt_accepted_at,
    nativeActivityAt: row.native_activity_at,
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
    herdrSession: row.herdr_session,
    herdrSessionIncarnation: row.herdr_session_incarnation,
    workspaceId: row.workspace_id,
    paneId: row.pane_id,
    terminalId: row.terminal_id,
    agentName: row.agent_name,
    recordedAt: row.recorded_at,
  };
}
function mapLineage(row: LineageRow): HarnessLineage {
  return {
    lineageId: row.lineage_id,
    logicalLineageId: row.logical_lineage_id,
    configurationJson: row.configuration_json,
    provider: row.provider,
    harnessKind: row.harness_kind,
    sessionState: row.session_state,
    capabilities: {
      ...defaultHarnessCapabilities(),
      ...(JSON.parse(row.capabilities_json) as Partial<HarnessCapabilities>),
    },
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
    herdrSession: row.herdr_session,
    herdrSessionIncarnation: row.herdr_session_incarnation,
    workspaceId: row.workspace_id,
    tabId: row.tab_id,
    paneId: row.pane_id,
    terminalId: row.terminal_id,
    agentName: row.agent_name,
    nativeSession: row.native_session_json
      ? (JSON.parse(row.native_session_json) as NativeSessionRef)
      : null,
  };
}
export type TurnLifecyclePhase =
  | "preparing"
  | "prompt_intent"
  | "waiting_for_activity"
  | "working"
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
  stalledAt: string | null;
  settledAt: string | null;
} {
  const phase: TurnLifecyclePhase =
    dispatch.state === "completed" || dispatch.settledAt
      ? "settled"
      : dispatch.state === "uncertain"
        ? "uncertain"
        : attention || sessionState === "waiting_for_human"
          ? "blocked"
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
    stalledAt: dispatch.stalledAt,
    settledAt: dispatch.settledAt,
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
