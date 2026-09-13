import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { StringEnum } from "@earendil-works/pi-ai";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { HarnessControlClient } from "../control/client.ts";
import { readControl } from "../control/result-envelope.ts";

const categories = [
  "needs_input",
  "needs_permission",
  "needs_authentication",
  "needs_confirmation",
  "blocked_external",
  "interactive_prompt",
  "unknown_interactive_block",
] as const;
const interactions = ["confirmation", "conversational_intervention"] as const;

type RecoveryRequest = {
  version: 1;
  state: "requested" | "authorized" | "rejected";
  requestId: string;
  identity: AttentionRecord["identity"];
  memberKey: string;
  lineageId: string;
  piSessionId: string;
  requestedAt: string;
  recoveryEpoch?: number;
  attemptAllowance?: number;
  rejectionCode?: string;
};

type AttentionRecord = {
  version: 2;
  attentionId: string;
  category: (typeof categories)[number];
  message: string;
  interaction: (typeof interactions)[number];
  state: "requested" | "resuming" | "resolved";
  identity: {
    workerId: string;
    lineageId: string;
    actionId: string;
    runId: string;
    occurrenceId: string;
    attemptId: string;
  };
  piSessionId: string;
  requestedAt: string;
  handedBackAt?: string;
  automationResumedAt?: string;
  resolvedAt?: string;
};

/**
 * Pi-native QE handoff. Conversational intervention blocks and terminates only
 * the current Pi agent run; the TUI process and session remain alive and idle.
 * Human messages remain solely in Pi's session. /qe-resume starts another Pi
 * run in that same session and never creates a QE dispatch or Attempt.
 */
