import { expect, test } from "bun:test";
import {
  type ProviderEligibilityFailure,
  SbxControlMailboxRelay,
} from "../src/execution-environment/sbx-run.ts";
import type { EnvironmentLease } from "../src/execution-environment/types.ts";
import { classifyProviderEligibilityFailure } from "../src/harnesses/pi/sbx-herdr-state-extension.ts";
import type { TerminalSessionBackend } from "../src/session-host/types.ts";

const attestation = {
  schemaVersion: 1,
  workerId: "worker",
  runId: "run",
  environmentId: "environment",
  incarnation: "incarnation",
  profileId: "qe-pi-execution-v1",
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

test("relay retains a redacted account-scoped provider eligibility failure", async () => {
  const failure: ProviderEligibilityFailure = {
    code: "provider_model_ineligible",
    provider: "openai-codex",
    model: "example-model",
    accountScope: "a".repeat(64),
    observedAt: "2026-09-22T00:00:00.000Z",
  };
  const invalidated: ProviderEligibilityFailure[] = [];
  const lease = {
    exec: async () => ({
      exitCode: 0,
      stdout: `${JSON.stringify({
        requests: [],
        runtime: { ...state(1, "idle", 0), providerFailure: failure },
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
      invalidated.push(value);
    },
  );

  await relay.refresh();
  expect(relay.providerEligibilityFailure()).toEqual(failure);
  expect(invalidated).toEqual([failure]);
});

test("terminal observation waits for a trailing provider rejection before generic idle settlement", async () => {
  const failure: ProviderEligibilityFailure = {
    code: "provider_model_ineligible",
    provider: "openai-codex",
    model: "example-model",
    accountScope: "b".repeat(64),
    observedAt: "2026-09-22T00:00:00.000Z",
  };
  let polls = 0;
  const lease = {
    exec: async () => {
      polls += 1;
      const runtime =
        polls === 1
          ? state(1, "working", 1)
          : { ...state(2, "idle", 1), providerFailure: failure };
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
