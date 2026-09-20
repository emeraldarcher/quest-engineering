import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import {
  type ResolveHostPiCredentialOptions,
  resolveHostPiOpenAiCredential,
} from "./pi-host-credential.ts";
import type { SbxClient } from "./sbx-client.ts";

export const SBX_PI_PROXY_REFRESH_SENTINEL = "qe-sbx-host-managed-no-refresh";
export const SBX_PI_PROXY_EXPIRY = Number.MAX_SAFE_INTEGER;
export const SBX_PI_DYNAMIC_SECRET_REFRESH = "5m";
const SBX_PI_PROXY_KID = "qe-sbx-host-managed-v1";
const ACCOUNT_CLAIM = "https://api.openai.com/auth";
const HELPER_PATH = fileURLToPath(
  new URL("./pi-host-credential-helper.ts", import.meta.url),
);

export interface SbxPiCredentialProvisionerOptions {
  resolveHostCredential?: typeof resolveHostPiOpenAiCredential;
  hostCredential?: ResolveHostPiCredentialOptions;
  resolverCommand?: string;
}

export interface SbxPiCredentialProvision {
  /** Nonsecret, invalid JWT used only as an SBX proxy replacement marker. */
  placeholder: string;
}

function base64UrlJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

/** Build an invalid, nonsecret JWT-shaped marker that Pi can inspect locally. */
export function createSbxPiProxyPlaceholder(
  accountId: string,
  sandboxName: string,
): string {
  if (accountId.length === 0)
    throw new Error("Pi account id must not be empty");
  const sandbox = createHash("sha256")
    .update(sandboxName)
    .digest("hex")
    .slice(0, 32);
  return [
    base64UrlJson({ alg: "none", typ: "JWT", kid: SBX_PI_PROXY_KID }),
    base64UrlJson({
      [ACCOUNT_CLAIM]: { chatgpt_account_id: accountId },
      qe_sbx_proxy: { version: 1, sandbox },
    }),
    Buffer.from("not-a-signature", "utf8").toString("base64url"),
  ].join(".");
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function defaultResolverCommand(): string {
  return [
    `PI_CODING_AGENT_DIR=${shellQuote(getAgentDir())}`,
    shellQuote(process.execPath),
    shellQuote(HELPER_PATH),
  ].join(" ");
}

const WRITE_GUEST_AUTH = String.raw`
const { mkdirSync, writeFileSync, renameSync, chmodSync } = require("node:fs");
const { dirname } = require("node:path");
const path = "/home/agent/.pi/agent/auth.json";
const temporary = path + ".qe-new";
const document = {
  "openai-codex": {
    type: "oauth",
    access: process.env.QE_PROXY_ACCESS,
    refresh: "qe-sbx-host-managed-no-refresh",
    expires: Number.MAX_SAFE_INTEGER,
    accountId: process.env.QE_PROXY_ACCOUNT,
  },
};
mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
writeFileSync(temporary, JSON.stringify(document) + "\n", { mode: 0o600 });
chmodSync(temporary, 0o600);
renameSync(temporary, path);
`;

function accountIdFromPlaceholder(placeholder: string): string {
  const payloadPart = placeholder.split(".")[1];
  if (!payloadPart) throw new Error("SBX Pi proxy placeholder is malformed");
  const payload = JSON.parse(
    Buffer.from(payloadPart, "base64url").toString("utf8"),
  ) as Record<string, unknown>;
  const auth = payload[ACCOUNT_CLAIM] as Record<string, unknown> | undefined;
  const accountId = auth?.chatgpt_account_id;
  if (typeof accountId !== "string" || accountId.length === 0)
    throw new Error("SBX Pi proxy placeholder has no account id");
  return accountId;
}

/**
 * Binds one host-resolved token source to one existing sandbox. No real token is
 * passed through QE state, argv, the guest, or the sandbox credential config.
 */
export class SbxPiCredentialProvisioner {
  private readonly resolveHostCredential: typeof resolveHostPiOpenAiCredential;

  constructor(
    private readonly client: SbxClient,
    private readonly options: SbxPiCredentialProvisionerOptions = {},
  ) {
    this.resolveHostCredential =
      options.resolveHostCredential ?? resolveHostPiOpenAiCredential;
  }

  async provision(sandboxName: string): Promise<SbxPiCredentialProvision> {
    const resolved = await this.resolveHostCredential(
      this.options.hostCredential,
    );
    const placeholder = createSbxPiProxyPlaceholder(
      resolved.accountId,
      sandboxName,
    );
    let secretBound = false;
    try {
      await this.client.setDynamicSecret({
        sandboxName,
        placeholder,
        host: "chatgpt.com",
        resolverCommand:
          this.options.resolverCommand ?? defaultResolverCommand(),
        refreshInterval: SBX_PI_DYNAMIC_SECRET_REFRESH,
      });
      secretBound = true;
      await this.client.exec(
        sandboxName,
        {
          executable: "node",
          args: ["-e", WRITE_GUEST_AUTH],
          environment: {
            QE_PROXY_ACCESS: placeholder,
            QE_PROXY_ACCOUNT: accountIdFromPlaceholder(placeholder),
          },
          timeoutMs: 30_000,
        },
        { user: "agent" },
      );
      return { placeholder };
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
