import { expect, test } from "bun:test";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import {
  type HostPiCredentialResolution,
  resolveHostPiOpenAiCredential,
} from "../src/execution-environment/pi-host-credential.ts";
import { runPiHostCredentialHelper } from "../src/execution-environment/pi-host-credential-helper.ts";
import type {
  SbxClient,
  SbxDynamicSecretRequest,
} from "../src/execution-environment/sbx-client.ts";
import {
  createSbxPiProxyPlaceholder,
  SBX_PI_DYNAMIC_SECRET_REFRESH,
  SbxPiCredentialProvisioner,
} from "../src/execution-environment/sbx-pi-credential.ts";
import type { EnvironmentCommand } from "../src/execution-environment/types.ts";

const ACCOUNT_CLAIM = "https://api.openai.com/auth";

function accessToken(accountId: string, generation: number): string {
  const encode = (value: unknown) =>
    Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
  return [
    encode({ alg: "RS256", typ: "JWT" }),
    encode({
      [ACCOUNT_CLAIM]: { chatgpt_account_id: accountId },
      generation,
    }),
    `signature-${generation}`,
  ].join(".");
}

function credentialDocument(token: string, generation: number) {
  return {
    google: { type: "oauth", access: "unrelated", refresh: "unrelated" },
    "openai-codex": {
      type: "oauth",
      access: token,
      refresh: `refresh-${generation}`,
      expires: Date.now() + 60_000,
      accountId: "account-1",
    },
  };
}

