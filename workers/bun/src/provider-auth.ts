import { createHash } from "node:crypto";

/** Provider-neutral authentication observations persisted across Product/Worker boundaries. */
export type ProviderAuthenticationState =
  | "authentication_required"
  | "authenticated"
  | "forbidden_auth_method"
  | "inspection_unavailable"
  | "incompatible_status";

export type ProviderAuthenticationMethod =
  | "none"
  | "provider_account"
  | "injected_oauth_token"
  | "api_key"
  | "api_key_helper"
  | "third_party";

export interface ProviderAuthenticationConfiguration {
  identity: string;
  mode: string;
  loginMode: string;
  environmentPolicy: string;
}

export interface ProviderAuthenticationInspection {
  state: ProviderAuthenticationState;
  method: ProviderAuthenticationMethod | null;
  configuration: ProviderAuthenticationConfiguration;
  evidenceIdentity: string;
  inspectedAt: string;
  detail: string;
}

export const CLAUDE_SUBSCRIPTION_AUTH_MODE = "subscription" as const;
export const CLAUDE_SUBSCRIPTION_LOGIN_MODE = "subscription_login" as const;
export const CLAUDE_SUBSCRIPTION_ENVIRONMENT_POLICY =
  "claude-subscription-explicit-environment-v1" as const;
export const CLAUDE_SUBSCRIPTION_AUTH_CONFIGURATION =
  "claude-code-2.1.292-subscription-v1" as const;

// This configuration identity already pins the 2.1.292 status contract. Decoder
// corrections do not create a second inspector epoch or change evidence identity.
export const CLAUDE_SUBSCRIPTION_CONFIGURATION = Object.freeze({
  identity: CLAUDE_SUBSCRIPTION_AUTH_CONFIGURATION,
  mode: CLAUDE_SUBSCRIPTION_AUTH_MODE,
  loginMode: CLAUDE_SUBSCRIPTION_LOGIN_MODE,
  environmentPolicy: CLAUDE_SUBSCRIPTION_ENVIRONMENT_POLICY,
});

export const FAKE_PROVIDER_AUTH_CONFIGURATION = Object.freeze({
  identity: "qe-fake-provider-account-auth-v1",
  mode: "provider_account",
  loginMode: "deterministic_fake_login",
  environmentPolicy: "qe-fake-provider-account-explicit-environment-v1",
});

export const CLAUDE_FORBIDDEN_AUTH_SELECTOR_NAMES = Object.freeze([
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_PROFILE",
  "ANTHROPIC_IDENTITY_TOKEN_FILE",
  "ANTHROPIC_FEDERATION_RULE_ID",
  "ANTHROPIC_ORGANIZATION_ID",
  "ANTHROPIC_AWS_WORKSPACE_ID",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
  "CLAUDE_CODE_USE_FOUNDRY",
  "CLAUDE_CODE_USE_ANTHROPIC_AWS",
] as const);

interface AuthStatusResult {
  exitCode: number;
  stdout: string;
}

type ClaudeAuthMethod =
  | "none"
  | "claude.ai"
  | "oauth_token"
  | "api_key"
  | "api_key_helper"
  | "third_party";

type ClaudeApiProvider =
  | "firstParty"
  | "bedrock"
  | "vertex"
  | "foundry"
  | "anthropicAws"
  | "anthropicGoogleCloud"
  | "mantle"
  | "gateway";

interface ClaudeAuthStatusPayload {
  loggedIn: boolean;
  authMethod: ClaudeAuthMethod;
  apiProvider: ClaudeApiProvider;
  configDirectory: string;
}

const knownClaudeAuthMethods = new Set<ClaudeAuthMethod>([
  "none",
  "claude.ai",
  "oauth_token",
  "api_key",
  "api_key_helper",
  "third_party",
]);
const knownClaudeApiProviders = new Set<ClaudeApiProvider>([
  "firstParty",
  "bedrock",
  "vertex",
  "foundry",
  "anthropicAws",
  "anthropicGoogleCloud",
  "mantle",
  "gateway",
]);
const thirdPartyClaudeApiProviders = new Set<ClaudeApiProvider>([
  "bedrock",
  "vertex",
  "foundry",
  "anthropicAws",
  "anthropicGoogleCloud",
  "mantle",
  "gateway",
]);
const knownAllowedProviderValues = new Set([
  "anthropic",
  "customEndpoint",
  "bedrock",
  "vertex",
  "foundry",
  "anthropicAws",
  "mantle",
  "gateway",
]);
const requiredClaudeAuthStatusFields = Object.freeze([
  "loggedIn",
  "authMethod",
  "apiProvider",
  "analyticsDisabled",
  "projectsDirectory",
  "configDirectory",
]);
const optionalClaudeAuthStatusFields = new Set([
  "forcedLoginMethod",
  "allowedProviders",
  "apiKeySource",
  "email",
  "orgId",
  "orgName",
  "subscriptionType",
]);