export default function humanAssistanceExtension(pi: ExtensionAPI) {
  let blockedAttentionId: string | null = null;
  let resuming: AttentionRecord | null = null;

  pi.registerTool({
    name: "qe_request_human_assistance",
    label: "Request Human Assistance",
    description:
      "Yield this Quest Engineering execution for required human help. Use conversational_intervention when normal multi-turn Pi chat is needed; use confirmation only for a simple completed/not-completed gate.",
    promptSnippet:
      "Yield for human confirmation or a multi-turn conversational intervention without ending the current Attempt",
    promptGuidelines: [
      "Use qe_request_human_assistance only when execution is blocked on actual human input or action; never use it for narration or ordinary uncertainty.",
      "Call conversational_intervention by itself in a tool batch. It ends only the current automated Pi turn; do not call qe_step_result until the human explicitly runs /qe-resume.",
    ],
    executionMode: "sequential",
    parameters: Type.Object({
      category: StringEnum(categories),
      message: Type.String({ minLength: 1, maxLength: 240 }),
      interaction: Type.Optional(StringEnum(interactions)),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const record = await createRecord(ctx, {
        category: params.category,
        message: params.message,
        interaction: "confirmation",
      });
      await writeAttention(record);
      setBlocked(pi, record, true);
      blockedAttentionId = record.attentionId;
      let outcome: "completed" | "cannot_complete" = "cannot_complete";
      try {
        const completed = await ctx.ui.select(
          "Quest Engineering needs your help",
          ["Completed", "Cannot complete"],
        );
        outcome = completed === "Completed" ? "completed" : "cannot_complete";
        return {
          content: [
            {
              type: "text" as const,
              text:
                completed === "Completed"
                  ? "The human completed the requested assistance action. Continue this same Attempt."
                  : "The human could not complete the requested assistance action.",
            },
          ],
          details: {
            attentionId: record.attentionId,
            outcome:
              completed === "Completed" ? "completed" : "cannot_complete",
          },
        };
      } finally {
        const resolvedAt = new Date().toISOString();
        await HarnessControlClient.fromEnvironment().resolveHumanAssistance(
          record.attentionId,
          outcome,
        );
        await writeAttention({
          ...record,
          state: "resolved",
          resolvedAt,
          automationResumedAt: resolvedAt,
        });
        setBlocked(pi, record, false);
        blockedAttentionId = null;
      }
    },
  });

  pi.on("tool_call", async (event, ctx) => {
    if (event.toolName !== "qe_request_human_assistance") {
      const active = await readAttention();
      if (
        active?.interaction === "conversational_intervention" &&
        active.state === "requested" &&
        ["qe_step_result", "edit", "write", "bash"].includes(event.toolName)
      )
        return {
          block: true,
          reason:
            "QE automation is yielded to human conversation. Discuss or inspect as needed, but run /qe-resume before continuing work or submitting the Step result.",
        };
      return;
    }
    const input = event.input as Record<string, unknown>;
    if (input.interaction !== "conversational_intervention") return;

    const existing = await readAttention();
    if (existing && existing.state !== "resolved") {
      return {
        block: true,
        reason:
          "Quest Engineering already has an active conversational intervention. Use normal Pi chat, then /qe-resume.",
        terminate: true,
      };
    }
    if (
      typeof input.category !== "string" ||
      !categories.includes(input.category as (typeof categories)[number]) ||
      typeof input.message !== "string" ||
      input.message.trim().length === 0
    ) {
      return;
    }

    const record = await createRecord(ctx, {
      category: input.category as (typeof categories)[number],
      message: input.message,
      interaction: "conversational_intervention",
    });
    await writeAttention(record);
    setBlocked(pi, record, true);
    blockedAttentionId = record.attentionId;

    // Pi's documented terminate hint ends this agent run after the blocked tool
    // result. agent_settled follows, while the TUI/session remains alive and its
    // ordinary editor regains focus.
    return {
      block: true,
      reason:
        "Automation yielded to the human. Normal Pi chat is active in this same session. Do not resume the Quest Engineering task until the human runs /qe-resume.",
      terminate: true,
    };
  });

  pi.registerCommand("qe-retry", {
    description:
      "Request a new QE recovery epoch after this retained execution Attempt failed",
    handler: async (_args, ctx) => {
      if (!ctx.isIdle()) {
        ctx.ui.notify(
          "Pi is still responding. Retry from the ordinary prompt.",
          "warning",
        );
        return;
      }
      const attention = await readAttention();
      if (attention && attention.state !== "resolved") {
        ctx.ui.notify(
          "This QE Attempt is still live. Use /qe-resume after the intervention instead.",
          "warning",
        );
        return;
      }
      const control = await readControl(requiredPath("QE_RESULT_CONTROL_PATH"));
      const path = requiredPath("QE_RECOVERY_CONTROL_PATH");
      const existing = await readRecovery();
      const existingMatchesAction =
        existing?.identity.actionId === control.action.action_id &&
        existing.identity.attemptId === control.action.attempt_id;
      if (existing?.state === "authorized" && existingMatchesAction) {
        ctx.ui.notify(
          `QE recovery ${existing.recoveryEpoch ?? ""} is already authorized. Waiting for normal scheduling.`,
          "info",
        );
        return;
      }
      const request: RecoveryRequest = {
        version: 1,
        state: "requested",
        requestId:
          existingMatchesAction && existing?.requestId
            ? existing.requestId
            : crypto.randomUUID(),
        identity: {
          workerId: control.workerId,
          lineageId: control.lineageId,
          actionId: control.action.action_id,
          runId: control.action.run_id,
          occurrenceId: control.action.occurrence_id,
          attemptId: control.action.attempt_id,
        },
        memberKey: control.action.execution.performer.member_key,
        lineageId: control.lineageId,
        piSessionId: ctx.sessionManager.getSessionId(),
        requestedAt:
          existingMatchesAction && existing?.requestedAt
            ? existing.requestedAt
            : new Date().toISOString(),
      };
      await writeAtomic(path, request);
      ctx.ui.notify(
        "QE recovery requested. The failed Attempt remains historical; a new Attempt will start only after server authorization and normal scheduling.",
        "info",
      );
    },
  });

  pi.registerCommand("qe-resume", {
    description:
      "Return a conversational intervention to Quest Engineering automation in this same Pi session",
    handler: async (_args, ctx) => {
      const record = await readAttention();
      if (!record || record.interaction !== "conversational_intervention") {
        const recovery = await readRecovery();
        ctx.ui.notify(
          recovery
            ? "No live QE intervention is active. This execution is in recovery; use /qe-retry to request a new Attempt."
            : "No QE conversational intervention is active. If this Attempt has failed, use /qe-retry to request a new recovery Attempt.",
          "error",
        );
        return;
      }
      if (!ctx.isIdle()) {
        ctx.ui.notify(
          "Pi is still responding. Wait for the normal prompt, then run /qe-resume.",
          "warning",
        );
        return;
      }
      const mismatch = await checkpointMismatch(record, ctx);
      if (mismatch) {
        ctx.ui.notify(mismatch, "error");
        return;
      }
      if (record.state === "resolved") {
        ctx.ui.notify("This QE intervention was already resumed.", "error");
        return;
      }

      const next: AttentionRecord = {
        ...record,
        state: "resuming",
        handedBackAt: record.handedBackAt ?? new Date().toISOString(),
      };
      await writeAttention(next);
      resuming = next;
      ctx.ui.notify(
        "Returning control to Quest Engineering automation.",
        "info",
      );
      pi.sendUserMessage(
        "Resume the Quest Engineering task from the current session state. Apply the human guidance already present in this conversation, continue the original objective, and call qe_step_result only when the work is complete.",
      );
    },
  });

  pi.on("agent_start", async () => {
    if (!resuming) return;
    const automationResumedAt = new Date().toISOString();
    await HarnessControlClient.fromEnvironment().automationResumed(
      resuming.attentionId,
      resuming.piSessionId,
    );
    const resolved: AttentionRecord = {
      ...resuming,
      state: "resolved",
      automationResumedAt,
      resolvedAt: automationResumedAt,
    };
    await writeAttention(resolved);
    if (blockedAttentionId === resolved.attentionId)
      setBlocked(pi, resolved, false);
    blockedAttentionId = null;
    resuming = null;
  });

  pi.on("session_start", async (_event, ctx) => {
    const record = await readAttention();
    if (!record || record.state === "resolved") return;
    if (await checkpointMismatch(record, ctx)) return;
    setBlocked(pi, record, true);
    blockedAttentionId = record.attentionId;
    if (record.state === "resuming") resuming = record;
  });
}

async function createRecord(
  ctx: ExtensionContext,
  input: {
    category: (typeof categories)[number];
    message: string;
    interaction: (typeof interactions)[number];
  },
): Promise<AttentionRecord> {
  const resultPath = requiredPath("QE_RESULT_CONTROL_PATH");
  const control = await readControl(resultPath);
  const accepted =
    await HarnessControlClient.fromEnvironment().requestHumanAssistance({
      category: input.category,
      message: input.message.trim().slice(0, 240),
      interaction: input.interaction,
    });
  if (!accepted.attention)
    throw new Error(
      "QE control bridge did not return a HumanAttention record.",
    );
  return {
    version: 2,
    attentionId: accepted.attention.attentionId,
    category: accepted.attention.category,
    message: accepted.attention.message,
    interaction: input.interaction,
    state: "requested",
    identity: {
      workerId: control.workerId,
      lineageId: control.lineageId,
      actionId: control.action.action_id,
      runId: control.action.run_id,
      occurrenceId: control.action.occurrence_id,
      attemptId: control.action.attempt_id,
    },
    piSessionId: ctx.sessionManager.getSessionId(),
    requestedAt: accepted.attention.requestedAt,
  };
}

async function checkpointMismatch(
  record: AttentionRecord,
  ctx: ExtensionContext,
): Promise<string | null> {
  if (record.piSessionId !== ctx.sessionManager.getSessionId())
    return "The QE intervention checkpoint belongs to another Pi session.";
  try {
    await HarnessControlClient.fromEnvironment().completionStatus();
  } catch {
    return "The active QE execution checkpoint is unavailable or stale.";
  }
  return null;
}

function setBlocked(
  pi: ExtensionAPI,
  record: Pick<AttentionRecord, "message">,
  active: boolean,
): void {
  pi.events.emit("herdr:blocked", { active, label: record.message });
}

function requiredPath(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is missing.`);
  return value;
}

async function readAttention(): Promise<AttentionRecord | null> {
  try {
    const value = JSON.parse(
      await readFile(requiredPath("QE_ATTENTION_CONTROL_PATH"), "utf8"),
    ) as AttentionRecord;
    return value.version === 2 ? value : null;
  } catch {
    return null;
  }
}

async function readRecovery(): Promise<RecoveryRequest | null> {
  try {
    const value = JSON.parse(
      await readFile(requiredPath("QE_RECOVERY_CONTROL_PATH"), "utf8"),
    ) as RecoveryRequest;
    return value.version === 1 ? value : null;
  } catch {
    return null;
  }
}

async function writeAttention(value: AttentionRecord): Promise<void> {
  await writeAtomic(requiredPath("QE_ATTENTION_CONTROL_PATH"), value);
}

async function writeAtomic(path: string, value: object): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${crypto.randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value)}\n`, {
    encoding: "utf8",
    mode: 0o600,
    flag: "wx",
  });
  await rename(temporary, path);
}
