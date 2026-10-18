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
  profile: { id: "qe-claude-account-v2", digest: "sha256:test" },
  configuration: CLAUDE_SUBSCRIPTION_CONFIGURATION,
};

function nativeStatus(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    loggedIn: false,
    authMethod: "none",
    apiProvider: "firstParty",
    analyticsDisabled: true,
    projectsDirectory: `${configDirectory}/projects`,
    configDirectory,
    ...overrides,
  };
}

function classify(exitCode: number, payload: Record<string, unknown>) {
  return classifyClaudeSubscriptionAuthStatus(
    { exitCode, stdout: JSON.stringify(payload) },
    configDirectory,
    evidenceContext,
  );
}

test("exact pinned 2.1.292 logged-out and subscription fixtures classify canonically", () => {
  const loggedOut = classify(1, nativeStatus());
  expect(loggedOut).toMatchObject({
    state: "authentication_required",
    method: "none",
  });
  expect(isProviderAuthenticationLoginEligible(loggedOut)).toBe(true);

  const loggedOutWithPolicy = classify(
    1,
    nativeStatus({
      projectsDirectory: null,
      forcedLoginMethod: "claudeai",
      allowedProviders: ["anthropic"],
    }),
  );
  expect(loggedOutWithPolicy).toMatchObject({
    state: "authentication_required",
    method: "none",
  });

  const subscription = classify(
    0,
    nativeStatus({
      loggedIn: true,
      authMethod: "claude.ai",
      email: "private@example.invalid",
      orgId: "private-org-id",
      orgName: "private-org-name",
      subscriptionType: "private-subscription",
    }),
  );
  expect(subscription).toMatchObject({
    state: "authenticated",
    method: "provider_account",
  });
  expect(isProviderAuthenticationLoginEligible(subscription)).toBe(false);
  expect(JSON.stringify(subscription)).not.toContain("private@");
  expect(JSON.stringify(subscription)).not.toContain("private-org");
  expect(JSON.stringify(subscription)).not.toContain("private-subscription");
});

test("pinned forbidden selectors and third-party providers fail closed without login eligibility", () => {
  const methods = [
    ["api_key", "api_key", { apiKeySource: "ANTHROPIC_API_KEY" }],
    ["oauth_token", "injected_oauth_token", {}],
    ["api_key_helper", "api_key_helper", { apiKeySource: "apiKeyHelper" }],
  ] as const;
  for (const [method, canonical, metadata] of methods) {
    const forbidden = classify(
      0,
      nativeStatus({ loggedIn: true, authMethod: method, ...metadata }),
    );
    expect(forbidden).toMatchObject({
      state: "forbidden_auth_method",
      method: canonical,
    });
    expect(isProviderAuthenticationLoginEligible(forbidden)).toBe(false);
  }

  expect(
    classify(
      0,
      nativeStatus({
        loggedIn: true,
        authMethod: "api_key",
        apiKeySource: "/login managed key",
        email: null,
        orgId: null,
        orgName: null,
      }),
    ),
  ).toMatchObject({ state: "forbidden_auth_method", method: "api_key" });

  for (const provider of [
    "bedrock",
    "vertex",
    "foundry",
    "anthropicAws",
    "anthropicGoogleCloud",
    "mantle",
    "gateway",
  ] as const) {
    const metadata = provider === "gateway" ? { email: null } : {};
    expect(
      classify(
        0,
        nativeStatus({
          loggedIn: true,
          authMethod: "third_party",
          apiProvider: provider,
          ...metadata,
        }),
      ),
    ).toMatchObject({
      state: "forbidden_auth_method",
      method: "third_party",
    });
  }
});

test("malformed, unsupported, incomplete, and contradictory 2.1.292 status is never login-eligible", () => {
  const subscription = nativeStatus({
    loggedIn: true,
    authMethod: "claude.ai",
    email: null,
    orgId: null,
    orgName: null,
    subscriptionType: null,
  });
  const missingAnalytics = nativeStatus();
  delete missingAnalytics.analyticsDisabled;
  const candidates = [
    classify(0, nativeStatus()),
    classify(1, subscription),
    classify(1, nativeStatus({ apiProvider: "none" })),
    classify(1, nativeStatus({ authMethod: "future_method" })),
    classify(1, nativeStatus({ apiProvider: "future" })),
    classify(1, nativeStatus({ configDirectory: "/wrong/config" })),
    classify(1, nativeStatus({ futureField: true })),
    classify(1, nativeStatus({ analyticsDisabled: "yes" })),
    classify(1, nativeStatus({ projectsDirectory: 123 })),
    classify(1, nativeStatus({ allowedProviders: ["unknown"] })),
    classify(1, nativeStatus({ email: "unexpected@example.invalid" })),
    classify(1, nativeStatus({ apiProvider: "gateway", email: null })),
    classify(0, { ...subscription, apiKeySource: "ANTHROPIC_API_KEY" }),
    classify(0, nativeStatus({ loggedIn: true, authMethod: "api_key" })),
    classify(
      0,
      nativeStatus({
        loggedIn: true,
        authMethod: "third_party",
        apiProvider: "firstParty",
      }),
    ),
    classify(1, missingAnalytics),
    classify(0, {
      ...subscription,
      subscriptionType: undefined,
    }),
    classifyClaudeSubscriptionAuthStatus(
      { exitCode: 0, stdout: "not-json" },
      configDirectory,
      evidenceContext,
    ),
  ];
  for (const candidate of candidates) {
    expect(candidate.state).toBe("incompatible_status");
    expect(isProviderAuthenticationLoginEligible(candidate)).toBe(false);
  }
  expect(
    classifyClaudeSubscriptionAuthStatus(
      { exitCode: 127, stdout: "" },
      configDirectory,
      evidenceContext,
    ),
  ).toMatchObject({ state: "inspection_unavailable", method: null });
  expect(
    unavailableProviderAuthenticationInspection(evidenceContext),
  ).toMatchObject({
    state: "inspection_unavailable",
    method: null,
  });
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
