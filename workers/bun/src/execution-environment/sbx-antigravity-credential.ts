import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import {
  type ResolveHostAntigravityCredentialOptions,
  resolveHostAntigravityCredential,
} from "./antigravity-host-credential.ts";
import type { SbxClient } from "./sbx-client.ts";

export const SBX_ANTIGRAVITY_PROVIDER_HOST =
  "daily-cloudcode-pa.googleapis.com";
export const SBX_ANTIGRAVITY_PROXY_REFRESH_SENTINEL =
  "qe-sbx-host-managed-no-refresh";
export const SBX_ANTIGRAVITY_DYNAMIC_SECRET_REFRESH = "5m";
export const SBX_ANTIGRAVITY_AUTH_PATH =
  "/home/agent/.gemini/antigravity-cli/antigravity-oauth-token";
export const SBX_ANTIGRAVITY_AUTH_GENERATION_PATH =
  "/home/agent/.gemini/antigravity-cli/qe-auth-generation";
export const SBX_ANTIGRAVITY_ACCOUNT_SCOPE_PATH =
  "/home/agent/.gemini/antigravity-cli/qe-account-scope";

const HELPER_PATH = fileURLToPath(
  new URL("./antigravity-host-credential-helper.ts", import.meta.url),
);

export interface SbxAntigravityCredentialProvisionerOptions {
  resolveHostCredential?: typeof resolveHostAntigravityCredential;
  hostCredential?: ResolveHostAntigravityCredentialOptions;
  resolverCommand?: string;
}

export interface SbxAntigravityCredentialProvision {
  /** Nonsecret marker replaced only by SBX for the exact provider host. */
  placeholder: string;
  accountScope: string;
  authGeneration: string;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function defaultResolverCommand(): string {
  return [shellQuote(process.execPath), shellQuote(HELPER_PATH)].join(" ");
}

function accessPlaceholder(accountScope: string, sandboxName: string): string {
  return `qe-sbx-antigravity-access-${createHash("sha256")
    .update(`${accountScope}\0${sandboxName}`)
    .digest("hex")}`;
}

function idTokenPlaceholder(accountScope: string): string {
  const encode = (value: unknown) =>
    Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
  return [
    encode({ alg: "none", typ: "JWT", kid: "qe-sbx-host-managed-v1" }),
    encode({
      iss: "qe-sbx-host-managed",
      aud: "antigravity-cli",
      sub: accountScope,
      email: `qe-${accountScope.slice(0, 24)}@invalid`,
      iat: 0,
      exp: 4_102_444_800,
      qe_sbx_proxy: { version: 1 },
    }),
    Buffer.from("not-a-signature", "utf8").toString("base64url"),
  ].join(".");
}

const WRITE_GUEST_AUTH = String.raw`
const { mkdirSync, writeFileSync, renameSync, chmodSync } = require("node:fs");
const { dirname } = require("node:path");
const path = "/home/agent/.gemini/antigravity-cli/antigravity-oauth-token";
const generationPath = "/home/agent/.gemini/antigravity-cli/qe-auth-generation";
const scopePath = "/home/agent/.gemini/antigravity-cli/qe-account-scope";
function atomic(target, value) {
  const temporary = target + ".qe-new";
  mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
  writeFileSync(temporary, value, { mode: 0o600 });
  chmodSync(temporary, 0o600);
  renameSync(temporary, target);
}
atomic(path, JSON.stringify({
  auth_method: "consumer",
  id_token: process.env.QE_PROXY_ID_TOKEN,
  token: {
    access_token: process.env.QE_PROXY_ACCESS,
    refresh_token: "qe-sbx-host-managed-no-refresh",
    token_type: "Bearer",
    expiry: "2099-12-31T23:59:59.000Z",
  },
}) + "\n");
atomic(generationPath, process.env.QE_PROXY_AUTH_GENERATION + "\n");
atomic(scopePath, process.env.QE_PROXY_ACCOUNT_SCOPE + "\n");
`;

/**
 * Keep Antigravity refresh/account authority on the host. The guest receives
 * only nonsecret markers; SBX substitutes the current short-lived access token
 * for the exact provider host and never persists it in the VM.
 */
export class SbxAntigravityCredentialProvisioner {
  private readonly resolveHostCredential: typeof resolveHostAntigravityCredential;

  constructor(
    private readonly client: SbxClient,
    private readonly options: SbxAntigravityCredentialProvisionerOptions = {},
  ) {
    this.resolveHostCredential =
      options.resolveHostCredential ?? resolveHostAntigravityCredential;
  }

  async provision(
    sandboxName: string,
  ): Promise<SbxAntigravityCredentialProvision> {
    const resolved = await this.resolveHostCredential(
      this.options.hostCredential,
    );
    const placeholder = accessPlaceholder(resolved.accountScope, sandboxName);
    let secretBound = false;
    try {
      await this.client.setDynamicSecret({
        sandboxName,
        placeholder,
        host: SBX_ANTIGRAVITY_PROVIDER_HOST,
        resolverCommand:
          this.options.resolverCommand ?? defaultResolverCommand(),
        refreshInterval: SBX_ANTIGRAVITY_DYNAMIC_SECRET_REFRESH,
      });
      secretBound = true;
      await this.client.exec(
        sandboxName,
        {
          executable: "/usr/bin/node",
          args: ["-e", WRITE_GUEST_AUTH],
          environment: {
            QE_PROXY_ACCESS: placeholder,
            QE_PROXY_ID_TOKEN: idTokenPlaceholder(resolved.accountScope),
            QE_PROXY_AUTH_GENERATION: resolved.authGeneration,
            QE_PROXY_ACCOUNT_SCOPE: resolved.accountScope,
          },
          timeoutMs: 30_000,
        },
        { user: "agent" },
      );
      return {
        placeholder,
        accountScope: resolved.accountScope,
        authGeneration: resolved.authGeneration,
      };
    } catch (error) {
      if (secretBound)
        await this.client
          .removeDynamicSecret(sandboxName, placeholder)
          .catch(() => undefined);
      throw error;
    }
  }

  revoke(sandboxName: string, placeholder: string): Promise<void> {
    return this.client.removeDynamicSecret(sandboxName, placeholder);
  }
}
