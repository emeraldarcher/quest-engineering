import { createHash, randomUUID } from "node:crypto";
import { chmod, open, readFile, rename, stat, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { getAgentDir, ModelRuntime } from "@earendil-works/pi-coding-agent";
import lockfile from "proper-lockfile";

const PROVIDER_ID = "openai-codex";
const ACCOUNT_CLAIM = "https://api.openai.com/auth";
const DEFAULT_MINIMUM_VALIDITY_MS = 5 * 60 * 1000;
const AUTH_TOKEN_ENDPOINT = "https://auth.openai.com/oauth/token";

interface StoredOAuthCredential {
  type: "oauth";
  access: string;
  refresh: string;
  expires: number;
  accountId?: string;
}

type CredentialDocument = Record<string, unknown>;

export interface HostPiCredentialResolution {
  /** Sensitive. Callers must only pass this to SBX's host-side dynamic secret API. */
  accessToken: string;
  /** Nonsecret routing metadata required by the Codex subscription API. */
  accountId: string;
  /** Nonsecret digest that invalidates account evidence when the OAuth generation changes. */
  authGeneration: string;
  /** True only when Pi rotated and the resolver atomically committed auth.json. */
  persistedRotation: boolean;
}

export interface ResolveHostPiCredentialOptions {
  authPath?: string;
  minimumValidityMs?: number;
  /** No-inference acceptance seam: expire only the locked shadow copy. */
  forceRefresh?: boolean;
  /** Test seam. Production always uses Pi's ModelRuntime.getAuth implementation. */
  resolveWithPi?: (
    authPath: string,
    minimumValidityMs: number,
  ) => Promise<string>;
}

function parseDocument(raw: string): CredentialDocument {
  const parsed: unknown = JSON.parse(raw);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    throw new Error("Pi credential store is not an object");
  return parsed as CredentialDocument;
}

function parseOpenAiCredential(
  document: CredentialDocument,
): StoredOAuthCredential {
  const value = document[PROVIDER_ID];
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Pi openai-codex credential is missing");
  const credential = value as Partial<StoredOAuthCredential>;
  if (
    credential.type !== "oauth" ||
    typeof credential.access !== "string" ||
    credential.access.length === 0 ||
    typeof credential.refresh !== "string" ||
    credential.refresh.length === 0 ||
    typeof credential.expires !== "number" ||
    !Number.isFinite(credential.expires)
  ) {
    throw new Error("Pi openai-codex credential is invalid");
  }
  return credential as StoredOAuthCredential;
}

function accountIdFromAccessToken(accessToken: string): string {
  const parts = accessToken.split(".");
  if (parts.length !== 3) throw new Error("Pi access token is not JWT-shaped");
  const payload: unknown = JSON.parse(
    Buffer.from(parts[1] ?? "", "base64url").toString("utf8"),
  );
  if (!payload || typeof payload !== "object" || Array.isArray(payload))
    throw new Error("Pi access token payload is invalid");
  const auth = (payload as Record<string, unknown>)[ACCOUNT_CLAIM];
  if (!auth || typeof auth !== "object" || Array.isArray(auth))
    throw new Error("Pi access token account claim is missing");
  const accountId = (auth as Record<string, unknown>).chatgpt_account_id;
  if (typeof accountId !== "string" || accountId.length === 0)
    throw new Error("Pi access token account id is missing");
  return accountId;
}

function assertOnlyOpenAiChanged(
  before: CredentialDocument,
  after: CredentialDocument,
): void {
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  keys.delete(PROVIDER_ID);
  for (const key of keys) {
    if (!isDeepStrictEqual(before[key], after[key]))
      throw new Error(
        "Pi changed an unrelated credential while resolving openai-codex",
      );
  }
}

async function nativePiResolve(
  authPath: string,
  minimumValidityMs: number,
): Promise<string> {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input, init) => {
    const url = new URL(
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url,
    );
    if (url.href !== AUTH_TOKEN_ENDPOINT || (init?.method ?? "GET") !== "POST")
      throw new Error(
        "Host Pi credential resolver denied an unexpected network request",
      );
    return originalFetch(input, init);
  }) as typeof globalThis.fetch;
  try {
    const runtime = await ModelRuntime.create({
      authPath,
      modelsPath: null,
      refreshOnCreate: false,
      allowModelNetwork: false,
    });
    const resolved = await runtime.getAuth(PROVIDER_ID, {
      minOAuthValidityMs: minimumValidityMs,
    });
    const accessToken = resolved?.auth?.apiKey;
    if (typeof accessToken !== "string" || accessToken.length === 0)
      throw new Error("Pi did not resolve an openai-codex access token");
    return accessToken;
  } finally {
    globalThis.fetch = originalFetch;
  }
}

