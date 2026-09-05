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