/**
 * The one exact environment policy used by Claude subscription inspection,
 * login, and execution. It is an allowlist: provider selectors, cloud
 * credentials, gateways, and host proxy variables are absent.
 */
export function claudeSubscriptionEnvironment(
  configDirectory: string,
  options: { sdkClientApp?: string } = {},
): Record<string, string> {
  return {
    HOME: configDirectory,
    CLAUDE_CONFIG_DIR: configDirectory,
    TMPDIR: `${configDirectory}/tmp`,
    PATH: "/usr/bin:/bin",
    LANG: "C.UTF-8",
    BROWSER: "/bin/false",
    GIT_TERMINAL_PROMPT: "0",
    DISABLE_AUTOUPDATER: "1",
    DISABLE_TELEMETRY: "1",
    DISABLE_ERROR_REPORTING: "1",
    DISABLE_FEEDBACK_COMMAND: "1",
    ENABLE_CLAUDEAI_MCP_SERVERS: "false",
    ENABLE_TOOL_SEARCH: "false",
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    CLAUDE_CODE_DISABLE_FEEDBACK_SURVEY: "1",
    CLAUDE_CODE_DISABLE_OFFICIAL_MARKETPLACE_AUTOINSTALL: "1",
    CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
    CLAUDE_CODE_DISABLE_CLAUDE_MDS: "1",
    CLAUDE_CODE_DISABLE_BUNDLED_SKILLS: "1",
    CLAUDE_CODE_DISABLE_AGENT_VIEW: "1",
    CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: "1",
    CLAUDE_CODE_DISABLE_EXPLORE_PLAN_AGENTS: "1",
    CLAUDE_AGENT_SDK_DISABLE_BUILTIN_AGENTS: "1",
    CLAUDE_CODE_DISABLE_GIT_INSTRUCTIONS: "1",
    CLAUDE_CODE_DISABLE_ADVISOR_TOOL: "1",
    CLAUDE_CODE_DISABLE_ARTIFACT: "1",
    CLAUDE_CODE_DISABLE_FAST_MODE: "1",
    ...(options.sdkClientApp
      ? { CLAUDE_AGENT_SDK_CLIENT_APP: options.sdkClientApp }
      : {}),
  };
}

/** Classifies only the pinned Claude Code 2.1.292 default JSON contract. */
export function classifyClaudeSubscriptionAuthStatus(
  result: AuthStatusResult,
  expectedConfigDirectory: string,
  context: ProviderAuthenticationEvidenceContext,
  inspectedAt = new Date().toISOString(),
): ProviderAuthenticationInspection {
  if (result.exitCode !== 0 && result.exitCode !== 1)
    return unavailableProviderAuthenticationInspection(context, inspectedAt);
  let nativePayload: unknown;
  try {
    nativePayload = JSON.parse(result.stdout);
  } catch {
    return authenticationInspection(
      "incompatible_status",
      null,
      context,
      inspectedAt,
      "Claude authentication status output was incompatible with the pinned contract.",
    );
  }
  const payload = decodeClaudeAuthStatusPayload(nativePayload);
  if (!payload)
    return authenticationInspection(
      "incompatible_status",
      null,
      context,
      inspectedAt,
      "Claude authentication status output was incompatible with the pinned contract.",
    );

  const method = canonicalClaudeMethod(payload.authMethod);
  if (payload.configDirectory !== expectedConfigDirectory)
    return authenticationInspection(
      "incompatible_status",
      method,
      context,
      inspectedAt,
      "Claude authentication status was reported for a different configuration directory.",
    );

  if (
    result.exitCode === 1 &&
    payload.loggedIn === false &&
    payload.authMethod === "none" &&
    payload.apiProvider === "firstParty"
  )
    return authenticationInspection(
      "authentication_required",
      "none",
      context,
      inspectedAt,
      "Provider-account authentication is required.",
    );

  if (
    result.exitCode === 0 &&
    payload.loggedIn === true &&
    payload.authMethod === "claude.ai" &&
    payload.apiProvider === "firstParty"
  )
    return authenticationInspection(
      "authenticated",
      "provider_account",
      context,
      inspectedAt,
      "Provider-account authentication is ready.",
    );

  if (
    result.exitCode === 0 &&
    payload.loggedIn === true &&
    payload.authMethod !== "none" &&
    payload.authMethod !== "claude.ai" &&
    ((payload.authMethod === "third_party" &&
      thirdPartyClaudeApiProviders.has(payload.apiProvider)) ||
      (payload.authMethod !== "third_party" &&
        payload.apiProvider === "firstParty"))
  )
    return authenticationInspection(
      "forbidden_auth_method",
      method,
      context,
      inspectedAt,
      "Claude selected a forbidden authentication method.",
    );

  return authenticationInspection(
    "incompatible_status",
    method,
    context,
    inspectedAt,
    "Claude authentication status was contradictory or incompatible with provider-account authentication.",
  );
}