async function fsyncFile(path: string): Promise<void> {
  const handle = await open(path, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function fsyncDirectory(path: string): Promise<void> {
  const handle = await open(path, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/**
 * Resolve Pi's current subscription access token under Pi's own auth-file lock.
 * Pi performs credential interpretation, expiry checks, refresh, and rotation in
 * a same-directory shadow store; QE then atomically commits that exact result.
 */
export async function resolveHostPiOpenAiCredential(
  options: ResolveHostPiCredentialOptions = {},
): Promise<HostPiCredentialResolution> {
  const authPath = options.authPath ?? join(getAgentDir(), "auth.json");
  const minimumValidityMs =
    options.minimumValidityMs ?? DEFAULT_MINIMUM_VALIDITY_MS;
  if (!Number.isFinite(minimumValidityMs) || minimumValidityMs < 0)
    throw new Error("minimumValidityMs must be a nonnegative finite number");

  const release = await lockfile.lock(authPath, {
    realpath: false,
    retries: { retries: 10, factor: 2, minTimeout: 50, maxTimeout: 1_000 },
    stale: 10_000,
  });
  const directory = dirname(authPath);
  const shadowPath = join(
    directory,
    `.${authPath.split("/").at(-1) ?? "auth.json"}.qe-resolver-${process.pid}-${randomUUID()}`,
  );
  let shadowExists = false;
  try {
    const [beforeRaw, metadata] = await Promise.all([
      readFile(authPath, "utf8"),
      stat(authPath),
    ]);
    const mode = metadata.mode & 0o777;
    if ((mode & 0o077) !== 0)
      throw new Error(
        "Pi credential store permissions are broader than owner-only",
      );
    const beforeDocument = parseDocument(beforeRaw);
    parseOpenAiCredential(beforeDocument);

    const shadow = await open(shadowPath, "wx", mode);
    shadowExists = true;
    try {
      const shadowRaw = options.forceRefresh
        ? `${JSON.stringify({
            ...beforeDocument,
            [PROVIDER_ID]: {
              ...parseOpenAiCredential(beforeDocument),
              expires: 0,
            },
          })}\n`
        : beforeRaw;
      await shadow.writeFile(shadowRaw, "utf8");
      await shadow.sync();
    } finally {
      await shadow.close();
    }

    const accessToken = await (options.resolveWithPi ?? nativePiResolve)(
      shadowPath,
      minimumValidityMs,
    );
    const afterRaw = await readFile(shadowPath, "utf8");
    const afterDocument = parseDocument(afterRaw);
    const credential = parseOpenAiCredential(afterDocument);
    assertOnlyOpenAiChanged(beforeDocument, afterDocument);
    if (credential.access !== accessToken)
      throw new Error(
        "Pi runtime result does not match its persisted credential",
      );
    const accountId = accountIdFromAccessToken(accessToken);
    if (
      credential.accountId !== undefined &&
      credential.accountId !== accountId
    )
      throw new Error(
        "Pi credential account id does not match its access token",
      );

    const persistedRotation = afterRaw !== beforeRaw;
    if (persistedRotation) {
      await chmod(shadowPath, mode);
      await fsyncFile(shadowPath);
      await rename(shadowPath, authPath);
      shadowExists = false;
      await fsyncDirectory(directory);
    }
    const authGeneration = createHash("sha256")
      .update("qe-pi-auth-generation-v1\u0000")
      .update(accountId)
      .update("\u0000")
      .update(accessToken)
      .digest("hex");
    return { accessToken, accountId, authGeneration, persistedRotation };
  } finally {
    if (shadowExists) await unlink(shadowPath).catch(() => undefined);
    await release();
  }
}
