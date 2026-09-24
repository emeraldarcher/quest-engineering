import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import {
  errorProvesPromptSubmission,
  observeAntigravityNativeActivity,
  observePiNativeActivity,
  promptEvidenceCursor,
  waitingForActivitySince,
} from "../src/harnesses/turn-lifecycle.ts";
import { HerdrApiError } from "../src/session-host/herdr/client.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function fixture(name: string): Promise<string> {
  const parent = join(process.cwd(), ".pi", "tmp");
  await mkdir(parent, { recursive: true });
  const root = await mkdtemp(join(parent, `${name}-`));
  roots.push(root);
  return root;
}

test("Pi activity requires an exact post-baseline native user turn followed by assistant activity", async () => {
  const root = await fixture("pi-turn-evidence");
  const path = join(root, "session.jsonl");
  const prompt = "exact QE prompt";
  await Bun.write(
    path,
    `${JSON.stringify({ type: "message", message: { role: "assistant", content: [{ type: "text", text: "old" }] } })}\n`,
  );
  const evidence = await promptEvidenceCursor("pi_transcript", path, prompt);
  await Bun.write(
    path,
    (await Bun.file(path).text()) +
      `${JSON.stringify({ type: "message", message: { role: "user", content: [{ type: "text", text: prompt }] } })}\n` +
      `${JSON.stringify({ type: "message", timestamp: "2026-09-16T01:02:03.000Z", message: { role: "assistant", content: [{ type: "text", text: "working" }] } })}\n`,
  );

  expect(
    await observePiNativeActivity({ transcriptPath: path, evidence, prompt }),
  ).toEqual({
    working: true,
    observedAt: "2026-09-16T01:02:03.000Z",
  });
  expect(
    await observePiNativeActivity({
      transcriptPath: path,
      evidence,
      prompt: "another prompt",
    }),
  ).toEqual({ working: false, observedAt: null });
});

test("Antigravity activity comes only from its post-baseline native conversation handoff", async () => {
  const root = await fixture("agy-turn-evidence");
  const path = join(root, "antigravity.log");
  await Bun.write(
    path,
    "Sending user message to conversation 11111111-1111-1111-1111-111111111111 (items=1, media=0)\n",
  );
  const evidence = await promptEvidenceCursor(
    "antigravity_log",
    path,
    "prompt",
  );
  expect(
    await observeAntigravityNativeActivity({ logPath: path, evidence }),
  ).toEqual({
    working: false,
    observedAt: null,
  });

  await Bun.write(
    path,
    (await Bun.file(path).text()) +
      "Sending user message to conversation 22222222-2222-4222-8222-222222222222 (items=3, media=0)\n",
  );
  expect(
    await observeAntigravityNativeActivity({ logPath: path, evidence }),
  ).toMatchObject({
    working: true,
    nativeSession: {
      source: "antigravity",
      kind: "id",
      value: "22222222-2222-4222-8222-222222222222",
    },
  });
});

test("an observation threshold projects stalled without claiming uncertainty", () => {
  const acceptedAt = "2026-09-16T00:00:00.000Z";
  expect(
    waitingForActivitySince(acceptedAt, 5_000, Date.parse(acceptedAt) + 4_999),
  ).toBe("waiting_for_activity");
  expect(
    waitingForActivitySince(acceptedAt, 5_000, Date.parse(acceptedAt) + 5_000),
  ).toBe("stalled");
  expect(
    errorProvesPromptSubmission(
      new HerdrApiError(
        "agent_prompt_stalled",
        "no terminal state within five seconds",
        "agent.prompt",
      ),
    ),
  ).toBe(true);
});