export interface ProviderAuthenticationEvidenceContext {
  providerKey: string;
  owner: {
    kind: "provider_account" | "run";
    id: string;
    generation: number | null;
  };
  backendKind: string;
  environmentId: string;
  environmentIncarnation: string;
  profile: { id: string; digest: string };
  configuration: ProviderAuthenticationConfiguration;
}

export function authenticationInspection(
  state: ProviderAuthenticationState,
  method: ProviderAuthenticationMethod | null,
  context: ProviderAuthenticationEvidenceContext,
  inspectedAt: string,
  detail: string,
): ProviderAuthenticationInspection {
  if (!validAuthenticationPair(state, method))
    throw new Error("Provider authentication state/method pair is invalid.");
  const configuration = { ...context.configuration };
  return {
    state,
    method,
    configuration,
    evidenceIdentity: providerAuthenticationEvidenceIdentity(
      context,
      state,
      method,
    ),
    inspectedAt,
    detail,
  };
}

export function unavailableProviderAuthenticationInspection(
  context: ProviderAuthenticationEvidenceContext,
  inspectedAt = new Date().toISOString(),
): ProviderAuthenticationInspection {
  return authenticationInspection(
    "inspection_unavailable",
    null,
    context,
    inspectedAt,
    "Provider authentication status could not be inspected.",
  );
}

export function isProviderAuthenticationLoginEligible(value: {
  state: string;
  method: string | null;
}): boolean {
  return value.state === "authentication_required" && value.method === "none";
}

export function isProviderAuthenticationReady(value: {
  state: string;
  method: string | null;
}): boolean {
  return value.state === "authenticated" && value.method === "provider_account";
}

export function sameAuthenticationConfiguration(
  left: ProviderAuthenticationConfiguration,
  right: ProviderAuthenticationConfiguration,
): boolean {
  return (
    left.identity === right.identity &&
    left.mode === right.mode &&
    left.loginMode === right.loginMode &&
    left.environmentPolicy === right.environmentPolicy
  );
}

export function providerAuthenticationEvidenceIdentity(
  context: ProviderAuthenticationEvidenceContext,
  state: ProviderAuthenticationState,
  method: ProviderAuthenticationMethod | null,
): string {
  return `provider-auth-evidence-v1:${createHash("sha256")
    .update(
      JSON.stringify({
        providerKey: context.providerKey,
        owner: context.owner,
        backendKind: context.backendKind,
        environmentId: context.environmentId,
        environmentIncarnation: context.environmentIncarnation,
        profile: context.profile,
        configuration: context.configuration,
        state,
        method,
      }),
    )
    .digest("hex")}`;
}

function validAuthenticationPair(
  state: ProviderAuthenticationState,
  method: ProviderAuthenticationMethod | null,
): boolean {
  switch (state) {
    case "authentication_required":
      return method === "none";
    case "authenticated":
      return method === "provider_account";
    case "forbidden_auth_method":
      return (
        method === "injected_oauth_token" ||
        method === "api_key" ||
        method === "api_key_helper" ||
        method === "third_party"
      );
    case "inspection_unavailable":
      return method === null;
    case "incompatible_status":
      return true;
  }
}

