import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { ClaudeCodeSessionStore } from "../src/harnesses/claude-code/session-store.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true })),
  );
});

describe("ClaudeCodeSessionStore", () => {
  test("durably owns the exact native session, lineage, account generation, environment, model, and effort", async () => {
    const root = await testRoot();
    const store = new ClaudeCodeSessionStore(root);
    const input = recordInput("11111111-1111-4111-8111-111111111111");
    expect(store.create(input)).toMatchObject({ ...input, state: "prepared" });
    expect(
      store.transition(input.nativeSessionId, ["prepared"], "active"),
    ).toMatchObject({
      ...input,
      state: "active",
    });
    expect(
      store.transition(input.nativeSessionId, ["active"], "idle"),
    ).toMatchObject({
      ...input,
      state: "idle",
    });
    expect(store.forLineage(input.lineageId)).toMatchObject(input);
    expect(() =>
      store.transition(input.nativeSessionId, ["prepared"], "active"),
    ).toThrow("stale");
    store.close();

    const restarted = new ClaudeCodeSessionStore(root);
    expect(restarted.get(input.nativeSessionId)).toMatchObject({
      ...input,
      state: "idle",
    });
    restarted.close();
  });

  test("marks process-restart prepared and active sessions uncertain and never invents stream recovery", async () => {
    const root = await testRoot();
    const store = new ClaudeCodeSessionStore(root);
    const prepared = recordInput("22222222-2222-4222-8222-222222222222");
    const active = {
      ...recordInput("33333333-3333-4333-8333-333333333333"),
      lineageId: "lineage-2",
      logicalLineageId: "logical-lineage-2",
    };
    store.create(prepared);
    store.create(active);
    store.transition(active.nativeSessionId, ["prepared"], "active");
    store.close();

    const restarted = new ClaudeCodeSessionStore(root);
    expect(restarted.get(prepared.nativeSessionId)?.state).toBe("uncertain");
    expect(restarted.get(active.nativeSessionId)?.state).toBe("uncertain");
    expect(() =>
      restarted.transition(active.nativeSessionId, ["active"], "idle"),
    ).toThrow("stale");
    restarted.close();
  });
});

function recordInput(nativeSessionId: string) {
  return {
    nativeSessionId,
    lineageId: "lineage-1",
    logicalLineageId: "logical-lineage-1",
    providerAccountId: "account-1",
    credentialGeneration: 2,
    accountEnvironmentId: "account-environment-1",
    accountEnvironmentIncarnation: "incarnation-1",
    model: "claude-opus-4-6",
    effort: "high",
  };
}

async function testRoot(): Promise<string> {
  const parent = resolve(import.meta.dir, "../.pi/tmp");
  await mkdir(parent, { recursive: true });
  const root = await mkdtemp(join(parent, "claude-session-store-"));
  roots.push(root);
  return root;
}
