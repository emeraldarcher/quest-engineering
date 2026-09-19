import { createHash } from "node:crypto";
import { readdir, stat } from "node:fs/promises";
import type { WorkerConfig } from "../config.ts";
import type { DispatchRecord } from "../dispatch/registry.ts";
import { HerdrApiError } from "../session-host/herdr/client.ts";
import type { NativeSessionRef } from "../session-host/types.ts";
import type { PromptEvidenceCursor } from "./types.ts";

export interface NativeTurnActivity {
  working: boolean;
  observedAt: string | null;
  nativeSession?: NativeSessionRef;
}

export function promptActivityStallMs(config: WorkerConfig): number {
  return config.promptActivityStallMs ?? 30_000;
}

export async function promptEvidenceCursor(
  kind: PromptEvidenceCursor["kind"],
  path: string,
  prompt: string,
): Promise<PromptEvidenceCursor> {
  let cursor = 0;
  try {
    cursor = (await stat(path)).size;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return { kind, cursor, promptHash: digest(prompt) };
}

export function persistedPromptEvidence(
  dispatch: DispatchRecord,
  kind: PromptEvidenceCursor["kind"],
  prompt: string,
): PromptEvidenceCursor | null {
  const value = dispatch.promptEvidence;
  if (
    value?.kind !== kind ||
    typeof value.cursor !== "number" ||
    !Number.isSafeInteger(value.cursor) ||
    value.cursor < 0 ||
    value.promptHash !== digest(prompt)
  )
    return null;
  return {
    kind,
    cursor: value.cursor,
    promptHash: value.promptHash,
  };
}

/**
 * Pi's append-only native transcript is the authority for turn activity. A
 * matching user entry proves native receipt; a following assistant entry
 * proves the turn actually became active. Terminal text and Herdr idle/working
 * detection are deliberately not used as this evidence.
 */
export async function observePiNativeActivity(input: {
  transcriptPath: string;
  evidence: PromptEvidenceCursor;
  prompt: string;
}): Promise<NativeTurnActivity> {
  if (input.evidence.promptHash !== digest(input.prompt))
    return { working: false, observedAt: null };
  const lines = await appendedLines(
    input.transcriptPath,
    input.evidence.cursor,
  );
  let matchingUserSeen = false;
  for (const line of lines) {
    let value: Record<string, unknown>;
    try {
      value = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (value.type !== "message" || !record(value.message)) continue;
    const role = value.message.role;
    if (role === "user" && messageText(value.message) === input.prompt) {
      matchingUserSeen = true;
      continue;
    }
    if (matchingUserSeen && role === "assistant")
      return {
        working: true,
        observedAt: timestamp(value.timestamp) ?? new Date().toISOString(),
      };
  }
  return { working: false, observedAt: null };
}

/**
 * Antigravity's own --log-file records the native conversation handoff. The
 * first post-baseline successful user-message send belongs to the exclusively
 * owned QE TUI and proves native activity without scraping terminal output.
 */
export async function observeAntigravityNativeActivity(input: {
  logPath: string;
  evidence: PromptEvidenceCursor;
}): Promise<NativeTurnActivity> {
  const lines = await appendedLines(input.logPath, input.evidence.cursor);
  const pattern =
    /Sending user message to conversation ([0-9a-f]{8}-[0-9a-f-]{27,}) \(items=\d+, media=\d+\)/i;
  for (const line of lines) {
    const match = line.match(pattern);
    if (!match) continue;
    const conversationId = match[1] as string;
    return {
      working: true,
      observedAt: new Date().toISOString(),
      nativeSession: {
        source: "antigravity",
        agent: "agy",
        kind: "id",
        value: conversationId,
      },
    };
  }
  return { working: false, observedAt: null };
}

export async function structuredResultExists(
  directory: string,
): Promise<boolean> {
  try {
    return (await readdir(directory)).some((name) =>
      /^result-[a-zA-Z0-9_-]+\.json$/.test(name),
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

export async function reconcileAmbiguousPrompt(input: {
  observe: () => Promise<NativeTurnActivity>;
  resultExists: () => Promise<boolean>;
  timeoutMs: number;
}): Promise<NativeTurnActivity | "settled" | null> {
  const deadline = Date.now() + Math.max(1, input.timeoutMs);
  while (Date.now() < deadline) {
    if (await input.resultExists()) return "settled";
    const activity = await input.observe();
    if (activity.working) return activity;
    await Bun.sleep(50);
  }
  return null;
}

/** Herdr 0.9 emits this only after text and Enter were successfully sent. */
export function errorProvesPromptSubmission(error: unknown): boolean {
  return (
    error instanceof HerdrApiError && error.code === "agent_prompt_stalled"
  );
}

export function ambiguousPromptError(error: unknown): boolean {
  return (
    error instanceof HerdrApiError &&
    [
      "backend_unavailable",
      "controller_disconnected",
      "stream_closed",
      "timeout",
    ].includes(error.code)
  );
}

export function uncertainPrompt(error: unknown): HerdrApiError {
  return new HerdrApiError(
    "agent_prompt_uncertain",
    `Prompt submission outcome is uncertain; exact native evidence did not resolve the transport failure: ${error instanceof Error ? error.message : String(error)}`,
    "agent.prompt",
  );
}

export function waitingForActivitySince(
  acceptedAt: string | null,
  stallMs: number,
  now = Date.now(),
): "waiting_for_activity" | "stalled" {
  const accepted = acceptedAt ? Date.parse(acceptedAt) : Number.NaN;
  return Number.isFinite(accepted) && now - accepted >= stallMs
    ? "stalled"
    : "waiting_for_activity";
}

async function appendedLines(path: string, cursor: number): Promise<string[]> {
  try {
    const file = Bun.file(path);
    if (!(await file.exists()) || file.size <= cursor) return [];
    return (await file.slice(cursor).text()).split("\n").filter(Boolean);
  } catch {
    return [];
  }
}

function messageText(message: Record<string, unknown>): string {
  if (!Array.isArray(message.content)) return "";
  return message.content
    .filter(record)
    .filter((item) => item.type === "text" && typeof item.text === "string")
    .map((item) => String(item.text))
    .join("");
}

function timestamp(value: unknown): string | null {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value)))
    return null;
  return value;
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