function canonicalClaudeMethod(
  value: ClaudeAuthMethod,
): ProviderAuthenticationMethod {
  switch (value) {
    case "none":
      return "none";
    case "claude.ai":
      return "provider_account";
    case "oauth_token":
      return "injected_oauth_token";
    case "api_key":
      return "api_key";
    case "api_key_helper":
      return "api_key_helper";
    case "third_party":
      return "third_party";
  }
}

/**
 * Strict projection of Claude Code 2.1.292's `claude auth status` JSON.
 *
 * The pinned native implementation always emits the six required fields below.
 * It may additionally emit known policy/source metadata and account metadata.
 * Those fields are type-checked here but intentionally discarded: email,
 * organization identity/name, subscription type, and credential-source paths
 * never enter canonical evidence, persistence, protocol, or telemetry.
 */
function decodeClaudeAuthStatusPayload(
  value: unknown,
): ClaudeAuthStatusPayload | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  const keys = Object.keys(candidate);
  if (
    requiredClaudeAuthStatusFields.some((field) => !keys.includes(field)) ||
    keys.some(
      (field) =>
        !requiredClaudeAuthStatusFields.includes(field) &&
        !optionalClaudeAuthStatusFields.has(field),
    )
  )
    return null;
  if (
    typeof candidate.loggedIn !== "boolean" ||
    typeof candidate.authMethod !== "string" ||
    !knownClaudeAuthMethods.has(candidate.authMethod as ClaudeAuthMethod) ||
    typeof candidate.apiProvider !== "string" ||
    !knownClaudeApiProviders.has(candidate.apiProvider as ClaudeApiProvider) ||
    typeof candidate.analyticsDisabled !== "boolean" ||
    !isNullableString(candidate.projectsDirectory) ||
    typeof candidate.configDirectory !== "string" ||
    candidate.configDirectory.length === 0
  )
    return null;

  if (
    has(candidate, "forcedLoginMethod") &&
    !["claudeai", "console", "gateway"].includes(
      candidate.forcedLoginMethod as string,
    )
  )
    return null;
  if (
    has(candidate, "allowedProviders") &&
    (!Array.isArray(candidate.allowedProviders) ||
      candidate.allowedProviders.some(
        (provider) =>
          typeof provider !== "string" ||
          !knownAllowedProviderValues.has(provider),
      ) ||
      new Set(candidate.allowedProviders).size !==
        candidate.allowedProviders.length)
  )
    return null;
  if (
    has(candidate, "apiKeySource") &&
    (typeof candidate.apiKeySource !== "string" ||
      candidate.apiKeySource.length === 0)
  )
    return null;
  for (const field of ["email", "orgId", "orgName", "subscriptionType"])
    if (has(candidate, field) && !isNullableString(candidate[field]))
      return null;

  const method = candidate.authMethod as ClaudeAuthMethod;
  const provider = candidate.apiProvider as ClaudeApiProvider;
  const accountFields = ["email", "orgId", "orgName", "subscriptionType"];
  if (
    method === "claude.ai" &&
    accountFields.some((field) => !has(candidate, field))
  )
    return null;
  if (method !== "claude.ai" && has(candidate, "subscriptionType")) return null;
  if (
    (method === "none" || method === "claude.ai") &&
    has(candidate, "apiKeySource")
  )
    return null;
  if (method === "api_key" && !has(candidate, "apiKeySource")) return null;
  if (
    method === "api_key_helper" &&
    has(candidate, "apiKeySource") &&
    candidate.apiKeySource !== "apiKeyHelper"
  )
    return null;

  const managedApiKey =
    method === "api_key" && candidate.apiKeySource === "/login managed key";
  if (
    managedApiKey &&
    ["email", "orgId", "orgName"].some((field) => !has(candidate, field))
  )
    return null;
  if (
    method !== "claude.ai" &&
    !managedApiKey &&
    ["orgId", "orgName"].some((field) => has(candidate, field))
  )
    return null;
  if (
    method !== "claude.ai" &&
    !managedApiKey &&
    has(candidate, "email") !== (provider === "gateway")
  )
    return null;
  return {
    loggedIn: candidate.loggedIn as boolean,
    authMethod: method,
    apiProvider: provider,
    configDirectory: candidate.configDirectory as string,
  };
}

function has(value: Record<string, unknown>, field: string): boolean {
  return Object.hasOwn(value, field);
}

function isNullableString(value: unknown): boolean {
  return value === null || typeof value === "string";
}
