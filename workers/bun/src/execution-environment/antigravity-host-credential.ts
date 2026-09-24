import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

const DEFAULT_MINIMUM_VALIDITY_MS = 5 * 60 * 1000;
const KEYCHAIN_SERVICE = "gemini";
const KEYCHAIN_ACCOUNT = "antigravity";
const KEYCHAIN_PREFIX = "go-keyring-base64:";

interface NativeAntigravityCredential {
  auth_method: string;
  id_token: string;
  token: {
    access_token: string;
    refresh_token: string;
    token_type: string;
    expiry: string;
  };
}

export interface HostAntigravityCredentialResolution {
  /** Sensitive. Only the SBX host-side dynamic-secret resolver may consume it. */
  accessToken: string;
  /** Nonsecret, irreversible identity used for provenance and credential rotation. */
  accountScope: string;
  /** Nonsecret digest invalidated whenever native Antigravity rotates access. */
  authGeneration: string;
  expiresAt: string;
  executable: string;
  version: string;
}

export interface ResolveHostAntigravityCredentialOptions {
  executable?: string;
  minimumValidityMs?: number;
  /** Test seam. Production asks native Antigravity to own refresh/readiness. */
  runNativeDiscovery?: (
    executable: string,
  ) => Promise<{ version: string; models: string }>;
  /** Test seam. Production reads Antigravity's native keyring/file record. */
  readNativeCredential?: () => Promise<Uint8Array>;
  now?: () => number;
}

/**
 * Resolve Antigravity's current subscription credential without implementing
 * Google OAuth. Native `agy models` owns login state, expiry, refresh, account
 * selection, and keyring rotation. QE only validates and scopes its result.
 */
export async function resolveHostAntigravityCredential(
  options: ResolveHostAntigravityCredentialOptions = {},
): Promise<HostAntigravityCredentialResolution> {
  const executable = resolve(
    options.executable ??
      process.env.QE_HOST_ANTIGRAVITY_BIN?.trim() ??
      join(homedir(), ".local", "bin", "agy"),
  );
  const minimumValidityMs =
    options.minimumValidityMs ?? DEFAULT_MINIMUM_VALIDITY_MS;
  if (!Number.isFinite(minimumValidityMs) || minimumValidityMs < 0)
    throw new Error("Antigravity credential validity must be nonnegative.");
  const native = await (options.runNativeDiscovery ?? runNativeDiscovery)(
    executable,
  );
  if (!/^\d+\.\d+\.\d+(?:[-+].*)?$/.test(native.version))
    throw new Error(
      "Native Antigravity returned malformed version provenance.",
    );
  if (native.models.trim().split("\n").filter(modelRecord).length === 0)
    throw new Error("Native Antigravity did not confirm authenticated models.");

  const raw = await (options.readNativeCredential ?? readNativeCredential)();
  const credential = decodeNativeCredential(raw);
  const expiry = Date.parse(credential.token.expiry);
  if (
    !Number.isFinite(expiry) ||
    expiry - (options.now?.() ?? Date.now()) < minimumValidityMs
  )
    throw new Error(
      "Native Antigravity credential refresh did not remain valid.",
    );
  const claims = decodeJwtClaims(credential.id_token);
  const subject = requiredText(claims.sub, "Antigravity account subject");
  const accountScope = createHash("sha256")
    .update("qe-antigravity-account-scope-v1\0")
    .update(subject)
    .digest("hex");
  const authGeneration = createHash("sha256")
    .update("qe-antigravity-auth-generation-v1\0")
    .update(accountScope)
    .update("\0")
    .update(credential.token.access_token)
    .digest("hex");
  return {
    accessToken: credential.token.access_token,
    accountScope,
    authGeneration,
    expiresAt: new Date(expiry).toISOString(),
    executable,
    version: native.version,
  };
}

async function runNativeDiscovery(
  executable: string,
): Promise<{ version: string; models: string }> {
  const version = await run(executable, ["--version"]);
  const models = await run(executable, ["models"]);
  return { version: version.trim(), models };
}

async function run(executable: string, args: string[]): Promise<string> {
  const child = Bun.spawn([executable, ...args], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, , exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (exitCode !== 0)
    throw new Error("Native Antigravity credential resolution failed.");
  return stdout;
}

async function readNativeCredential(): Promise<Uint8Array> {
  if (process.platform === "darwin") {
    const child = Bun.spawn(
      [
        "/usr/bin/security",
        "find-generic-password",
        "-s",
        KEYCHAIN_SERVICE,
        "-a",
        KEYCHAIN_ACCOUNT,
        "-w",
      ],
      { stdin: "ignore", stdout: "pipe", stderr: "pipe" },
    );
    const [stdout, , exitCode] = await Promise.all([
      new Response(child.stdout).arrayBuffer(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    if (exitCode !== 0)
      throw new Error("Antigravity keyring credential is unavailable.");
    const encoded = Buffer.from(stdout).toString("utf8").trim();
    if (!encoded.startsWith(KEYCHAIN_PREFIX))
      throw new Error("Antigravity keyring credential encoding is unknown.");
    return Buffer.from(encoded.slice(KEYCHAIN_PREFIX.length), "base64");
  }
  return new Uint8Array(
    await readFile(
      join(homedir(), ".gemini", "antigravity-cli", "antigravity-oauth-token"),
    ),
  );
}

function decodeNativeCredential(raw: Uint8Array): NativeAntigravityCredential {
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder().decode(raw));
  } catch {
    throw new Error("Antigravity native credential record is malformed.");
  }
  const record = object(value);
  const token = object(record.token);
  const credential: NativeAntigravityCredential = {
    auth_method: requiredText(record.auth_method, "auth method"),
    id_token: requiredText(record.id_token, "id token"),
    token: {
      access_token: requiredText(token.access_token, "access token"),
      refresh_token: requiredText(token.refresh_token, "refresh token"),
      token_type: requiredText(token.token_type, "token type"),
      expiry: requiredText(token.expiry, "expiry"),
    },
  };
  if (
    credential.auth_method !== "consumer" ||
    credential.token.token_type.toLowerCase() !== "bearer"
  )
    throw new Error("Antigravity native credential type is unsupported.");
  return credential;
}

function decodeJwtClaims(value: string): Record<string, unknown> {
  const parts = value.split(".");
  if (parts.length !== 3)
    throw new Error("Antigravity native account identity is malformed.");
  try {
    return object(
      JSON.parse(Buffer.from(parts[1] as string, "base64url").toString("utf8")),
    );
  } catch {
    throw new Error("Antigravity native account identity is malformed.");
  }
}

function modelRecord(line: string): boolean {
  return /^\S+\t[^\t]+$/.test(line.trim());
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Antigravity native credential record is malformed.");
  return value as Record<string, unknown>;
}

function requiredText(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0)
    throw new Error(`${label} is missing.`);
  return value;
}
