import { afterEach, expect, mock, test } from "bun:test";
import { ApiClient } from "./client";

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

test("ProviderAccount client decodes layered readiness and uses local setup endpoints", async () => {
  const requests: Array<{ path: string; init?: RequestInit }> = [];
  globalThis.fetch = mock(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      requests.push({ path, ...(init ? { init } : {}) });
      if (path.includes("/interactions/")) {
        const publicKey = new Headers(init?.headers).get(
          "x-qe-interaction-public-key",
        );
        if (!publicKey) throw new Error("Missing interaction public key.");
        return new Response(
          JSON.stringify({
            interaction: {
              output: await sealInteraction(
                "ephemeral fake interaction",
                publicKey,
              ),
              expires_at: "2026-10-15T00:05:00Z",
            },
          }),
        );
      }
      if (path.endsWith("/setup-attempts"))
        return new Response(
          JSON.stringify({ setup_attempt: setupAttemptFixture() }),
        );
      return new Response(
        JSON.stringify({ provider_account: accountFixture() }),
      );
    },
  ) as unknown as typeof fetch;

  const api = new ApiClient({
    httpBaseUrl: "http://127.0.0.1:4000/api/v1",
    localTauriClient: true,
  });
  const account = await api.getProviderAccount("account/one");
  const setup = await api.authorizeProviderAccountSetup(
    "account/one",
    "request-1",
  );
  const interaction = await api.getProviderAccountSetupInteraction(
    "account/one",
    setup.id,
    setup.setup_generation,
    setup.attention?.attention_id as string,
  );

  expect(account.readiness).toEqual({
    semantic: "semantically_connected",
    environment: "available",
    authentication: "authentication_required",
    inference: "not_evaluated",
  });
  expect(account.environment?.credential_generation).toBe(1);
  expect(setup.credential_generation_before).toBe(1);
  expect(setup.environment_generation).toBe(1);
  expect(interaction.output).toBe("ephemeral fake interaction");
  expect(requests[1]?.init?.headers).toEqual(
    expect.objectContaining({ "x-quest-engineering-local-client": "tauri" }),
  );
  expect(requests[2]?.init?.headers).toEqual(
    expect.objectContaining({
      "x-quest-engineering-local-client": "tauri",
      "x-qe-interaction-public-key": expect.any(String),
    }),
  );
});

async function sealInteraction(output: string, encodedPublicKey: string) {
  const publicKey = await crypto.subtle.importKey(
    "spki",
    base64ToBytes(encodedPublicKey),
    { name: "RSA-OAEP", hash: "SHA-256" },
    false,
    ["encrypt"],
  );
  const aesKey = await crypto.subtle.generateKey(
    { name: "AES-GCM", length: 256 },
    true,
    ["encrypt"],
  );
  const rawKey = await crypto.subtle.exportKey("raw", aesKey);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv, tagLength: 128 },
      aesKey,
      new TextEncoder().encode(output),
    ),
  );
  const ciphertext = encrypted.slice(0, -16);
  const tag = encrypted.slice(-16);
  const encryptedKey = await crypto.subtle.encrypt(
    { name: "RSA-OAEP" },
    publicKey,
    rawKey,
  );
  return {
    version: "rsa-oaep-sha256-aes-256-gcm-v1",
    encrypted_key: bytesToBase64(new Uint8Array(encryptedKey)),
    iv: bytesToBase64(iv),
    ciphertext: bytesToBase64(ciphertext),
    tag: bytesToBase64(tag),
  };
}

function bytesToBase64(value: Uint8Array): string {
  let binary = "";
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function base64ToBytes(value: string): Uint8Array<ArrayBuffer> {
  const binary = atob(value);
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let index = 0; index < binary.length; index += 1)
    bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function accountFixture() {
  return {
    id: "account/one",
    provider_key: "fake",
    display_name: null,
    worker_id: "worker-1",
    credential_generation: 1,
    lifecycle_state: "connected",
    readiness: {
      semantic: "semantically_connected",
      environment: "available",
      authentication: "authentication_required",
      inference: "not_evaluated",
    },
    capabilities: { can_authorize_setup: true },
    authentication: authenticationEvidence(),
    environment: {
      credential_generation: 1,
      worker_id: "worker-1",
      worker_generation: 7,
      operation_id: "operation-1",
      desired_state: "available",
      backend_kind: "fake-account",
      environment_id: "environment-1",
      incarnation: "incarnation-1",
      physical_state: "available",
      durable_canary_persisted: true,
      last_error: null,
      observed_at: "2026-10-15T00:00:00Z",
    },
    authenticated_at: null,
    last_validated_at: null,
    inserted_at: "2026-10-15T00:00:00Z",
    updated_at: "2026-10-15T00:00:00Z",
  };
}

function authenticationEvidence() {
  return {
    state: "authentication_required",
    method: "none",
    configuration_identity: "qe-fake-provider-account-auth-v1",
    environment_policy: "qe-fake-provider-account-explicit-environment-v1",
    evidence_identity: "provider-auth-evidence-v1:test",
    inspected_at: "2026-10-15T00:00:00Z",
  };
}

function setupAttemptFixture() {
  return {
    id: "setup-1",
    provider_account_id: "account/one",
    setup_generation: 1,
    credential_generation_before: 1,
    credential_generation_after: null,
    environment_generation: 1,
    worker_id: "worker-1",
    worker_generation: 7,
    authorized_authentication: authenticationEvidence(),
    state: "human_interaction_required",
    invocation_state: "acknowledged",
    process: {
      backend_process_id: "pid-1",
      process_start_identity: "start-1",
      process_generation: "process-1",
      executable: "/usr/bin/qe-fake-provider-login",
    },
    attention: {
      attention_id: "attention-1",
      request_generation: 1,
      kind: "provider_authentication",
      message: "Complete deterministic sign-in.",
      response_state: "pending",
      delivery_state: "response_not_delivered",
      delivery_attempt_id: null,
      surfaced_at: "2026-10-15T00:00:01Z",
    },
    preflight: authenticationEvidence(),
    validation: null,
    failure: null,
    authorized_at: "2026-10-15T00:00:00Z",
    invocation_requested_at: "2026-10-15T00:00:01Z",
    invocation_acknowledged_at: "2026-10-15T00:00:01Z",
    interaction_required_at: "2026-10-15T00:00:01Z",
    succeeded_at: null,
    cancelled_at: null,
    updated_at: "2026-10-15T00:00:01Z",
  };
}
