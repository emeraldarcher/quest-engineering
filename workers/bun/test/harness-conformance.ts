import { expect, test } from "bun:test";
import type { AgentHarness } from "../src/harnesses/types.ts";

/** Reusable contract checks. Each adapter is tested only for capabilities it claims. */
export function harnessConformance(
  name: string,
  create: () => AgentHarness | Promise<AgentHarness>,
): void {
  test(`${name} harness conformance: discovery and claimed lifecycle`, async () => {
    const harness = await create();
    const discovery = await harness.discover();
    expect(discovery.kind).toBe(harness.kind);
    expect(discovery.displayName).toBe(harness.displayName);
    expect(discovery.strategy).toBe(harness.integrationStrategy);
    expect(discovery.capabilities).toEqual(harness.capabilities);
    if (discovery.integration.status === "ready") {
      expect(discovery.integration.installed).toBe(true);
      expect(discovery.integration.authenticated).toBe(true);
      expect(discovery.models.length).toBeGreaterThan(0);
      expect(discovery.capabilities.structuredResult).toBe(true);
    }
    for (const model of discovery.models) {
      expect(model.provider.length).toBeGreaterThan(0);
      expect(model.model.length).toBeGreaterThan(0);
      if (model.reasoningCapability.kind === "enumerated") {
        expect(model.reasoningCapability.values.length).toBeGreaterThan(0);
        expect(new Set(model.reasoningCapability.values).size).toBe(
          model.reasoningCapability.values.length,
        );
      }
    }
    if (harness.capabilities.continuation)
      expect(harness.continue).toBeFunction();
    if (harness.capabilities.retainedSessionRecovery) {
      expect(harness.recover).toBeFunction();
      expect(harness.waitAndCollect).toBeFunction();
    }
    if (harness.capabilities.canAttachTerminal)
      expect(harness.attachment).toBeFunction();
    if (harness.capabilities.canInterrupt)
      expect(harness.interrupt).toBeFunction();
  });
}
