import {
  mkdir,
  readFile,
  realpath,
  rename,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const STATE_PATH_ENV = "QE_SBX_RUNTIME_STATE_PATH";
const ATTESTATION_ENV = "QE_SBX_ATTESTATION_JSON";
const OWNERSHIP_MARKER_ENV = "QE_SBX_OWNERSHIP_MARKER_PATH";
const LAUNCH_BINDING_ENV = "QE_SBX_LAUNCH_BINDING_PATH";
const REQUIRED_PATHS_ENV = "QE_SBX_REQUIRED_GUEST_PATHS_JSON";
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
  let attestation: Record<string, string | number> | undefined;
  let attestationFailure: string | undefined;

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
      ...(attestation ? { attestation } : {}),
      ...(attestationFailure ? { attestationFailure } : {}),
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
    try {
      attestation = await verifyEnvironmentAttestation();
      attestationFailure = undefined;
    } catch (error) {
      attestation = undefined;
      attestationFailure =
        error instanceof Error ? error.message : "unknown attestation failure";
    }
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

export async function verifyEnvironmentAttestation(
  environment: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd(),
): Promise<Record<string, string | number>> {
  const expected = parseRecord(
    environment[ATTESTATION_ENV],
    "expected attestation",
  );
  const markerPath = absoluteEnvironmentPath(
    environment[OWNERSHIP_MARKER_ENV],
    "ownership marker",
  );
  const bindingPath = absoluteEnvironmentPath(
    environment[LAUNCH_BINDING_ENV],
    "launch binding",
  );
  const requiredPathsValue = environment[REQUIRED_PATHS_ENV];
  let requiredPaths: unknown;
  try {
    requiredPaths = JSON.parse(requiredPathsValue ?? "null");
  } catch {
    throw new Error("required guest paths are not valid JSON");
  }
  if (
    !Array.isArray(requiredPaths) ||
    !requiredPaths.every(
      (value) => typeof value === "string" && value.startsWith("/"),
    )
  )
    throw new Error("required guest paths are not absolute");
  const marker = parseRecord(
    await readFile(markerPath, "utf8"),
    "ownership marker",
  );
  const binding = parseRecord(
    await readFile(bindingPath, "utf8"),
    "launch binding",
  );
  for (const key of [
    "workerId",
    "runId",
    "environmentId",
    "incarnation",
    "profileId",
    "profileDigest",
  ])
    if (marker[key] !== expected[key])
      throw new Error(`ownership marker mismatch for ${key}`);
  for (const [key, value] of Object.entries(expected))
    if (binding[key] !== value)
      throw new Error(`launch binding mismatch for ${key}`);
  if (
    typeof expected.workspacePath !== "string" ||
    (await realpath(cwd)) !== (await realpath(expected.workspacePath))
  )
    throw new Error("Pi cwd does not match the attested private workspace");
  if (
    typeof expected.homePath !== "string" ||
    environment.HOME !== expected.homePath
  )
    throw new Error(
      "Pi HOME does not match the attested private environment home",
    );
  for (const path of requiredPaths) await stat(path);
  return expected;
}

function absoluteEnvironmentPath(
  value: string | undefined,
  label: string,
): string {
  if (!value?.startsWith("/")) throw new Error(`${label} path is not absolute`);
  return value;
}

function parseRecord(
  value: string | undefined,
  label: string,
): Record<string, string | number> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value ?? "null");
  } catch {
    throw new Error(`${label} is not valid JSON`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    throw new Error(`${label} is not an object`);
  for (const [key, item] of Object.entries(parsed))
    if (typeof item !== "string" && typeof item !== "number")
      throw new Error(`${label}.${key} is not scalar`);
  return parsed as Record<string, string | number>;
}
