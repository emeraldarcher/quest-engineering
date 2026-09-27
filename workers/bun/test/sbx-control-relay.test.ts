import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import {
  type ProviderEligibilityFailure,
  SbxControlMailboxRelay,
} from "../src/execution-environment/sbx-run.ts";
import type { EnvironmentLease } from "../src/execution-environment/types.ts";
import { classifyProviderEligibilityFailure } from "../src/harnesses/pi/sbx-herdr-state-extension.ts";
import type { TerminalSessionBackend } from "../src/session-host/types.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

const attestation = {
  schemaVersion: 1,
  workerId: "worker",
  runId: "run",
  environmentId: "environment",
  incarnation: "incarnation",
  profileId: "qe-pi-execution-v2",
  profileDigest: "sha256:profile",
  physicalLineageId: "lineage",
  workspacePath: "/qe/workspaces/lineage",
  homePath: "/home/agent",
};

test("relay drains the final guest idle state before retained-session teardown", async () => {
  let runtime = state(1, "working", 1);
  const reported: string[] = [];
  const lease = {
    exec: async () => ({
      exitCode: 0,
      stdout: `${JSON.stringify({ requests: [], runtime })}\n`,
      stderr: "",
    }),
  } as unknown as EnvironmentLease;
  const host = {
    reportAgentState: async (value: { state: string }) => {
      reported.push(value.state);
    },
  } as unknown as TerminalSessionBackend;
  const relay = new SbxControlMailboxRelay(
    lease,
    "/qe/control/lineages/test",
    { resultControlPath: "/repo/.pi/tmp/result-control.json" } as never,
    host,
    "w1:p1",
    attestation,
    () => undefined,
    () => undefined,
  );

  relay.start();
  await waitFor(() => reported.includes("working"));
  runtime = state(2, "idle", 1);
  await relay.stop();

  expect(reported.at(-1)).toBe("idle");
});

test("relay remains live beyond semantic completion until delayed native idle", async () => {
  let runtime = state(1, "working", 1);
  const reported: string[] = [];
  const lease = {
    exec: async () => ({
      exitCode: 0,
      stdout: `${JSON.stringify({ requests: [], runtime })}\n`,
      stderr: "",
    }),
  } as unknown as EnvironmentLease;
  const host = {
    reportAgentState: async (value: { state: string }) => {
      reported.push(value.state);
    },
  } as unknown as TerminalSessionBackend;
  const relay = new SbxControlMailboxRelay(
    lease,
    "/qe/control/lineages/test",
    { resultControlPath: "/repo/.pi/tmp/result-control.json" } as never,
    host,
    "w1:p1",
    attestation,
    () => undefined,
    () => undefined,
  );

  relay.start();
  await waitFor(() => reported.includes("working"));
  let stopped = false;
  const stop = relay.stop(1_000).then(() => {
    stopped = true;
  });
  await Bun.sleep(150);
  expect(stopped).toBe(false);
  runtime = state(2, "idle", 1);
  await stop;
  expect(reported.at(-1)).toBe("idle");
});

test("a restarted relay adopts retained guest idle without reviving stale working", async () => {
  const runtime = state(7, "idle", 4);
  const reported: string[] = [];
  const lease = {
    exec: async () => ({
      exitCode: 0,
      stdout: `${JSON.stringify({ requests: [], runtime })}\n`,
      stderr: "",
    }),
  } as unknown as EnvironmentLease;
  const host = {
    reportAgentState: async (value: { state: string }) => {
      reported.push(value.state);
    },
  } as unknown as TerminalSessionBackend;
  const createRelay = () =>
    new SbxControlMailboxRelay(
      lease,
      "/qe/control/lineages/test",
      { resultControlPath: "/repo/.pi/tmp/result-control.json" } as never,
      host,
      "w1:p1",
      attestation,
      () => undefined,
      () => undefined,
    );

  const initial = createRelay();
  await initial.refresh();
  await initial.stop(0);
  const restarted = createRelay();
  await restarted.refresh();
  await restarted.stop(0);

  expect(reported).not.toContain("working");
  expect(reported.at(-1)).toBe("idle");
});

