import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { DispatchRegistry } from "../src/dispatch/registry.ts";
import { action } from "./support.ts";

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
  test("upgrades a legacy Pi lineage registry additively", async () => {
    const { root, database } = await fixture();
    const legacy = new Database(database, { create: true });
    legacy.exec(`
      CREATE TABLE provider_lineages (
        lineage_id TEXT PRIMARY KEY,
        logical_lineage_id TEXT NOT NULL UNIQUE,
        configuration_json TEXT NOT NULL,
        configuration_hash TEXT NOT NULL,
        provider TEXT NOT NULL CHECK(provider='pi'),
        result_control_path TEXT NOT NULL UNIQUE,
        ownership_token TEXT NOT NULL UNIQUE,
        active_action_id TEXT,
        herdr_session TEXT,
        workspace_id TEXT,
        tab_id TEXT,
        pane_id TEXT,
        terminal_id TEXT,
        agent_name TEXT,
        native_session_json TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
    legacy
      .query(`INSERT INTO provider_lineages
        (lineage_id,logical_lineage_id,configuration_json,configuration_hash,provider,result_control_path,ownership_token,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?)`)
      .run(
        "legacy-lineage",
        "legacy-logical",
        "{}",
        "hash",
        "pi",
        join(root, "legacy-control.json"),
        "legacy-owner",
        "2026-01-01T00:00:00.000Z",
        "2026-01-01T00:00:01.000Z",
      );
    legacy.close();

    const registry = new DispatchRegistry(database, root);
    expect(registry.getLineage("legacy-lineage")).toMatchObject({
      harnessKind: "pi",
      sessionState: "starting",
      startedAt: "2026-01-01T00:00:00.000Z",
      lastActivityAt: "2026-01-01T00:00:01.000Z",
      capabilities: { canResume: true },
    });
    registry.close();
    const migrated = new Database(database);
    const schema = migrated
      .query(
        "SELECT sql FROM sqlite_master WHERE type='table' AND name='provider_lineages'",
      )
      .get() as { sql: string };
    expect(schema.sql).not.toContain("CHECK(provider='pi')");
    migrated.close();
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

  test("harness session identity and attention survive Worker restart", async () => {
    const { root, database } = await fixture();
    const registry = new DispatchRegistry(database, root);
    const dispatch = registry.accept(action()).dispatch;
    const lineageId = dispatch.lineageId as string;
    const attention = {
      attentionId: "attention-1",
      category: "needs_input" as const,
      message: "Choose an option.",
      requestedAt: "2026-09-06T00:00:00.000Z",
    };
    registry.updateSession(
      lineageId,
      "waiting_for_human",
      attention,
      "2026-09-06T00:00:01.000Z",
    );
    registry.close();

    const restarted = new DispatchRegistry(database, root);
    expect(restarted.getLineage(lineageId)).toMatchObject({
      lineageId,
      sessionState: "waiting_for_human",
      attention,
      harnessKind: "fake",
    });
    expect(restarted.get(dispatch.action.action_id).lineageId).toBe(lineageId);
    restarted.close();
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