async function withCredentialStore(
  run: (authPath: string) => Promise<void>,
): Promise<void> {
  const parent = join(process.cwd(), ".pi", "tmp");
  await mkdir(parent, { recursive: true });
  const directory = await mkdtemp(join(parent, "pi-host-credential-test-"));
  const authPath = join(directory, "auth.json");
  await writeFile(
    authPath,
    `${JSON.stringify(credentialDocument(accessToken("account-1", 0), 0))}\n`,
    { mode: 0o600 },
  );
  try {
    await run(authPath);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("host Pi resolver serializes native rotation and atomically preserves unrelated credentials", async () => {
  await withCredentialStore(async (authPath) => {
    let active = 0;
    let maxActive = 0;
    let generation = 0;
    const resolveWithPi = async (shadowPath: string) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await Bun.sleep(20);
      const document = JSON.parse(await readFile(shadowPath, "utf8"));
      generation += 1;
      const token = accessToken("account-1", generation);
      document["openai-codex"] = {
        type: "oauth",
        access: token,
        refresh: `refresh-${generation}`,
        expires: Date.now() + 3_600_000,
        accountId: "account-1",
      };
      await writeFile(shadowPath, `${JSON.stringify(document)}\n`);
      active -= 1;
      return token;
    };

    const results = await Promise.all([
      resolveHostPiOpenAiCredential({ authPath, resolveWithPi }),
      resolveHostPiOpenAiCredential({ authPath, resolveWithPi }),
    ]);
    const stored = JSON.parse(await readFile(authPath, "utf8"));
    expect(maxActive).toBe(1);
    expect(generation).toBe(2);
    expect(results.every((result) => result.persistedRotation)).toBe(true);
    expect(stored.google).toEqual({
      type: "oauth",
      access: "unrelated",
      refresh: "unrelated",
    });
    expect(stored["openai-codex"].access).toBe(accessToken("account-1", 2));
    expect((await stat(authPath)).mode & 0o777).toBe(0o600);
  });
});

test("forced refresh expires only the shadow and commits Pi's rotated result", async () => {
  await withCredentialStore(async (authPath) => {
    const result = await resolveHostPiOpenAiCredential({
      authPath,
      forceRefresh: true,
      resolveWithPi: async (shadowPath) => {
        const document = JSON.parse(await readFile(shadowPath, "utf8"));
        expect(document["openai-codex"].expires).toBe(0);
        const token = accessToken("account-1", 1);
        document["openai-codex"] = {
          ...document["openai-codex"],
          access: token,
          refresh: "refresh-1",
          expires: Date.now() + 3_600_000,
        };
        await writeFile(shadowPath, `${JSON.stringify(document)}\n`);
        return token;
      },
    });
    expect(result.persistedRotation).toBe(true);
    const stored = JSON.parse(await readFile(authPath, "utf8"));
    expect(stored["openai-codex"].expires).toBeGreaterThan(Date.now());
  });
});

test("host Pi resolver leaves the durable store unchanged on failed refresh", async () => {
  await withCredentialStore(async (authPath) => {
    const before = await readFile(authPath, "utf8");
    await expect(
      resolveHostPiOpenAiCredential({
        authPath,
        resolveWithPi: async (shadowPath) => {
          await writeFile(shadowPath, "partially-rotated");
          throw new Error("provider response containing sensitive material");
        },
      }),
    ).rejects.toThrow();
    expect(await readFile(authPath, "utf8")).toBe(before);
    expect((await stat(authPath)).mode & 0o777).toBe(0o600);
  });
});

test("host Pi resolver rejects account mismatch without committing it", async () => {
  await withCredentialStore(async (authPath) => {
    const before = await readFile(authPath, "utf8");
    await expect(
      resolveHostPiOpenAiCredential({
        authPath,
        resolveWithPi: async (shadowPath) => {
          const document = JSON.parse(await readFile(shadowPath, "utf8"));
          const token = accessToken("different-account", 1);
          document["openai-codex"] = {
            ...document["openai-codex"],
            access: token,
            expires: Date.now() + 3_600_000,
          };
          await writeFile(shadowPath, `${JSON.stringify(document)}\n`);
          return token;
        },
      }),
    ).rejects.toThrow("account id");
    expect(await readFile(authPath, "utf8")).toBe(before);
  });
});

test("host Pi resolver rejects broad auth-file permissions", async () => {
  await withCredentialStore(async (authPath) => {
    await chmod(authPath, 0o644);
    await expect(
      resolveHostPiOpenAiCredential({
        authPath,
        resolveWithPi: async () => accessToken("account-1", 1),
      }),
    ).rejects.toThrow("permissions");
  });
});

test("credential helper emits only the token and redacts all failures", async () => {
  const token = accessToken("account-1", 1);
  let stdout = "";
  let stderr = "";
  const success = await runPiHostCredentialHelper(
    async (): Promise<HostPiCredentialResolution> => ({
      accessToken: token,
      accountId: "account-1",
      authGeneration: "c".repeat(64),
      persistedRotation: false,
    }),
    { write: (value) => (stdout += value) },
    { write: (value) => (stderr += value) },
  );
  expect(success).toBe(0);
  expect(stdout).toBe(token);
  expect(stderr).toBe("");

  stdout = "";
  stderr = "";
  const failed = await runPiHostCredentialHelper(
    async () => {
      throw new Error(`sensitive ${token}`);
    },
    { write: (value) => (stdout += value) },
    { write: (value) => (stderr += value) },
  );
  expect(failed).toBe(1);
  expect(stdout).toBe("");
  expect(stderr).toBe("QE Pi host credential resolution failed.\n");
  expect(stderr).not.toContain(token);
});

test("Pi proxy placeholder is deterministic, account-bound, and cryptographically invalid", () => {
  const first = createSbxPiProxyPlaceholder("account-1", "sandbox-a");
  expect(createSbxPiProxyPlaceholder("account-1", "sandbox-a")).toBe(first);
  expect(createSbxPiProxyPlaceholder("account-1", "sandbox-b")).not.toBe(first);
  const [headerPart, payloadPart, signature] = first.split(".");
  expect(
    JSON.parse(Buffer.from(headerPart ?? "", "base64url").toString()),
  ).toEqual({
    alg: "none",
    typ: "JWT",
    kid: "qe-sbx-host-managed-v1",
  });
  const payload = JSON.parse(
    Buffer.from(payloadPart ?? "", "base64url").toString(),
  );
  expect(payload[ACCOUNT_CLAIM].chatgpt_account_id).toBe("account-1");
  expect(payload.qe_sbx_proxy).toEqual({
    version: 1,
    sandbox: expect.stringMatching(/^[a-f0-9]{32}$/),
  });
  expect(Buffer.from(signature ?? "", "base64url").toString()).toBe(
    "not-a-signature",
  );
});

test("sandbox provisioner stores only a scoped resolver command and nonsecret placeholder", async () => {
  const realToken = accessToken("account-1", 7);
  let dynamicSecret: SbxDynamicSecretRequest | undefined;
  let guestCommand: EnvironmentCommand | undefined;
  const client = {
    executable: "sbx",
    setDynamicSecret: async (request: SbxDynamicSecretRequest) => {
      dynamicSecret = request;
    },
    removeDynamicSecret: async () => {},
    exec: async (_sandbox: string, command: EnvironmentCommand) => {
      guestCommand = command;
      return { exitCode: 0, stdout: "", stderr: "" };
    },
  } as unknown as SbxClient;
  const provisioner = new SbxPiCredentialProvisioner(client, {
    resolveHostCredential: async () => ({
      accessToken: realToken,
      accountId: "account-1",
      authGeneration: "d".repeat(64),
      persistedRotation: false,
    }),
    resolverCommand: "/trusted/qe-pi-credential-helper",
  });

  const provision = await provisioner.provision("sandbox-a");
  expect(dynamicSecret).toEqual({
    sandboxName: "sandbox-a",
    placeholder: provision.placeholder,
    host: "chatgpt.com",
    resolverCommand: "/trusted/qe-pi-credential-helper",
    refreshInterval: SBX_PI_DYNAMIC_SECRET_REFRESH,
  });
  expect(JSON.stringify(dynamicSecret)).not.toContain(realToken);
  expect(JSON.stringify(guestCommand)).not.toContain(realToken);
  expect(guestCommand?.environment?.QE_PROXY_ACCESS).toBe(
    provision.placeholder,
  );
  expect(guestCommand?.environment?.QE_PROXY_AUTH_GENERATION).toBe(
    "d".repeat(64),
  );
});
