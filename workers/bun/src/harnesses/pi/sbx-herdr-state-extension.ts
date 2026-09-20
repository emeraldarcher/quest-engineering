import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const STATE_PATH_ENV = "QE_SBX_RUNTIME_STATE_PATH";
type RuntimeState = "idle" | "working" | "blocked";

/**
 * Guest half of the SBX/Herdr state relay. It writes only lifecycle identity
 * and state to the Run-private control directory; no prompt or transcript is
 * copied out of the sandbox.
 */
export default function sbxHerdrStateExtension(pi: ExtensionAPI) {
  const path = process.env[STATE_PATH_ENV]?.trim();
  if (!path) return;
  let active = false;
  let blocked = 0;
  let sequence = Date.now() * 1000;
  let lastWorkingSequence = 0;
  let sessionId: string | undefined;
  let sessionPath: string | undefined;

  const updateSession = (ctx: {
    sessionManager?: {
      getSessionId?: () => string;
      getSessionFile?: () => string | undefined;
    };
  }) => {
    try {
      const value = ctx.sessionManager?.getSessionId?.();
      sessionId = typeof value === "string" && value ? value : undefined;
    } catch {
      sessionId = undefined;
    }
    try {
      const value = ctx.sessionManager?.getSessionFile?.();
      sessionPath =
        typeof value === "string" && value.startsWith("/") ? value : undefined;
    } catch {
      sessionPath = undefined;
    }
  };
  const publish = async () => {
    const state: RuntimeState =
      blocked > 0 ? "blocked" : active ? "working" : "idle";
    sequence += 1;
    if (state === "working") lastWorkingSequence = sequence;
    const value = {
      schemaVersion: 1,
      sequence,
      lastWorkingSequence,
      state,
      observedAt: new Date().toISOString(),
      ...(sessionPath
        ? { nativeSession: { kind: "path", value: sessionPath } }
        : sessionId
          ? { nativeSession: { kind: "id", value: sessionId } }
          : {}),
    };
    await mkdir(dirname(path), { recursive: true });
    const temporary = `${path}.${process.pid}.${crypto.randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(value)}\n`, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    await rename(temporary, path);
  };

  pi.events.on("herdr:blocked", (value) => {
    blocked =
      value && typeof value === "object" && "active" in value && value.active
        ? blocked + 1
        : Math.max(0, blocked - 1);
    void publish();
  });
  pi.on("session_start", async (_event, ctx) => {
    if (ctx?.mode !== "tui") return;
    updateSession(ctx);
    active = ctx?.isIdle?.() === false;
    await publish();
  });
  pi.on("agent_start", async (_event, ctx) => {
    updateSession(ctx);
    active = true;
    await publish();
  });
  pi.on("agent_settled", async (_event, ctx) => {
    updateSession(ctx);
    if (ctx?.isIdle?.() !== true) return;
    active = false;
    await publish();
  });
}
