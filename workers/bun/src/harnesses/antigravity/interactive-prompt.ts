import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export const ANTIGRAVITY_INTERACTIVE_PROMPT_TRANSPORT =
  "herdr_pane_bracketed_paste" as const;
export const BRACKETED_PASTE_START = "\u001b[200~";
export const BRACKETED_PASTE_END = "\u001b[201~";

export type InteractivePromptSubmissionPhase =
  | "not_submitted"
  | "text_stage_requested"
  | "text_staged"
  | "text_stage_uncertain"
  | "submit_requested"
  | "submit_sent"
  | "submit_uncertain"
  | "native_accepted"
  | "conversation_identity_observed";

export interface InteractivePromptSubmissionBinding {
  workerId: string;
  questLaunchId: string;
  runId: string;
  actionId: string;
  occurrenceId: string;
  attemptId: string;
  physicalLineageId: string;
  environmentId: string;
  environmentIncarnation: string;
  herdrEndpointGeneration: number;
  herdrServerGeneration: string;
  herdrSession: string;
  herdrSessionIncarnation: string;
  workspaceId: string;
  tabId: string;
  paneId: string;
  terminalId: string;
  agentName: string;
  resultNonce: string;
}

export interface InteractivePromptSubmissionState
  extends InteractivePromptSubmissionBinding {
  version: 1;
  kind: "antigravity_interactive_prompt_submission";
  transport: typeof ANTIGRAVITY_INTERACTIVE_PROMPT_TRANSPORT;
  promptHash: string;
  phase: InteractivePromptSubmissionPhase;
  updatedAt: string;
  textStageRequestedAt?: string;
  textStagedAt?: string;
  submitRequestedAt?: string;
  submitSentAt?: string;
  nativeAcceptedAt?: string;
  conversationIdentityObservedAt?: string;
  nativeConversationId?: string;
  detail?: string;
}

/**
 * One Herdr literal write containing a terminal-standard bracketed paste. The
 * Product prompt is unchanged inside the envelope; one separate Enter key is
 * the only submit action.
 */
export function encodeAntigravityInteractivePrompt(prompt: string): string {
  if (!prompt) throw new Error("Antigravity prompt must be non-empty text.");
  for (const character of prompt) {
    const code = character.charCodeAt(0);
    if (
      code === 0 ||
      code === 13 ||
      code === 27 ||
      code === 127 ||
      (code < 32 && code !== 9 && code !== 10) ||
      (code >= 0x80 && code <= 0x9f)
    )
      throw new Error(
        "Antigravity prompt contains terminal control bytes that cannot be staged literally.",
      );
  }
  return `${BRACKETED_PASTE_START}${prompt}${BRACKETED_PASTE_END}`;
}

export function promptHash(prompt: string): string {
  return createHash("sha256").update(prompt).digest("hex");
}

export function initialPromptSubmissionState(
  binding: InteractivePromptSubmissionBinding,
  prompt: string,
  updatedAt: string,
): InteractivePromptSubmissionState {
  return {
    version: 1,
    kind: "antigravity_interactive_prompt_submission",
    transport: ANTIGRAVITY_INTERACTIVE_PROMPT_TRANSPORT,
    ...binding,
    promptHash: promptHash(prompt),
    phase: "not_submitted",
    updatedAt,
  };
}

export function transitionPromptSubmissionState(
  state: InteractivePromptSubmissionState,
  phase: Exclude<InteractivePromptSubmissionPhase, "not_submitted">,
  observedAt: string,
  options: { nativeConversationId?: string; detail?: string } = {},
): InteractivePromptSubmissionState {
  const allowed: Record<
    InteractivePromptSubmissionPhase,
    InteractivePromptSubmissionPhase[]
  > = {
    not_submitted: ["text_stage_requested"],
    text_stage_requested: ["text_staged", "text_stage_uncertain"],
    text_staged: ["text_stage_uncertain", "submit_requested"],
    text_stage_uncertain: [],
    submit_requested: ["submit_sent", "submit_uncertain"],
    submit_sent: ["submit_uncertain", "native_accepted"],
    submit_uncertain: ["native_accepted"],
    native_accepted: ["conversation_identity_observed"],
    conversation_identity_observed: [],
  };
  if (!allowed[state.phase].includes(phase))
    throw new Error(
      `Invalid Antigravity prompt submission transition: ${state.phase} -> ${phase}.`,
    );
  return {
    ...state,
    phase,
    updatedAt: observedAt,
    ...(phase === "text_stage_requested"
      ? { textStageRequestedAt: observedAt }
      : {}),
    ...(phase === "text_staged" ? { textStagedAt: observedAt } : {}),
    ...(phase === "submit_requested" ? { submitRequestedAt: observedAt } : {}),
    ...(phase === "submit_sent" ? { submitSentAt: observedAt } : {}),
    ...(phase === "native_accepted" ? { nativeAcceptedAt: observedAt } : {}),
    ...(phase === "conversation_identity_observed"
      ? { conversationIdentityObservedAt: observedAt }
      : {}),
    ...(options.nativeConversationId
      ? { nativeConversationId: options.nativeConversationId }
      : {}),
    ...(options.detail ? { detail: options.detail.slice(0, 500) } : {}),
  };
}

export async function readPromptSubmissionState(
  path: string,
): Promise<InteractivePromptSubmissionState | null> {
  try {
    const value = JSON.parse(await readFile(path, "utf8")) as unknown;
    return validState(value) ? value : null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export async function writePromptSubmissionState(
  path: string,
  state: InteractivePromptSubmissionState,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
    flag: "wx",
  });
  await rename(temporary, path);
}

function validState(value: unknown): value is InteractivePromptSubmissionState {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const state = value as Partial<InteractivePromptSubmissionState>;
  const phases: InteractivePromptSubmissionPhase[] = [
    "not_submitted",
    "text_stage_requested",
    "text_staged",
    "text_stage_uncertain",
    "submit_requested",
    "submit_sent",
    "submit_uncertain",
    "native_accepted",
    "conversation_identity_observed",
  ];
  const requiredStrings: (keyof InteractivePromptSubmissionBinding)[] = [
    "workerId",
    "questLaunchId",
    "runId",
    "actionId",
    "occurrenceId",
    "attemptId",
    "physicalLineageId",
    "environmentId",
    "environmentIncarnation",
    "herdrServerGeneration",
    "herdrSession",
    "herdrSessionIncarnation",
    "workspaceId",
    "tabId",
    "paneId",
    "terminalId",
    "agentName",
    "resultNonce",
  ];
  return (
    state.version === 1 &&
    state.kind === "antigravity_interactive_prompt_submission" &&
    state.transport === ANTIGRAVITY_INTERACTIVE_PROMPT_TRANSPORT &&
    typeof state.promptHash === "string" &&
    state.promptHash.length > 0 &&
    requiredStrings.every(
      (key) => typeof state[key] === "string" && state[key].length > 0,
    ) &&
    typeof state.herdrEndpointGeneration === "number" &&
    Number.isSafeInteger(state.herdrEndpointGeneration) &&
    typeof state.phase === "string" &&
    phases.includes(state.phase as InteractivePromptSubmissionPhase) &&
    typeof state.updatedAt === "string" &&
    state.updatedAt.length > 0
  );
}
