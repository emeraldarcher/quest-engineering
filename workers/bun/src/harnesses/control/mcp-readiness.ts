import { createHash } from "node:crypto";
import { OperationalExecutionError } from "../types.ts";
import { HarnessControlClient } from "./client.ts";
import type { HarnessControlBinding } from "./types.ts";

const MAX_STARTUP_EVIDENCE_BYTES = 256 * 1024;

export interface McpProcessBinding {
  pid: number;
  recordedAt: string | null;
}

export async function waitForMcpProcessBinding(input: {
  evidencePath: string;
  descriptorPath: string;
  timeoutMs: number;
  processAlive?: (pid: number) => boolean;
}): Promise<McpProcessBinding> {
  const expectedPathHash = createHash("sha256")
    .update(input.descriptorPath)
    .digest("hex");
  const processAlive = input.processAlive ?? liveProcess;
  const deadline = Date.now() + Math.min(input.timeoutMs, 30_000);
  while (Date.now() < deadline) {
    const evidence = await matchingProcessBinding(
      input.evidencePath,
      expectedPathHash,
      processAlive,
    );
    if (evidence) return evidence;
    await Bun.sleep(100);
  }
  throw readinessError(
    "Antigravity's QE MCP child is not alive at the expected stable control descriptor path.",
  );
}

export async function assertCurrentBridgeAuthority(
  descriptorPath: string,
  expected: HarnessControlBinding,
): Promise<void> {
  let actual: HarnessControlBinding | undefined;
  try {
    actual = (await new HarnessControlClient(descriptorPath).completionStatus())
      .binding;
  } catch (error) {
    const code =
      typeof error === "object" && error !== null && "code" in error
        ? ` (${String((error as { code: unknown }).code)})`
        : "";
    throw readinessError(
      `The current QE control descriptor does not validate active bridge authority${code}.`,
    );
  }
  if (!actual || !sameBinding(actual, expected))
    throw readinessError(
      "The current QE control descriptor belongs to another Action, Attempt, lineage, or result nonce.",
    );
}

async function matchingProcessBinding(
  path: string,
  expectedPathHash: string,
  processAlive: (pid: number) => boolean,
): Promise<McpProcessBinding | null> {
  try {
    const file = Bun.file(path);
    const start = Math.max(0, file.size - MAX_STARTUP_EVIDENCE_BYTES);
    const lines = (await file.slice(start).text()).split("\n");
    if (start > 0) lines.shift();
    for (const line of lines.filter(Boolean).reverse()) {
      try {
        const event = JSON.parse(line) as Record<string, unknown>;
        if (
          event.kind === "qe_harness_mcp_startup" &&
          event.descriptorPathHash === expectedPathHash &&
          event.bridgeAcceptedContext === true &&
          typeof event.pid === "number" &&
          Number.isSafeInteger(event.pid) &&
          event.pid > 0 &&
          processAlive(event.pid)
        )
          return {
            pid: event.pid,
            recordedAt:
              typeof event.recordedAt === "string" ? event.recordedAt : null,
          };
      } catch {
        // Malformed additive evidence is ignored; another bounded line may match.
      }
    }
  } catch {
    // The child may not have published startup evidence yet.
  }
  return null;
}

function sameBinding(
  actual: HarnessControlBinding,
  expected: HarnessControlBinding,
): boolean {
  return (
    actual.actionId === expected.actionId &&
    actual.attemptId === expected.attemptId &&
    actual.lineageId === expected.lineageId &&
    actual.resultNonce === expected.resultNonce
  );
}

function liveProcess(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function readinessError(message: string): OperationalExecutionError {
  return new OperationalExecutionError(
    message,
    "operator_recovery_required",
    "execution_control_readiness_failed",
  );
}
