import { createHash } from "node:crypto";
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
interface ProviderAvailabilityEvidence {
  state: "verified_available" | "verified_unavailable";
  code: "provider_model_succeeded" | "provider_model_ineligible";
  provider: string;
  model: string;
  accountScope: string;
  authGeneration: string;
  observedAt: string;
}

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
  let providerTurnSequence = 0;
  let providerTurnSettledAt: string | undefined;
  let sessionId: string | undefined;
  let sessionPath: string | undefined;
  let attestation: Record<string, string | number> | undefined;
  let attestationFailure: string | undefined;
  let providerEvidence: ProviderAvailabilityEvidence | undefined;
  let publishTail: Promise<void> = Promise.resolve();

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
  const publish = () => {
    const operation = publishTail.then(async () => {
      const state: RuntimeState =
        blocked > 0 ? "blocked" : active ? "working" : "idle";
      sequence += 1;
      if (state === "working") lastWorkingSequence = sequence;
      const value = {
        schemaVersion: 1,
        sequence,
        lastWorkingSequence,
        providerTurnSequence,
        ...(providerTurnSettledAt ? { providerTurnSettledAt } : {}),
        state,
        observedAt: new Date().toISOString(),
        ...(attestation ? { attestation } : {}),
        ...(attestationFailure ? { attestationFailure } : {}),
        ...(providerEvidence ? { providerEvidence } : {}),
        ...(providerEvidence?.state === "verified_unavailable"
          ? { providerFailure: providerEvidence }
          : {}),
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
    });
    publishTail = operation.catch(() => undefined);
    return operation;
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
  pi.on("message_end", async (event, ctx) => {
    const message = event.message as unknown as Record<string, unknown>;
    const provider = ctx.model?.provider;
    const model = ctx.model?.id;
    if (typeof provider !== "string" || typeof model !== "string") return;
    providerTurnSequence += 1;
    providerTurnSettledAt = new Date().toISOString();
    const identity = await readAccountEvidenceIdentity();
    if (identity) {
      if (
        message.stopReason === "error" &&
        typeof message.errorMessage === "string" &&
        classifyProviderEligibilityFailure(provider, message.errorMessage)
      )
        providerEvidence = {
          state: "verified_unavailable",
          code: "provider_model_ineligible",
          provider,
          model,
          ...identity,
          observedAt: providerTurnSettledAt,
        };
      else if (
        message.stopReason === "stop" ||
        message.stopReason === "toolUse"
      )
        providerEvidence = {
          state: "verified_available",
          code: "provider_model_succeeded",
          provider,
          model,
          ...identity,
          observedAt: providerTurnSettledAt,
        };
    }
    await publish();
  });
  pi.on("agent_settled", async (_event, ctx) => {
    updateSession(ctx);
    if (ctx?.isIdle?.() !== true) return;
    active = false;
    await publish();
  });
}

export function classifyProviderEligibilityFailure(
  provider: string,
  message: string,
): boolean {
  if (provider !== "openai-codex") return false;
  return [
    /model is not supported when using codex with a chatgpt account/i,
    /model .* is not supported when using codex with a chatgpt account/i,
    /(?:do not|don't|does not|doesn't) have access to (?:the )?model/i,
    /model .* (?:is not available|is unavailable) (?:for|to) (?:this|your) account/i,
  ].some((pattern) => pattern.test(message));
}

async function readAccountEvidenceIdentity(): Promise<{
  accountScope: string;
  authGeneration: string;
} | null> {
  try {
    const auth = JSON.parse(
      await readFile("/home/agent/.pi/agent/auth.json", "utf8"),
    )["openai-codex"] as Record<string, unknown>;
    const access = typeof auth.access === "string" ? auth.access : "";
    const payloadPart = access.split(".")[1];
    const payload = JSON.parse(
      Buffer.from(payloadPart ?? "", "base64url").toString("utf8"),
    ) as Record<string, unknown>;
    const claim = payload["https://api.openai.com/auth"] as
      | Record<string, unknown>
      | undefined;
    const accountId = claim?.chatgpt_account_id;
    const authGeneration = (
      await readFile("/home/agent/.pi/agent/qe-auth-generation", "utf8")
    ).trim();
    return typeof accountId === "string" &&
      accountId === auth.accountId &&
      typeof authGeneration === "string" &&
      /^[a-f0-9]{64}$/.test(authGeneration)
      ? {
          accountScope: createHash("sha256").update(accountId).digest("hex"),
          authGeneration,
        }
      : null;
  } catch {
    return null;
  }
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
