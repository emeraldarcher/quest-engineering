import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DispatchRegistry } from "../src/dispatch/registry.ts";
import {
  controlDescriptorPath,
  HarnessControlAuthority,
} from "../src/harnesses/control/authority.ts";
import {
  assertCurrentBridgeAuthority,
  waitForMcpProcessBinding,
} from "../src/harnesses/control/mcp-readiness.ts";
import { HarnessControlServer } from "../src/harnesses/control/server.ts";
import type { ExecuteAction } from "../src/protocol/types.ts";
import { action } from "./support.ts";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

async function fixture() {
  const parent = join(process.cwd(), ".pi", "tmp");
  await mkdir(parent, { recursive: true });
  const root = await mkdtemp(join(parent, "mcp-readiness-"));
  const registry = new DispatchRegistry(
    join(root, "dispatches.sqlite"),
    root,
    "fake",
  );
  const authority = new HarnessControlAuthority(registry);
  const server = new HarnessControlServer(authority);
  await server.start();
  cleanups.push(async () => {
    await server.stop();
    registry.close();
    await rm(root, { recursive: true, force: true });
  });
  return { root, registry, authority };
}

async function bind(
  value: Awaited<ReturnType<typeof fixture>>,
  input: ExecuteAction,
) {
  const dispatch = value.registry.accept(input).dispatch;
  if (!dispatch.lineageId) throw new Error("fixture has no lineage");
  value.registry.occupy(dispatch.lineageId, input.action_id);
  const lineage = value.registry.getLineage(dispatch.lineageId);
  await value.authority.bind(dispatch, lineage);
  return {
    dispatch,
    lineage,
    descriptorPath: controlDescriptorPath(lineage),
    expected: {
      actionId: dispatch.action.action_id,
      attemptId: dispatch.action.attempt_id,
      lineageId: lineage.lineageId,
      resultNonce: dispatch.resultNonce,
    },
  };
}

async function startupEvidence(
  path: string,
  descriptorPath: string,
  recordedAt = "2000-01-01T00:00:00.000Z",
) {
  await writeFile(
    path,
    `${JSON.stringify({
      kind: "qe_harness_mcp_startup",
      pid: process.pid,
      descriptorPathHash: createHash("sha256")
        .update(descriptorPath)
        .digest("hex"),
      bridgeAcceptedContext: true,
      recordedAt,
    })}\n`,
  );
}

test("old startup time remains valid process binding while current authority validates independently", async () => {
  const value = await fixture();
  const bound = await bind(value, action());
  const evidencePath = join(value.root, "mcp-startup.jsonl");
  await startupEvidence(evidencePath, bound.descriptorPath);

  expect(
    await waitForMcpProcessBinding({
      evidencePath,
      descriptorPath: bound.descriptorPath,
      timeoutMs: 200,
    }),
  ).toMatchObject({ pid: process.pid, recordedAt: "2000-01-01T00:00:00.000Z" });
  await expect(
    assertCurrentBridgeAuthority(bound.descriptorPath, bound.expected),
  ).resolves.toBeUndefined();
});

test("obsolete descriptor path is not accepted as MCP process binding", async () => {
  const value = await fixture();
  const bound = await bind(value, action());
  const evidencePath = join(value.root, "mcp-startup.jsonl");
  await startupEvidence(
    evidencePath,
    join(value.root, "obsolete-control.json"),
  );

  await expect(
    waitForMcpProcessBinding({
      evidencePath,
      descriptorPath: bound.descriptorPath,
      timeoutMs: 10,
      processAlive: () => true,
    }),
  ).rejects.toMatchObject({ code: "execution_control_readiness_failed" });
});

test("dead MCP child evidence fails even at the exact descriptor path", async () => {
  const value = await fixture();
  const bound = await bind(value, action());
  const evidencePath = join(value.root, "mcp-startup.jsonl");
  await startupEvidence(evidencePath, bound.descriptorPath);

  await expect(
    waitForMcpProcessBinding({
      evidencePath,
      descriptorPath: bound.descriptorPath,
      timeoutMs: 10,
      processAlive: () => false,
    }),
  ).rejects.toMatchObject({ code: "execution_control_readiness_failed" });
});

test("malformed current descriptor fails independently of valid startup binding", async () => {
  const value = await fixture();
  const bound = await bind(value, action());
  const evidencePath = join(value.root, "mcp-startup.jsonl");
  await startupEvidence(evidencePath, bound.descriptorPath);
  await waitForMcpProcessBinding({
    evidencePath,
    descriptorPath: bound.descriptorPath,
    timeoutMs: 200,
  });
  await writeFile(bound.descriptorPath, "{malformed");

  await expect(
    assertCurrentBridgeAuthority(bound.descriptorPath, bound.expected),
  ).rejects.toMatchObject({ code: "execution_control_readiness_failed" });
});

test("descriptor content for another Attempt fails exact current authority", async () => {
  const value = await fixture();
  const first = await bind(value, action());
  const second = await bind(
    value,
    action({
      action_id: "action-2",
      attempt_id: "attempt-2",
      occurrence_id: "occurrence-2",
    }),
  );
  await writeFile(
    first.descriptorPath,
    await Bun.file(second.descriptorPath).text(),
  );

  await expect(
    assertCurrentBridgeAuthority(first.descriptorPath, first.expected),
  ).rejects.toThrow("another Action, Attempt, lineage, or result nonce");
});