test("initial conversation log generation replaces the preauthorization mirror from cursor zero", async () => {
  const parent = join(process.cwd(), ".pi", "tmp");
  await mkdir(parent, { recursive: true });
  const root = await mkdtemp(join(parent, "antigravity-log-switch-"));
  roots.push(root);
  const hostLog = join(root, "antigravity.log");
  const logs = new Map([
    ["/qe/control/antigravity.log", "preauthorization log is much larger\n"],
    [
      "/qe/control/antigravity-conversation.log",
      "Sending user message to conversation 11111111-1111-4111-8111-111111111111 (items=1, media=0)\n",
    ],
  ]);
  const lease = {
    exec: async (command: { environment?: Record<string, string> }) => {
      const path = command.environment?.QE_LOG as string;
      const offset = Number(command.environment?.QE_LOG_OFFSET ?? 0);
      const log = logs.get(path) ?? "";
      const start = log.length >= offset ? offset : 0;
      const chunk = log.slice(start);
      return {
        exitCode: 0,
        stdout: `${JSON.stringify({
          requests: [],
          logChunk: Buffer.from(chunk).toString("base64"),
          logOffset: start + chunk.length,
          logReset: start === 0,
        })}\n`,
        stderr: "",
      };
    },
  } as unknown as EnvironmentLease;
  const relay = new SbxControlMailboxRelay(
    lease,
    "/qe/control",
    { resultControlPath: join(root, "result-control.json") } as never,
    {} as TerminalSessionBackend,
    "w1:p1",
    attestation,
    () => undefined,
    () => undefined,
    async () => undefined,
    "/qe/control/antigravity.log",
    hostLog,
  );

  await relay.refresh();
  expect(await readFile(hostLog, "utf8")).toContain("preauthorization");
  await relay.switchAntigravityLog("/qe/control/antigravity-conversation.log");
  await relay.refresh();
  expect(await readFile(hostLog, "utf8")).toBe(
    "Sending user message to conversation 11111111-1111-4111-8111-111111111111 (items=1, media=0)\n",
  );
});

test("relay retains a redacted account-scoped provider eligibility failure", async () => {
  const failure: ProviderEligibilityFailure = {
    state: "verified_unavailable",
    code: "provider_model_ineligible",
    provider: "openai-codex",
    model: "example-model",
    accountScope: "a".repeat(64),
    authGeneration: "c".repeat(64),
    observedAt: "2026-09-22T00:00:00.000Z",
  };
  const invalidated: ProviderEligibilityFailure[] = [];
  const lease = {
    exec: async () => ({
      exitCode: 0,
      stdout: `${JSON.stringify({
        requests: [],
        runtime: { ...state(1, "idle", 0), providerEvidence: failure },
      })}\n`,
      stderr: "",
    }),
  } as unknown as EnvironmentLease;
  const host = {
    reportAgentState: async () => undefined,
  } as unknown as TerminalSessionBackend;
  const relay = new SbxControlMailboxRelay(
    lease,
    "/qe/control/lineages/test",
    { resultControlPath: "/repo/.pi/tmp/result-control.json" } as never,
    host,
    "w1:p1",
    attestation,
    () => undefined,
    () => undefined,
    async (value) => {
      if (value.state === "verified_unavailable") invalidated.push(value);
    },
  );

  await relay.refresh();
  expect(relay.providerEligibilityFailure()).toEqual(failure);
  expect(invalidated).toEqual([failure]);
});

test("terminal observation waits for a trailing provider rejection before generic idle settlement", async () => {
  const failure: ProviderEligibilityFailure = {
    state: "verified_unavailable",
    code: "provider_model_ineligible",
    provider: "openai-codex",
    model: "example-model",
    accountScope: "b".repeat(64),
    authGeneration: "d".repeat(64),
    observedAt: "2026-09-22T00:00:00.000Z",
  };
  let polls = 0;
  const lease = {
    exec: async () => {
      polls += 1;
      const runtime =
        polls === 1
          ? state(1, "working", 1)
          : { ...state(2, "idle", 1), providerEvidence: failure };
      return {
        exitCode: 0,
        stdout: `${JSON.stringify({ requests: [], runtime })}\n`,
        stderr: "",
      };
    },
  } as unknown as EnvironmentLease;
  const host = {
    reportAgentState: async () => undefined,
  } as unknown as TerminalSessionBackend;
  const relay = new SbxControlMailboxRelay(
    lease,
    "/qe/control/lineages/test",
    { resultControlPath: "/repo/.pi/tmp/result-control.json" } as never,
    host,
    "w1:p1",
    attestation,
    () => undefined,
    () => undefined,
  );

  expect(await relay.awaitProviderEligibilityFailureOrIdle()).toEqual(failure);
  expect(polls).toBe(2);
});

test("only explicit ChatGPT account model-access errors invalidate eligibility", () => {
  expect(
    classifyProviderEligibilityFailure(
      "openai-codex",
      "Codex error: The 'gpt-example' model is not supported when using Codex with a ChatGPT account.",
    ),
  ).toBe(true);
  expect(
    classifyProviderEligibilityFailure(
      "openai-codex",
      "Rate limit exceeded; retry later.",
    ),
  ).toBe(false);
  expect(
    classifyProviderEligibilityFailure(
      "another-provider",
      "The model is not supported when using Codex with a ChatGPT account.",
    ),
  ).toBe(false);
});

function state(
  sequence: number,
  runtimeState: "idle" | "working" | "blocked",
  lastWorkingSequence: number,
) {
  return {
    schemaVersion: 1,
    sequence,
    lastWorkingSequence,
    state: runtimeState,
    observedAt: "2026-09-22T00:00:00.000Z",
    attestation,
  };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!predicate() && Date.now() < deadline) await Bun.sleep(10);
  if (!predicate()) throw new Error("condition was not observed");
}
