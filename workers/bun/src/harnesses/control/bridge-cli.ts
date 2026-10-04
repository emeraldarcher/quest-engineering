#!/usr/bin/env bun
import type { JsonValue } from "../../protocol/types.ts";
import { HarnessControlClient } from "./client.ts";
import { HarnessControlError, type HarnessControlOperation } from "./types.ts";

const [mode, event] = process.argv.slice(2);

try {
  if (mode === "hook" && event === "stop") {
    const payload = record(JSON.parse(await readStdin()));
    const decision = await HarnessControlClient.fromEnvironment().nativeStop(
      typeof payload.terminationReason === "string"
        ? payload.terminationReason
        : "unknown",
      payload.fullyIdle === true,
      typeof payload.modelName === "string" ? payload.modelName : undefined,
    );
    if (decision.nativeStop?.decision === "continue")
      output({ decision: "continue", reason: decision.nativeStop.reason });
    else if (decision.nativeStop?.decision === "contract_violation") {
      output({});
      console.error(
        `harness_contract_violation: ${decision.nativeStop.reason}`,
      );
      process.exitCode = 3;
    } else output({});
  } else if (mode === "local-control") {
    const operation = decodeOperation(JSON.parse(await readStdin()));
    output(await HarnessControlClient.fromEnvironment().call(operation));
  } else {
    throw new Error("Usage: qe-harness-bridge hook stop | local-control");
  }
} catch (error) {
  const recoverableStopInfrastructureFailure =
    mode === "hook" &&
    event === "stop" &&
    error instanceof HarnessControlError &&
    [
      "bridge_unavailable",
      "bridge_timeout",
      "invalid_bridge_response",
    ].includes(error.code);
  if (recoverableStopInfrastructureFailure)
    output({
      decision: "continue",
      reason:
        "Quest Engineering completion infrastructure is temporarily unavailable. Continue without repeating completed work and retry qe_complete_step after the local bridge recovers.",
    });
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = recoverableStopInfrastructureFailure ? 0 : 2;
}

function output(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin)
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

function decodeOperation(value: unknown): HarnessControlOperation {
  const input = record(value);
  if (input.type === "complete_step")
    return {
      type: "complete_step",
      outputs: record(input.outputs) as Record<string, JsonValue>,
    };
  if (input.type === "request_human_assistance")
    return {
      type: "request_human_assistance",
      category: String(input.category) as Extract<
        HarnessControlOperation,
        { type: "request_human_assistance" }
      >["category"],
      message: String(input.message ?? ""),
      ...(input.interaction === "confirmation" ||
      input.interaction === "conversational_intervention"
        ? { interaction: input.interaction }
        : {}),
    };
  throw new Error("Unsupported local-control operation.");
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error("Expected a JSON object.");
  return value as Record<string, unknown>;
}
