import { randomUUID } from "node:crypto";
import type { StreamedProcess } from "../../execution-environment/types.ts";
import type { ReasoningCapability } from "../../protocol/types.ts";
import { type AsyncFrameQueue, rejectServerToolEvidence } from "./protocol.ts";

export const CLAUDE_CODE_EFFORT = "high" as const;

/** The immutable QE managed profile supports this exact selected effort only. */
export function supportsClaudeReasoning(
  reasoning: string | null,
  capability: ReasoningCapability,
): reasoning is typeof CLAUDE_CODE_EFFORT {
  return (
    reasoning === CLAUDE_CODE_EFFORT &&
    capability.kind === "enumerated" &&
    capability.values.includes(reasoning)
  );
}

export interface ClaudeEffortExpectation {
  sessionId: string;
  model: string;
  effort: typeof CLAUDE_CODE_EFFORT;
}

export class ClaudeEffortReadinessError extends Error {
  constructor() {
    super("Claude Code effective model/effort readiness was not proven.");
  }
}

/**
 * Pinned 2.1.292 get_settings resolves applied.effort from model/engine state
 * (Linux symbols Lw(model, rc(engineState))),
 * not the requested flag or an init echo. Never retain the surrounding settings.
 */
export function attestClaudeEffortResponse(
  frame: Record<string, unknown>,
  requestId: string,
  expected: ClaudeEffortExpectation,
): void {
  const response = object(frame.response);
  const settings = object(response?.response);
  const applied = object(settings?.applied);
  if (
    expected.effort !== CLAUDE_CODE_EFFORT ||
    !expected.sessionId ||
    (frame.session_id !== undefined &&
      frame.session_id !== expected.sessionId) ||
    frame.type !== "control_response" ||
    response?.subtype !== "success" ||
    response.request_id !== requestId ||
    applied?.model !== expected.model ||
    applied?.effort !== expected.effort ||
    (settings?.errors !== undefined &&
      (!Array.isArray(settings.errors) || settings.errors.length !== 0))
  )
    throw new ClaudeEffortReadinessError();
}

/** Read-only native configuration proof, bounded by the existing preparation budget. */
export async function attestClaudeEffort(
  process: StreamedProcess,
  frames: AsyncFrameQueue,
  expected: ClaudeEffortExpectation,
  deadline: number,
): Promise<void> {
  if (
    expected.effort !== CLAUDE_CODE_EFFORT ||
    !expected.sessionId ||
    !Number.isFinite(deadline) ||
    Date.now() >= deadline
  )
    throw new ClaudeEffortReadinessError();
  const requestId = randomUUID();
  let settled = false;
  try {
    // Start observing immediately: a delayed write ACK must not add another timeout
    // or prevent observation of an already returned, nonce-correlated native reply.
    void process
      .write(
        new TextEncoder().encode(
          `${JSON.stringify({
            type: "control_request",
            request_id: requestId,
            request: { subtype: "get_settings" },
          })}\n`,
        ),
      )
      .catch(() => {
        if (!settled) frames.fail(new ClaudeEffortReadinessError());
      });
    for (let count = 0; count < 64 && Date.now() < deadline; count++) {
      const frame = await frames.next(Math.max(1, deadline - Date.now()));
      if (Date.now() >= deadline) throw new ClaudeEffortReadinessError();
      rejectServerToolEvidence(frame);
      if (frame.session_id && frame.session_id !== expected.sessionId)
        throw new ClaudeEffortReadinessError();
      const response = object(frame.response);
      if (
        frame.type === "control_response" &&
        response?.request_id === requestId
      ) {
        if (frames.closed) throw new ClaudeEffortReadinessError();
        attestClaudeEffortResponse(frame, requestId, expected);
        return;
      }
      // Do not consume contradictory/model-turn evidence while awaiting the
      // getter. Only the original probe's zero-turn result is expected here.
      if (
        frame.type === "assistant" ||
        (frame.type === "system" && frame.subtype === "init") ||
        (frame.type === "result" &&
          (frame.is_error !== false ||
            frame.subtype !== "success" ||
            frame.num_turns !== 0 ||
            (frame.modelUsage !== undefined &&
              (!object(frame.modelUsage) ||
                Object.keys(frame.modelUsage as Record<string, unknown>)
                  .length !== 0))))
      )
        throw new ClaudeEffortReadinessError();
    }
    throw new ClaudeEffortReadinessError();
  } catch {
    // No raw settings, provider/user errors, or parser messages cross this gate.
    throw new ClaudeEffortReadinessError();
  } finally {
    settled = true;
  }
}

function object(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
