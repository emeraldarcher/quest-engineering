import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { claudeAccountEnvironment } from "../src/execution-environment/provider-account.ts";
import { claudeConfigIdentity } from "../src/execution-environment/sbx-run.ts";
import type { EnvironmentRef } from "../src/execution-environment/types.ts";
import {
  CLAUDE_FORBIDDEN_AUTH_SELECTOR_NAMES,
  CLAUDE_SUBSCRIPTION_CONFIGURATION,
  CLAUDE_SUBSCRIPTION_ENVIRONMENT_POLICY,
  classifyClaudeSubscriptionAuthStatus,
  claudeSubscriptionEnvironment,
  isProviderAuthenticationLoginEligible,
  unavailableProviderAuthenticationInspection,
} from "../src/provider-auth.ts";

const configDirectory = "/qe/state/claude-lineages/test/config";
const evidenceContext = {
  providerKey: "anthropic",
  owner: { kind: "provider_account" as const, id: "account-1", generation: 1 },
  backendKind: "sbx",
  environmentId: "environment-1",
  environmentIncarnation: "incarnation-1",
  profile: { id: "qe-claude-account-v1", digest: "sha256:test" },
  configuration: CLAUDE_SUBSCRIPTION_CONFIGURATION,
};

function status(
  exitCode: number,
  authMethod: string,
  loggedIn: boolean,
  apiProvider = authMethod === "claude.ai" ? "firstParty" : "none",
) {
  return classifyClaudeSubscriptionAuthStatus(
    {
      exitCode,
      stdout: JSON.stringify({
        loggedIn,
        authMethod,
        apiProvider,
        configDirectory,
      }),
    },
    configDirectory,
    evidenceContext,
  );
}

test("pinned Claude auth status maps only exact logged-out state to provider-account login eligibility", () => {
  const loggedOut = status(1, "none", false);
  expect(loggedOut).toMatchObject({
    state: "authentication_required",
    method: "none",
  });
  expect(isProviderAuthenticationLoginEligible(loggedOut)).toBe(true);

  const subscription = status(0, "claude.ai", true);
  expect(subscription).toMatchObject({
    state: "authenticated",
    method: "provider_account",
  });
  expect(isProviderAuthenticationLoginEligible(subscription)).toBe(false);

  const methods = [
    ["api_key", "api_key"],
    ["oauth_token", "injected_oauth_token"],
    ["api_key_helper", "api_key_helper"],
  ] as const;
  for (const [method, canonical] of methods) {
    const forbidden = status(0, method, true);
    expect(forbidden).toMatchObject({
      state: "forbidden_auth_method",
      method: canonical,
    });
    expect(isProviderAuthenticationLoginEligible(forbidden)).toBe(false);
  }

  for (const provider of ["bedrock", "vertex", "foundry"] as const)
    expect(status(0, "third_party", true, provider)).toMatchObject({
      state: "forbidden_auth_method",
      method: "third_party",
    });

  expect(
    classifyClaudeSubscriptionAuthStatus(
      { exitCode: 0, stdout: "not-json" },
      configDirectory,
      evidenceContext,
    ),
  ).toMatchObject({ state: "incompatible_status", method: null });
  expect(
    unavailableProviderAuthenticationInspection(evidenceContext),
  ).toMatchObject({
    state: "inspection_unavailable",
    method: null,
  });
});

test("contradictory, unknown, and wrong-directory status is never login-eligible", () => {
  const candidates = [
    status(0, "none", false),
    status(1, "claude.ai", true),
    classifyClaudeSubscriptionAuthStatus(
      {
        exitCode: 1,
        stdout: JSON.stringify({
          loggedIn: false,
          authMethod: "future_method",
          apiProvider: "future",
          configDirectory,
        }),
      },
      configDirectory,
      evidenceContext,
    ),
    classifyClaudeSubscriptionAuthStatus(
      {
        exitCode: 1,
        stdout: JSON.stringify({
          loggedIn: false,
          authMethod: "none",
          apiProvider: "none",
          configDirectory: "/wrong/config",
        }),
      },
      configDirectory,
      evidenceContext,
    ),
  ];
  for (const candidate of candidates) {
    expect(candidate.state).toBe("incompatible_status");
    expect(isProviderAuthenticationLoginEligible(candidate)).toBe(false);
  }
});

test("subscription environment is an exact allowlist with all provider selectors absent", () => {
  const environment = claudeSubscriptionEnvironment(configDirectory);
  expect(environment).toMatchObject({
    HOME: configDirectory,
    CLAUDE_CONFIG_DIR: configDirectory,
    BROWSER: "/bin/false",
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
  });
  for (const name of CLAUDE_FORBIDDEN_AUTH_SELECTOR_NAMES)
    expect(environment).not.toHaveProperty(name);
  expect(environment).not.toHaveProperty("AWS_ACCESS_KEY_ID");
  expect(environment).not.toHaveProperty("GOOGLE_APPLICATION_CREDENTIALS");
  expect(environment).not.toHaveProperty("AZURE_CLIENT_SECRET");
  expect(environment).not.toHaveProperty("HTTP_PROXY");

  expect(() =>
    claudeAccountEnvironment(configDirectory, {
      ANTHROPIC_API_KEY: "forbidden",
    }),
  ).toThrow("not allowlisted");
  expect(() =>
    claudeAccountEnvironment(configDirectory, {
      PATH: "/untrusted",
    }),
  ).toThrow("not allowlisted");
});

test("configuration identity fences subscription mode and environment policy without changing profile identity", () => {
  const environment: EnvironmentRef = {
    backendKind: "sbx",
    environmentId: "environment-1",
    incarnation: "incarnation-1",
    workerId: "worker-1",
    owner: { kind: "run", runId: "run-1" },
    profile: {
      id: "qe-coding-execution-v3",
      digest:
        "sha256:3085d323073b1917b19cf269104236fd5aab9f72bd28a14312e2cdfc6bc107e8",
    },
  };
  const expected = createHash("sha256")
    .update(
      JSON.stringify({
        runId: "run-1",
        lineageId: "lineage-1",
        environmentId: "environment-1",
        incarnation: "incarnation-1",
        profile: environment.profile,
        configDirectory,
        authentication: {
          mode: "subscription",
          loginMode: "subscription_login",
          environmentPolicy: CLAUDE_SUBSCRIPTION_ENVIRONMENT_POLICY,
        },
      }),
    )
    .digest("hex");
  expect(
    claudeConfigIdentity("run-1", "lineage-1", environment, configDirectory),
  ).toBe(expected);
  expect(environment.profile).toEqual({
    id: "qe-coding-execution-v3",
    digest:
      "sha256:3085d323073b1917b19cf269104236fd5aab9f72bd28a14312e2cdfc6bc107e8",
  });
});
