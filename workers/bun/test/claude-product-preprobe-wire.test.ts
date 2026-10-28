import { test as bunTest, expect } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DispatchRegistry } from "../src/dispatch/registry.ts";
import { isFreshInitialProbeExecution } from "../src/harnesses/claude-code/preprobe-diagnostics.ts";
import { decodeExecuteAction } from "../src/protocol/codec.ts";
import {
  productAcceptanceReceipt,
  productPreprobeAction,
  productPreprobeWire,
} from "./support/product-preprobe-wire.ts";

// The dedicated runner always generates and requires these files. Worker-only
// runs may explicitly skip the cross-language test environment.
const test = bunTest.skipIf(!process.env.QE_PREPROBE_WIRE_DIR);

for (const [field, value] of [
  ["authorization_kind", "retry"],
  ["continuation_mode", "resume"],
  ["continuation_mode", "rebind"],
  ["attempt_in_epoch", 0],
  ["attempt_allowance", 0],
] as const)
  test(`synthetic hostile wire is rejected by actual decoder: ${field}=${value}`, () => {
    const wire = productPreprobeWire("fresh");
    (wire.operational_recovery as Record<string, unknown>)[field] = value;
    expect(() => decodeExecuteAction(wire, String(wire.worker_id))).toThrow();
  });

for (const [field, value] of [
  ["continuation_mode", "retained"],
  ["retained_lineage_id", "restored"],
  ["request_id", "human-request"],
] as const)
  test(`synthetic contradictory but representable wire fails eligibility: ${field}`, () => {
    const wire = productPreprobeWire("fresh");
    (wire.operational_recovery as Record<string, unknown>)[field] = value;
    const action = decodeExecuteAction(wire, String(wire.worker_id));
    expect(isFreshInitialProbeExecution(action, fresh)).toBe(false);
  });

const fresh = {
  freshAcceptance: true,
  continuation: false,
  recovering: false,
  priorSession: false,
};
for (const name of [
  "fresh",
  "retry",
  "human_fresh",
  "retained",
  "prepared_adoption",
  "continuation",
])
  test(`actual Product scheduler/metadata/codec -> Worker decoder eligibility: ${name}`, () => {
    const action = productPreprobeAction(name);
    expect(action.context_requirement.selector).toBe(
      action.execution.context.mode,
    );
    expect(action.context_lineage_occurrence_id).toBe(
      action.execution.context.source_occurrence_id,
    );
    expect(isFreshInitialProbeExecution(action, fresh)).toBe(name === "fresh");
    // Deliberately supply maximally favorable local continuity to the non-fresh
    // Product states: their real serialized semantics must still reject them.
    if (name === "retry")
      expect(action.operational_recovery?.attempt_in_epoch).toBeGreaterThan(1);
    if (name === "retained" || name === "prepared_adoption") {
      expect(action.operational_recovery?.continuation_mode).toBe("retained");
      expect(action.operational_recovery?.retained_lineage_id).not.toBeNull();
    }
  });

test("Product fresh canonical acceptance produces one current-epoch receipt, never a replay/restart receipt", async () => {
  const root = await mkdtemp(join(tmpdir(), "qe-product-preprobe-"));
  const registry = new DispatchRegistry(
    join(root, "dispatch.sqlite"),
    root,
    "claude_code",
  );
  let closed = false;
  try {
    const action = productPreprobeAction("fresh");
    const accepted = registry.accept(action);
    expect(accepted.created).toBe(true);
    const receipt = productAcceptanceReceipt(action, accepted.created);
    expect(receipt.claim("unrelated-action")).toBeNull();
    expect(receipt.pending()).toBe(1);
    const epoch = receipt.claim();
    expect(epoch).toBe("1:9");
    expect(receipt.claim()).toBeNull();
    const dispatch = registry.get(action.action_id);
    expect(dispatch.state).toBe("accepted");
    expect(dispatch.action.run_id).toBe(action.execution.identity.run_id);
    expect(dispatch.action.attempt_id).toBe(
      action.execution.identity.attempt_id,
    );
    expect(dispatch.serverAcknowledgedAt).toBeNull();
    expect(dispatch.settledAt).toBeNull();
    expect(dispatch.promptIntentAt).toBeNull();
    expect(dispatch.promptAcceptedAt).toBeNull();
    expect(dispatch.nativeActivityAt).toBeNull();
    expect(dispatch.promptAuthorizedAt).toBeNull();
    const lineage = registry.getLineage(dispatch.lineageId as string);
    expect(lineage.nativeSession).toBeNull();
    expect(lineage.executionHandle).toBeNull();
    expect(lineage.transportBinding).toBeNull();
    expect(
      isFreshInitialProbeExecution(dispatch.action, {
        ...fresh,
        freshAcceptance: epoch === "1:9",
      }),
    ).toBe(true);
    expect(
      productAcceptanceReceipt(action, registry.accept(action).created).claim(),
    ).toBeNull();
    expect(productAcceptanceReceipt(action, true, false).claim()).toBeNull();
    registry.close();
    closed = true;
    const reopened = new DispatchRegistry(
      join(root, "dispatch.sqlite"),
      root,
      "claude_code",
    );
    try {
      expect(
        productAcceptanceReceipt(
          action,
          reopened.accept(action).created,
        ).claim(),
      ).toBeNull();
    } finally {
      reopened.close();
    }
  } finally {
    if (!closed) registry.close();
    await rm(root, { recursive: true, force: true });
  }
});

for (const scenario of [
  "stale_receipt",
  "restored_lineage",
  "retained_session",
  "human_source",
  "prior_attempt",
])
  test(`hostile/synthetic mutation of Product fresh input rejects: ${scenario}`, () => {
    const action = productPreprobeAction("fresh");
    const continuity = { ...fresh };
    if (scenario === "stale_receipt") continuity.freshAcceptance = false;
    if (scenario === "restored_lineage" || scenario === "retained_session")
      continuity.priorSession = true;
    if (scenario === "human_source" && action.operational_recovery)
      action.operational_recovery.source_attempt_id = "hostile-human-source";
    if (scenario === "prior_attempt" && action.operational_recovery)
      action.operational_recovery.attempt_in_epoch++;
    expect(isFreshInitialProbeExecution(action, continuity)).toBe(false);
  });
