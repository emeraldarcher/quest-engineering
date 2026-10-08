import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import {
  DISPATCH_REGISTRY_SCHEMA_VERSION,
  DispatchRegistry,
  IncompatibleWorkerDatabaseError,
  turnLifecycle,
} from "../src/dispatch/registry.ts";
import { nativeSessionRef } from "../src/harnesses/native-session.ts";
import {
  terminalInteractiveSession,
  terminalLineage,
  terminalTransportBinding,
} from "../src/harnesses/terminal-execution.ts";
import { action, recordTerminalExecution } from "./support.ts";

const roots: string[] = [];
async function fixture() {
  const parent = join(process.cwd(), ".pi", "tmp");
  await mkdir(parent, { recursive: true });
  const root = await mkdtemp(join(parent, "bun-worker-registry-"));
  roots.push(root);
  return { root, database: join(root, "dispatches.sqlite") };
}
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("durable dispatch registry", () => {
  test("bootstraps only the current harness-lineage schema", async () => {
    const { root, database } = await fixture();
    const registry = new DispatchRegistry(database, root);
    registry.close();

    const current = new Database(database);
    expect(
      (
        current.query("PRAGMA user_version").get() as {
          user_version: number;
        }
      ).user_version,
    ).toBe(DISPATCH_REGISTRY_SCHEMA_VERSION);
    expect(
      (
        current
          .query(
            "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
          )
          .all() as Array<{ name: string }>
      ).map((row) => row.name),
    ).toEqual([
      "dispatches",
      "harness_lineages",
      "physical_process_transitions",
    ]);
    const lineageColumns = (
      current.query("PRAGMA table_info(harness_lineages)").all() as Array<{
        name: string;
      }>
    ).map((column) => column.name);
    expect(lineageColumns).toContain("execution_handle_json");
    expect(lineageColumns).toContain("transport_binding_json");
    expect(lineageColumns).toContain("native_session_json");
    expect(lineageColumns).toContain("interactive_json");
    expect(lineageColumns).not.toContain("herdr_session");
    expect(lineageColumns).not.toContain("workspace_id");
    expect(lineageColumns).not.toContain("tab_id");
    expect(lineageColumns).not.toContain("pane_id");
    expect(lineageColumns).not.toContain("terminal_id");
    expect(lineageColumns).not.toContain("agent_name");
    const transitionColumns = (
      current
        .query("PRAGMA table_info(physical_process_transitions)")
        .all() as Array<{ name: string }>
    ).map((column) => column.name);
    expect(transitionColumns).toEqual([
      "target_action_id",
      "source_action_id",
      "source_attempt_id",
      "target_attempt_id",
      "source_lineage_id",
      "target_lineage_id",
      "mode",
      "recorded_at",
    ]);
    current.close();
  });

  test("rejects an obsolete development registry without converting it", async () => {
    const { root, database } = await fixture();
    const obsolete = new Database(database, { create: true });
    obsolete.exec(`
      CREATE TABLE provider_lineages (
        lineage_id TEXT PRIMARY KEY,
        herdr_session TEXT,
        pane_id TEXT
      );
      INSERT INTO provider_lineages (lineage_id, herdr_session, pane_id)
      VALUES ('obsolete-lineage', 'obsolete-herdr', 'obsolete-pane');
    `);
    obsolete.close();

    expect(() => new DispatchRegistry(database, root)).toThrow(
      IncompatibleWorkerDatabaseError,
    );
    expect(() => new DispatchRegistry(database, root)).toThrow(
      "Reset this greenfield development database",
    );

    const unchanged = new Database(database);
    expect(
      unchanged
        .query(
          "SELECT name FROM sqlite_master WHERE type='table' AND name='harness_lineages'",
        )
        .get(),
    ).toBeNull();
    expect(
      unchanged.query("SELECT lineage_id FROM provider_lineages").get(),
    ).toEqual({ lineage_id: "obsolete-lineage" });
    unchanged.close();
  });

  test("rejects malformed, wrong-owner, and oversized persisted bindings", async () => {
    const { root } = await fixture();
    const cases = [
      {
        name: "malformed",
        serialized: "{",
        message: "malformed",
      },
      {
        name: "wrong-owner",
        serialized: JSON.stringify({
          schemaVersion: 1,
          harnessKind: "pi",
          kind: "terminal",
          payload: {},
        }),
        message: "belongs to another harness",
      },
      {
        name: "oversized",
        serialized: JSON.stringify({
          schemaVersion: 1,
          harnessKind: "fake",
          kind: "headless-process",
          payload: { opaque: "x".repeat(33 * 1024) },
        }),
        message: "exceeds the size limit",
      },
    ];
    for (const item of cases) {
      const database = join(root, `${item.name}.sqlite`);
      const registry = new DispatchRegistry(database, root);
      const dispatch = registry.accept(action()).dispatch;
      registry.recordExecution(dispatch.lineageId as string, {
        schemaVersion: 1,
        harnessKind: "fake",
        executionId: dispatch.lineageId as string,
      });
      registry.close();
      const corrupt = new Database(database);
      corrupt
        .query(
          "UPDATE harness_lineages SET transport_binding_json=? WHERE lineage_id=?",
        )
        .run(item.serialized, dispatch.lineageId);
      corrupt.close();
      expect(() => new DispatchRegistry(database, root)).toThrow(item.message);
    }
  });

  test("headless binding and native identity persist without terminal state", async () => {
    const { root, database } = await fixture();
    let registry = new DispatchRegistry(database, root, "fake");
    const dispatch = registry.accept(action()).dispatch;
    const lineageId = dispatch.lineageId as string;
    const nativeSession = nativeSessionRef("fake", "id", "fake-session-1");
    const transportBinding = {
      schemaVersion: 1 as const,
      harnessKind: "fake",
      kind: "streamed-process",
      payload: {
        environmentId: "environment-1",
        processId: "process-1",
        generation: 3,
      },
    };
    registry.recordExecution(
      lineageId,
      {
        schemaVersion: 1,
        harnessKind: "fake",
        executionId: lineageId,
        nativeSession,
        transportBinding,
      },
      null,
    );
    registry.close();

    registry = new DispatchRegistry(database, root, "fake");
    expect(registry.getLineage(lineageId)).toMatchObject({
      lineageId,
      executionHandle: {
        schemaVersion: 1,
        harnessKind: "fake",
        executionId: lineageId,
      },
      nativeSession,
      transportBinding,
      interactive: null,
    });
    registry.close();
  });

  test("durably accepts one Action ID and deduplicates identical delivery", async () => {
    const { root, database } = await fixture();
    const registry = new DispatchRegistry(database, root);
    expect(registry.accept(action()).created).toBe(true);
    expect(registry.accept(action()).created).toBe(false);
    expect(registry.list()).toHaveLength(1);
    expect(() =>
      registry.accept(action({ instruction: "Different work." })),
    ).toThrow("Action-ID conflict");
    registry.close();

    const restarted = new DispatchRegistry(database, root);
    expect(restarted.get("action-1")).toMatchObject({
      state: "accepted",
      action: { attempt_id: "attempt-1" },
    });
    restarted.close();
  });

  test("persists prompt acceptance, native activity, stall, and settlement independently", async () => {
    const { root, database } = await fixture();
    const registry = new DispatchRegistry(database, root);
    const dispatch = registry.accept(action()).dispatch;
    expect(dispatch.completionRequirement).toEqual({
      structuredResultRequired: true,
      outputs: [{ name: "change_set", kind: "change_set" }],
      physicalExportRequired: true,
    });

    registry.markPromptIntent(dispatch.action.action_id);
    registry.recordPromptEvidence(dispatch.action.action_id, {
      kind: "pi_transcript",
      cursor: 42,
      promptHash: "hash",
    });
    expect(turnLifecycle(registry.get(dispatch.action.action_id)).phase).toBe(
      "prompt_intent",
    );

    registry.markPromptAccepted(
      dispatch.action.action_id,
      "2026-09-16T00:00:00.000Z",
    );
    expect(turnLifecycle(registry.get(dispatch.action.action_id)).phase).toBe(
      "waiting_for_activity",
    );

    registry.markStalled(dispatch.action.action_id, "2026-09-16T00:00:30.000Z");
    expect(turnLifecycle(registry.get(dispatch.action.action_id)).phase).toBe(
      "stalled",
    );

    registry.markNativeActivity(
      dispatch.action.action_id,
      "2026-09-16T00:00:31.000Z",
    );
    expect(turnLifecycle(registry.get(dispatch.action.action_id)).phase).toBe(
      "working",
    );
    registry.markProviderTurnSettled(
      dispatch.action.action_id,
      "2026-09-16T00:00:32.000Z",
    );
    registry.markNativeIdle(
      dispatch.action.action_id,
      "2026-09-16T00:00:33.000Z",
    );
    expect(turnLifecycle(registry.get(dispatch.action.action_id)).phase).toBe(
      "awaiting_result",
    );
    expect(
      turnLifecycle(registry.get(dispatch.action.action_id), "unavailable", {
        attentionId: "native-step-18",
        category: "needs_permission",
        message: "RunCommand requires approval in Antigravity.",
        requestedAt: "2026-09-16T00:00:32.000Z",
        interaction: {
          kind: "conversational_intervention",
          controlState: "intervention_pending",
        },
      }).phase,
    ).toBe("blocked");

    registry.markStructuredResultReceived(
      dispatch.action.action_id,
      "2026-09-16T00:00:34.000Z",
    );
    const completed = registry.complete(dispatch.action.action_id, {
      change_set: {},
    });
    expect(turnLifecycle(completed).phase).toBe("settled");
    expect(completed.promptEvidence).toEqual({
      kind: "pi_transcript",
      cursor: 42,
      promptHash: "hash",
    });
    expect(completed).toMatchObject({
      providerTurnSettledAt: "2026-09-16T00:00:32.000Z",
      nativeIdleAt: "2026-09-16T00:00:33.000Z",
      structuredResultReceivedAt: "2026-09-16T00:00:34.000Z",
      settledAt: expect.any(String),
    });

    const failedDispatch = registry.accept(
      action({ action_id: "action-failed", attempt_id: "attempt-failed" }),
    ).dispatch;
    registry.occupy(
      failedDispatch.lineageId as string,
      failedDispatch.action.action_id,
    );
    registry.markPromptIntent(failedDispatch.action.action_id);
    registry.markPromptAccepted(failedDispatch.action.action_id);
    registry.markNativeActivity(failedDispatch.action.action_id);
    const failed = registry.fail(failedDispatch.action.action_id, {
      code: "provider_model_ineligible",
    });
    expect(turnLifecycle(failed).phase).toBe("settled");
    expect(registry.getLineage(failed.lineageId as string).sessionState).toBe(
      "retained",
    );
    registry.close();
  });

  test("indexes occurrence without making it unique", async () => {
    const { root, database } = await fixture();
    const registry = new DispatchRegistry(database, root);
    registry.accept(action());
    registry.accept(action({ action_id: "action-2", attempt_id: "attempt-2" }));
    expect(
      registry
        .listByOccurrence("occurrence-1")
        .map((item) => item.action.attempt_id),
    ).toEqual(["attempt-1", "attempt-2"]);
    registry.close();
  });

  test("continuation reuses a stable lineage control path", async () => {
    const { root, database } = await fixture();
    const registry = new DispatchRegistry(database, root);
    const first = registry.accept(action()).dispatch;
    const lineageId = first.lineageId as string;
    registry.occupy(lineageId, first.action.action_id);
    registry.complete(first.action.action_id, { change_set: { version: 1 } });
    const source = registry.resolveContinuation(first.action);

    const continued = registry.accept(
      action({
        action_id: "action-2",
        occurrence_id: "occurrence-2",
        attempt_id: "attempt-2",
        semantic_step_key: "repair",
        instruction: "Repair the rejected change set.",
        context_requirement: { selector: "continue_from", value: null },
        context_lineage_occurrence_id: first.action.occurrence_id,
      }),
    ).dispatch;
    registry.assignLineage(continued.action.action_id, source.lineageId);

    expect(registry.getLineage(lineageId).resultControlPath).toBe(
      source.resultControlPath,
    );
    expect(registry.get(continued.action.action_id).lineageId).toBe(lineageId);
    expect(registry.get(continued.action.action_id).resultDirectory).not.toBe(
      first.resultDirectory,
    );
    registry.close();
  });

  test("continuation rejects a different immutable physical configuration", async () => {
    const { root, database } = await fixture();
    const registry = new DispatchRegistry(database, root);
    const first = registry.accept(action()).dispatch;
    const lineageId = first.lineageId as string;
    registry.occupy(lineageId, first.action.action_id);
    registry.complete(first.action.action_id, { change_set: {} });
    const continued = action({
      action_id: "continued",
      occurrence_id: "continued-occurrence",
      attempt_id: "continued-attempt",
      context_requirement: { selector: "continue_from", value: null },
      context_lineage_occurrence_id: first.action.occurrence_id,
    });
    continued.execution.configuration = {
      ...continued.execution.configuration,
      reasoning: "high",
    };
    expect(() => registry.resolveContinuation(continued)).toThrow(
      "Continuation configuration differs",
    );
    registry.close();
  });

  test("physical continuation rejects a cross-harness context", async () => {
    const { root, database } = await fixture();
    const registry = new DispatchRegistry(database, root);
    const first = registry.accept(action()).dispatch;
    const lineageId = first.lineageId as string;
    registry.occupy(lineageId, first.action.action_id);
    registry.complete(first.action.action_id, { change_set: {} });
    const continued = action({
      action_id: "continued-other-harness",
      occurrence_id: "continued-other-occurrence",
      attempt_id: "continued-other-attempt",
      context_requirement: { selector: "continue_from", value: null },
      context_lineage_occurrence_id: first.action.occurrence_id,
    });
    continued.execution.configuration.harness_kind = "antigravity";
    expect(() => registry.resolveContinuation(continued)).toThrow(
      "Continuation configuration differs",
    );
    registry.close();
  });

  test("Pi and Antigravity terminal bindings remain validated and fenced after restart", async () => {
    const { root } = await fixture();
    for (const harnessKind of ["pi", "antigravity"] as const) {
      const database = join(root, `${harnessKind}.sqlite`);
      const registry = new DispatchRegistry(database, root, harnessKind);
      const execute = action();
      execute.execution.configuration.harness_kind = harnessKind;
      execute.execution.configuration.model = {
        provider: harnessKind,
        model: `${harnessKind}-test`,
      };
      const dispatch = registry.accept(execute).dispatch;
      const lineageId = dispatch.lineageId as string;
      const nativeSession = nativeSessionRef(
        harnessKind,
        "id",
        `${harnessKind}-native-session`,
      );
      recordTerminalExecution(registry, lineageId, {
        herdrSession: `qe-${harnessKind}-worker-test`,
        herdrSessionIncarnation: `${harnessKind}-session-incarnation-1`,
        workspaceId: `${harnessKind}-workspace-1`,
        tabId: `${harnessKind}-tab-1`,
        paneId: `${harnessKind}-pane-1`,
        terminalId: `${harnessKind}-terminal-1`,
        agentName: `${harnessKind}-agent-1`,
        nativeSession,
      });
      registry.close();

      const durable = new Database(database);
      const persistedJson = durable
        .query(
          "SELECT execution_handle_json,transport_binding_json,native_session_json FROM harness_lineages WHERE lineage_id=?",
        )
        .get(lineageId) as {
        execution_handle_json: string;
        transport_binding_json: string;
        native_session_json: string;
      };
      expect(JSON.parse(persistedJson.execution_handle_json)).toEqual({
        schemaVersion: 1,
        harnessKind,
        executionId: lineageId,
      });
      expect(JSON.parse(persistedJson.transport_binding_json)).toMatchObject({
        schemaVersion: 1,
        harnessKind,
        kind: "terminal",
      });
      expect(JSON.parse(persistedJson.native_session_json)).toEqual(
        nativeSession,
      );
      durable.close();

      const restarted = new DispatchRegistry(database, root, harnessKind);
      const restartedLineage = restarted.getLineage(lineageId);
      expect(restartedLineage).toMatchObject({
        lineageId,
        harnessKind,
        nativeSession,
        executionHandle: {
          schemaVersion: 1,
          harnessKind,
          executionId: lineageId,
        },
        transportBinding: {
          schemaVersion: 1,
          harnessKind,
          kind: "terminal",
        },
        interactive: {
          kind: "terminal",
          processIdentity: "verified",
        },
      });
      expect(terminalLineage(restartedLineage, harnessKind).ref).toMatchObject({
        sessionName: `qe-${harnessKind}-worker-test`,
        sessionIncarnation: `${harnessKind}-session-incarnation-1`,
        workspaceId: `${harnessKind}-workspace-1`,
        tabId: `${harnessKind}-tab-1`,
        paneId: `${harnessKind}-pane-1`,
        terminalId: `${harnessKind}-terminal-1`,
        agentName: `${harnessKind}-agent-1`,
        nativeSession,
      });
      expect(() =>
        terminalLineage(restartedLineage, "another-harness"),
      ).toThrow("belongs to another harness");
      const inconsistentBinding = structuredClone(
        restartedLineage.transportBinding,
      );
      if (!inconsistentBinding)
        throw new Error("Expected persisted terminal binding.");
      (inconsistentBinding.payload.agent as Record<string, unknown>).paneId =
        "replacement-pane";
      expect(() =>
        terminalLineage(
          { ...restartedLineage, transportBinding: inconsistentBinding },
          harnessKind,
        ),
      ).toThrow("topology is internally inconsistent");
      restarted.close();
    }
  });

  test("exact orphan adoption backfills physical identity without rewriting failed history", async () => {
    const { root, database } = await fixture();
    const registry = new DispatchRegistry(database, root);
    const dispatch = registry.accept(action()).dispatch;
    const lineageId = dispatch.lineageId as string;
    registry.fail(dispatch.action.action_id, {
      reason: "launch_response_incomplete",
    });
    const lineage = registry.getLineage(lineageId);

    const adopted = registry.adopt({
      action: dispatch.action,
      lineage: {
        ...lineage,
        transportBinding: terminalTransportBinding(
          lineage.harnessKind,
          "herdr",
          {
            sessionName: "qe-worker-test",
            sessionIncarnation: "incarnation-1",
            workspaceId: "workspace-1",
            tabId: "tab-1",
            paneId: "pane-1",
            terminalId: "terminal-1",
            agentName: "agent-1",
          },
          {
            name: "agent-1",
            agent: "fake",
            status: "working",
            workspaceId: "workspace-1",
            tabId: "tab-1",
            paneId: "pane-1",
            terminalId: "terminal-1",
          },
        ),
        interactive: terminalInteractiveSession(lineage.capabilities),
      },
      state: "running",
      resultNonce: dispatch.resultNonce,
      resultDirectory: dispatch.resultDirectory,
    });

    expect(adopted.state).toBe("failed");
    expect(adopted.failure).toEqual({ reason: "launch_response_incomplete" });
    expect(
      terminalLineage(registry.getLineage(lineageId), "fake").ref,
    ).toMatchObject({
      sessionName: "qe-worker-test",
      sessionIncarnation: "incarnation-1",
      workspaceId: "workspace-1",
      paneId: "pane-1",
      agentName: "agent-1",
    });
    expect(registry.getLineage(lineageId).activeActionId).toBeNull();
    registry.close();
  });

  test("uncertain physical execution retains lineage occupancy", async () => {
    const { root, database } = await fixture();
    const registry = new DispatchRegistry(database, root);
    const dispatch = registry.accept(action()).dispatch;
    const lineageId = dispatch.lineageId as string;
    registry.occupy(lineageId, dispatch.action.action_id);
    registry.fail(dispatch.action.action_id, { reason: "unknown" }, true);
    expect(registry.get(dispatch.action.action_id).state).toBe("uncertain");
    expect(registry.getLineage(lineageId).activeActionId).toBe(
      dispatch.action.action_id,
    );
    expect(registry.reconcilePayloads()[0]?.state).toBe("uncertain");
    registry.close();
  });

  test("a resolved fresh retry rotates physical lineage ownership", async () => {
    const { root, database } = await fixture();
    const registry = new DispatchRegistry(database, root);
    const first = registry.accept(action()).dispatch;
    const firstLineageId = first.lineageId as string;
    registry.occupy(firstLineageId, first.action.action_id);
    registry.fail(first.action.action_id, { reason: "unknown" }, true);

    const retry = action({ action_id: "action-2", attempt_id: "attempt-2" });
    retry.execution.context.logical_lineage_id =
      first.action.execution.context.logical_lineage_id;
    expect(() => registry.accept(retry)).toThrow(
      "not available for a fresh retry",
    );

    registry.fail(first.action.action_id, { reason: "operator_retry" });
    const second = registry.accept(retry).dispatch;
    expect(second.lineageId).not.toBe(firstLineageId);
    expect(
      registry.getLineage(second.lineageId as string).logicalLineageId,
    ).toBe(first.action.execution.context.logical_lineage_id);
    expect(registry.getLineage(firstLineageId).logicalLineageId).toBe(
      `retired:${firstLineageId}`,
    );
    registry.close();
  });

  test("human retained-work recovery rotates an uncertain contract-failure lineage", async () => {
    const { root, database } = await fixture();
    const registry = new DispatchRegistry(database, root);
    const first = registry.accept(action()).dispatch;
    const firstLineageId = first.lineageId as string;
    registry.occupy(firstLineageId, first.action.action_id);
    registry.fail(
      first.action.action_id,
      {
        code: "harness_contract_violation",
        classification: "terminal_not_recoverable",
      },
      true,
    );

    const base = action({
      action_id: "recovery-action",
      attempt_id: "recovery-attempt",
    });
    const retry = action({
      execution: {
        ...base.execution,
        context: {
          ...base.execution.context,
          logical_lineage_id: first.action.execution.context.logical_lineage_id,
        },
      },
      operational_recovery: {
        epoch_number: 1,
        attempt_in_epoch: 1,
        attempt_allowance: 2,
        authorization_kind: "human",
        continuation_mode: "fresh",
        retained_lineage_id: null,
        source_attempt_id: first.action.attempt_id,
        request_id: "recovery-request-fresh",
      },
    });

    const recovered = registry.accept(retry).dispatch;
    expect(recovered.lineageId).not.toBe(firstLineageId);
    expect(registry.get(first.action.action_id).state).toBe("uncertain");
    expect(registry.getLineage(firstLineageId)).toMatchObject({
      logicalLineageId: `retired:${firstLineageId}`,
      activeActionId: null,
      sessionState: "retained",
    });
    expect(registry.getLineage(recovered.lineageId as string)).toMatchObject({
      logicalLineageId: first.action.execution.context.logical_lineage_id,
      activeActionId: null,
      sessionState: "starting",
    });

    const preparedLineageId = recovered.lineageId as string;
    registry.occupy(preparedLineageId, recovered.action.action_id);
    registry.fail(recovered.action.action_id, {
      code: "execution_control_readiness_failed",
      classification: "operator_recovery_required",
    });
    const preparedBase = action({
      action_id: "prepared-recovery-action",
      attempt_id: "prepared-recovery-attempt",
    });
    const preparedRecovery = action({
      execution: {
        ...preparedBase.execution,
        context: {
          ...preparedBase.execution.context,
          logical_lineage_id: first.action.execution.context.logical_lineage_id,
        },
      },
      operational_recovery: {
        epoch_number: 2,
        attempt_in_epoch: 1,
        attempt_allowance: 2,
        authorization_kind: "human",
        continuation_mode: "retained",
        retained_lineage_id: preparedLineageId,
        source_attempt_id: recovered.action.attempt_id,
        request_id: "prepared-recovery-request",
      },
    });
    const prepared = registry.accept(preparedRecovery).dispatch;
    expect(() =>
      registry.adoptPreparedProcess(
        recovered.action.action_id,
        prepared.action.action_id,
        preparedLineageId,
      ),
    ).toThrow(
      `Prepared process or worktree is already owned by ${first.action.attempt_id}.`,
    );

    registry.updateSession(
      firstLineageId,
      "unavailable",
      null,
      "2026-09-18T00:00:00.000Z",
    );
    expect(
      registry.adoptPreparedProcess(
        recovered.action.action_id,
        prepared.action.action_id,
        preparedLineageId,
      ),
    ).toMatchObject({
      sourceAttemptId: recovered.action.attempt_id,
      targetAttemptId: prepared.action.attempt_id,
      sourceLineageId: preparedLineageId,
      targetLineageId: preparedLineageId,
      mode: "prepared_process_adopted",
    });
    expect(registry.get(first.action.action_id).state).toBe("uncertain");
    registry.close();
  });

  test("human recovery reuses a compatible retained lineage with a new Attempt", async () => {
    const { root, database } = await fixture();
    const registry = new DispatchRegistry(database, root);
    const first = registry.accept(action()).dispatch;
    const lineageId = first.lineageId as string;
    registry.occupy(lineageId, first.action.action_id);
    registry.fail(first.action.action_id, {
      reason: "authentication_required",
      classification: "operator_recovery_required",
    });

    const base = action({
      action_id: "recovery-action",
      attempt_id: "recovery-attempt",
    });
    const retry = action({
      execution: {
        ...base.execution,
        context: {
          ...base.execution.context,
          logical_lineage_id: first.action.execution.context.logical_lineage_id,
        },
      },
      operational_recovery: {
        epoch_number: 1,
        attempt_in_epoch: 1,
        attempt_allowance: 2,
        authorization_kind: "human",
        continuation_mode: "retained",
        retained_lineage_id: lineageId,
        source_attempt_id: first.action.attempt_id,
        request_id: "recovery-request-1",
      },
    });

    const recovered = registry.accept(retry).dispatch;
    expect(recovered.action.attempt_id).not.toBe(first.action.attempt_id);
    expect(recovered.action.occurrence_id).toBe(first.action.occurrence_id);
    expect(recovered.lineageId).toBe(lineageId);
    expect(registry.listLineages()).toHaveLength(1);
    registry.close();
  });

  test("local completion clears physical occupancy before server acknowledgement", async () => {
    const { root, database } = await fixture();
    const registry = new DispatchRegistry(database, root);
    const dispatch = registry.accept(action()).dispatch;
    const lineageId = dispatch.lineageId as string;
    registry.occupy(lineageId, dispatch.action.action_id);
    const completed = registry.complete(dispatch.action.action_id, {
      change_set: {},
    });

    expect(completed.state).toBe("completed");
    expect(completed.serverAcknowledgedAt).toBeNull();
    expect(registry.getLineage(lineageId).activeActionId).toBeNull();
    registry.acknowledgeServerCompletion(dispatch.action.action_id);
    expect(
      registry.get(dispatch.action.action_id).serverAcknowledgedAt,
    ).not.toBeNull();
    registry.close();
  });
});
