import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export const CODEX_CLIENT_VERSION = "0.85.1";
export const CODEX_MODELS_ENDPOINT =
  `https://chatgpt.com/backend-api/codex/models?client_version=${CODEX_CLIENT_VERSION}`;
export const CODEX_METADATA_SNAPSHOT =
  "/qe/state/openai-codex-model-metadata.json";

export async function readCodexProxyIdentity(
  authPath = "/home/agent/.pi/agent/auth.json",
) {
  const auth = JSON.parse(await readFile(authPath, "utf8"))["openai-codex"];
  if (auth?.type !== "oauth" || typeof auth.access !== "string")
    throw new Error("Externally managed openai-codex credential is missing");
  const parts = auth.access.split(".");
  if (parts.length !== 3) throw new Error("Proxy bearer is not JWT-shaped");
  const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
  const accountId = payload?.["https://api.openai.com/auth"]?.chatgpt_account_id;
  const authGeneration = (
    await readFile(join(dirname(authPath), "qe-auth-generation"), "utf8")
  ).trim();
  if (
    typeof accountId !== "string" ||
    accountId.length === 0 ||
    accountId !== auth.accountId ||
    typeof authGeneration !== "string" ||
    !/^[a-f0-9]{64}$/.test(authGeneration)
  )
    throw new Error("Proxy account metadata is invalid");
  return {
    auth,
    accountId,
    accountScope: createHash("sha256").update(accountId).digest("hex"),
    authGeneration,
  };
}

/** Provider metadata is diagnostic only. It is never scheduling authority. */
export async function getCodexModelMetadata(options = {}) {
  const identity = await readCodexProxyIdentity(options.authPath);
  const request = options.fetch ?? fetch;
  const observedAt = new Date().toISOString();
  try {
    const response = await request(CODEX_MODELS_ENDPOINT, {
      headers: {
        Authorization: `Bearer ${identity.auth.access}`,
        "ChatGPT-Account-ID": identity.accountId,
        "OpenAI-Beta": "responses=experimental",
        originator: "pi",
        "User-Agent": `pi/${CODEX_CLIENT_VERSION}`,
      },
      redirect: "error",
      signal: AbortSignal.timeout(20_000),
    });
    let body = null;
    try {
      body = await response.json();
    } catch {
      // Advisory metadata can be malformed without suppressing runtime models.
    }
    const modelCount = Array.isArray(body?.models)
      ? body.models.length
      : Array.isArray(body?.data)
        ? body.data.length
        : null;
    const result = {
      schemaVersion: 2,
      authority: "advisory",
      conclusive: false,
      // Credential identity was validated locally above. HTTP status remains
      // advisory and cannot redefine runtime authentication or availability.
      authenticated: true,
      status: response.status,
      accountScope: identity.accountScope,
      authGeneration: identity.authGeneration,
      observedAt,
      modelCount,
      detail: response.ok
        ? modelCount === 0
          ? "Provider returned an empty advisory model list; account availability remains unknown."
          : "Provider returned advisory model metadata; it does not establish account availability."
        : `Provider advisory metadata returned HTTP ${response.status}.`,
    };
    if (options.snapshotPath !== null)
      await writeMetadataSnapshot(
        options.snapshotPath ?? CODEX_METADATA_SNAPSHOT,
        result,
      );
    return result;
  } catch {
    return {
      schemaVersion: 2,
      authority: "advisory",
      conclusive: false,
      authenticated: true,
      status: null,
      accountScope: identity.accountScope,
      authGeneration: identity.authGeneration,
      observedAt,
      modelCount: null,
      detail: "Provider advisory metadata unavailable.",
    };
  }
}

export function describeCodexModelMetadata(metadata) {
  return [
    `openai-codex metadata is advisory and inconclusive (HTTP ${metadata.status ?? "unavailable"}, models=${metadata.modelCount ?? "unknown"}, originator=pi, client_version=${CODEX_CLIENT_VERSION}).`,
    metadata.detail,
  ];
}

async function writeMetadataSnapshot(path, value) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value)}\n`, {
    encoding: "utf8",
    mode: 0o600,
    flag: "wx",
  });
  await rename(temporary, path);
}
