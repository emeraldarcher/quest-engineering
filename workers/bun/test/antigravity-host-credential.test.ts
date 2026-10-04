import { expect, test } from "bun:test";
import type { HostAntigravityCredentialResolution } from "../src/execution-environment/antigravity-host-credential.ts";
import { resolveHostAntigravityCredential } from "../src/execution-environment/antigravity-host-credential.ts";
import { runAntigravityHostCredentialHelper } from "../src/execution-environment/antigravity-host-credential-helper.ts";
import {
  SBX_ANTIGRAVITY_CREDENTIAL_HOSTS,
  SBX_ANTIGRAVITY_DYNAMIC_SECRET_REFRESH,
  SBX_ANTIGRAVITY_PROXY_REFRESH_SENTINEL,
  SbxAntigravityCredentialProvisioner,
} from "../src/execution-environment/sbx-antigravity-credential.ts";
import type {
  SbxClient,
  SbxDynamicSecretRequest,
} from "../src/execution-environment/sbx-client.ts";
import type { EnvironmentCommand } from "../src/execution-environment/types.ts";

const encode = (value: unknown) =>
  Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
const idToken = [
  encode({ alg: "RS256", typ: "JWT" }),
  encode({ sub: "native-antigravity-account" }),
  "signature",
].join(".");
const accessToken = "host-only-antigravity-access-token";
const credential = new TextEncoder().encode(
  JSON.stringify({
    auth_method: "consumer",
    id_token: idToken,
    token: {
      access_token: accessToken,
      refresh_token: "host-only-refresh-token",
      token_type: "Bearer",
      expiry: "2027-01-01T00:00:00.000Z",
    },
  }),
);

test("native Antigravity owns refresh while QE derives only scoped provenance", async () => {
  const resolved = await resolveHostAntigravityCredential({
    now: () => Date.parse("2026-01-01T00:00:00.000Z"),
    runNativeDiscovery: async () => ({
      version: "1.2.7",
      models: "gemini-3.8-flash-high\tGemini 3.8 Flash (High)\n",
    }),
    readNativeCredential: async () => credential,
  });
  expect(resolved).toMatchObject({
    accessToken,
    version: "1.2.7",
    expiresAt: "2027-01-01T00:00:00.000Z",
    accountScope: expect.stringMatching(/^[a-f0-9]{64}$/),
    authGeneration: expect.stringMatching(/^[a-f0-9]{64}$/),
  });
  expect(JSON.stringify(resolved)).not.toContain("host-only-refresh-token");
  expect(JSON.stringify(resolved)).not.toContain(idToken);
});

test("Antigravity helper emits only access authority and redacts failures", async () => {
  let stdout = "";
  let stderr = "";
  const resolution: HostAntigravityCredentialResolution = {
    accessToken,
    accountScope: "a".repeat(64),
    authGeneration: "b".repeat(64),
    expiresAt: "2027-01-01T00:00:00.000Z",
    executable: "/host/agy",
    version: "1.2.7",
  };
  expect(
    await runAntigravityHostCredentialHelper(
      async () => resolution,
      { write: (value) => (stdout += value) },
      { write: (value) => (stderr += value) },
    ),
  ).toBe(0);
  expect(stdout).toBe(accessToken);
  expect(stderr).toBe("");

  stdout = "";
  stderr = "";
  expect(
    await runAntigravityHostCredentialHelper(
      async () => {
        throw new Error(`sensitive ${accessToken}`);
      },
      { write: (value) => (stdout += value) },
      { write: (value) => (stderr += value) },
    ),
  ).toBe(1);
  expect(stdout).toBe("");
  expect(stderr).toBe("QE Antigravity host credential resolution failed.\n");
  expect(stderr).not.toContain(accessToken);
});

test("SBX receives nonsecret placeholders and no refresh or ID authority", async () => {
  let dynamicSecret: SbxDynamicSecretRequest | undefined;
  let guestCommand: EnvironmentCommand | undefined;
  const client = {
    setDynamicSecret: async (request: SbxDynamicSecretRequest) => {
      dynamicSecret = request;
    },
    removeDynamicSecret: async () => undefined,
    exec: async (_sandbox: string, command: EnvironmentCommand) => {
      guestCommand = command;
      return { exitCode: 0, stdout: "", stderr: "" };
    },
  } as unknown as SbxClient;
  const provisioner = new SbxAntigravityCredentialProvisioner(client, {
    resolveHostCredential: async () => ({
      accessToken,
      accountScope: "a".repeat(64),
      authGeneration: "b".repeat(64),
      expiresAt: "2027-01-01T00:00:00.000Z",
      executable: "/host/agy",
      version: "1.2.7",
    }),
    resolverCommand: "/trusted/qe-antigravity-credential-helper",
  });
  const provision = await provisioner.provision("sandbox-a");
  expect(SBX_ANTIGRAVITY_DYNAMIC_SECRET_REFRESH).toBe("1m");
  expect(dynamicSecret).toEqual({
    sandboxName: "sandbox-a",
    placeholder: provision.placeholder,
    hosts: SBX_ANTIGRAVITY_CREDENTIAL_HOSTS,
    resolverCommand: "/trusted/qe-antigravity-credential-helper",
    refreshInterval: SBX_ANTIGRAVITY_DYNAMIC_SECRET_REFRESH,
  });
  expect(JSON.stringify(dynamicSecret)).not.toContain(accessToken);
  expect(JSON.stringify(guestCommand)).not.toContain(accessToken);
  expect(JSON.stringify(guestCommand)).not.toContain("host-only-refresh-token");
  expect(guestCommand?.environment?.QE_PROXY_ACCESS).toBe(
    provision.placeholder,
  );
  const guestIdToken = guestCommand?.environment?.QE_PROXY_ID_TOKEN ?? "";
  expect(guestIdToken).not.toBe(idToken);
  expect(guestIdToken.split(".")).toHaveLength(3);
  expect(
    JSON.parse(
      Buffer.from(guestIdToken.split(".")[1] ?? "", "base64url").toString(),
    ).iss,
  ).toBe("qe-sbx-host-managed");
  expect(guestCommand?.args?.join(" ")).toContain(
    SBX_ANTIGRAVITY_PROXY_REFRESH_SENTINEL,
  );
});
