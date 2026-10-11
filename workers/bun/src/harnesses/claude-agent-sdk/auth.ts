export const CLAUDE_SUBSCRIPTION_AUTH_MODE = "subscription" as const;
export const CLAUDE_SUBSCRIPTION_LOGIN_MODE = "subscription_login" as const;
export const CLAUDE_SUBSCRIPTION_ENVIRONMENT_POLICY =
  "claude-subscription-explicit-environment-v1" as const;

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

export type ClaudeSubscriptionAuthState =
  | "authentication_required"
  | "subscription_authenticated"
  | "forbidden_auth_method"
  | "inspection_unavailable"
  | "incompatible_status";

export type ClaudeSubscriptionAuthMethod =
  | "none"
  | "claude.ai"
  | "oauth_token"
  | "api_key"
  | "api_key_helper"
  | "third_party";

export interface ClaudeSubscriptionAuthInspection {
  authMode: typeof CLAUDE_SUBSCRIPTION_AUTH_MODE;
  loginMode: typeof CLAUDE_SUBSCRIPTION_LOGIN_MODE;
  environmentPolicy: typeof CLAUDE_SUBSCRIPTION_ENVIRONMENT_POLICY;
  authState: ClaudeSubscriptionAuthState;
  authMethod: ClaudeSubscriptionAuthMethod | null;
  detail: string;
}

interface AuthStatusResult {
  exitCode: number;
  stdout: string;
}

interface AuthStatusPayload {
  loggedIn: boolean;
  authMethod: ClaudeSubscriptionAuthMethod;
  apiProvider: string;
  configDirectory: string;
}

const knownAuthMethods = new Set<ClaudeSubscriptionAuthMethod>([
  "none",
  "claude.ai",
  "oauth_token",
  "api_key",
  "api_key_helper",
  "third_party",
]);

/**
 * The one explicit environment used by Claude subscription inspection, login,
 * and execution. Callers may add the SDK client marker only for the SDK child.
 */
export function claudeSubscriptionEnvironment(
  configDirectory: string,
  options: { sdkClientApp?: string } = {},
): Record<string, string> {
  return {
    HOME: configDirectory,
    CLAUDE_CONFIG_DIR: configDirectory,
    TMPDIR: `${configDirectory}/.tmp`,
    PATH: "/usr/local/bin:/usr/bin:/bin",
    LANG: "C.UTF-8",
    BROWSER: "/bin/false",
    CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    CLAUDE_CODE_DISABLE_FEEDBACK_SURVEY: "1",
    CLAUDE_CODE_DISABLE_OFFICIAL_MARKETPLACE_AUTOINSTALL: "1",
    DISABLE_AUTOUPDATER: "1",
    DISABLE_TELEMETRY: "1",
    DISABLE_ERROR_REPORTING: "1",
    DISABLE_FEEDBACK_COMMAND: "1",
    ...(options.sdkClientApp
      ? { CLAUDE_AGENT_SDK_CLIENT_APP: options.sdkClientApp }
      : {}),
  };
}

/**
 * Classify only the documented, pinned Claude Code 2.1.292 JSON contract.
 * Malformed, unknown, contradictory, or wrong-directory output is never
 * login-eligible.
 */
export function classifyClaudeSubscriptionAuthStatus(
  result: AuthStatusResult,
  expectedConfigDirectory: string,
): ClaudeSubscriptionAuthInspection {
  let payload: unknown;
  try {
    payload = JSON.parse(result.stdout);
  } catch {
    return inspection(
      "incompatible_status",
      null,
      "Claude authentication status output was incompatible with the pinned contract.",
    );
  }
  if (!isAuthStatusPayload(payload))
    return inspection(
      "incompatible_status",
      null,
      "Claude authentication status output was incompatible with the pinned contract.",
    );
  if (payload.configDirectory !== expectedConfigDirectory)
    return inspection(
      "incompatible_status",
      payload.authMethod,
      "Claude authentication status was reported for a different configuration directory.",
    );

  if (
    result.exitCode === 1 &&
    payload.loggedIn === false &&
    payload.authMethod === "none"
  )
    return inspection(
      "authentication_required",
      "none",
      "Claude subscription authentication is required.",
    );

  if (
    result.exitCode === 0 &&
    payload.loggedIn === true &&
    payload.authMethod === "claude.ai"
  )
    return inspection(
      "subscription_authenticated",
      "claude.ai",
      "Claude subscription authentication is ready.",
    );

  if (payload.authMethod !== "none" && payload.authMethod !== "claude.ai")
    return inspection(
      "forbidden_auth_method",
      payload.authMethod,
      `Claude selected the forbidden ${payload.authMethod} authentication method.`,
    );

  return inspection(
    "incompatible_status",
    payload.authMethod,
    "Claude authentication status was contradictory or incompatible with subscription authentication.",
  );
}

export function forbiddenClaudeManagedPolicyInspection(): ClaudeSubscriptionAuthInspection {
  return inspection(
    "forbidden_auth_method",
    null,
    "Claude managed authentication policy is incompatible with subscription-only setup.",
  );
}

export function unavailableClaudeSubscriptionAuthInspection(): ClaudeSubscriptionAuthInspection {
  return inspection(
    "inspection_unavailable",
    null,
    "Claude subscription authentication status could not be inspected.",
  );
}

export function isClaudeSubscriptionLoginEligible(value: {
  authMode: string;
  loginMode: string;
  environmentPolicy: string;
  authState: string;
  authMethod: string | null;
}): boolean {
  return (
    value.authMode === CLAUDE_SUBSCRIPTION_AUTH_MODE &&
    value.loginMode === CLAUDE_SUBSCRIPTION_LOGIN_MODE &&
    value.environmentPolicy === CLAUDE_SUBSCRIPTION_ENVIRONMENT_POLICY &&
    value.authState === "authentication_required" &&
    value.authMethod === "none"
  );
}

function inspection(
  authState: ClaudeSubscriptionAuthState,
  authMethod: ClaudeSubscriptionAuthMethod | null,
  detail: string,
): ClaudeSubscriptionAuthInspection {
  return {
    authMode: CLAUDE_SUBSCRIPTION_AUTH_MODE,
    loginMode: CLAUDE_SUBSCRIPTION_LOGIN_MODE,
    environmentPolicy: CLAUDE_SUBSCRIPTION_ENVIRONMENT_POLICY,
    authState,
    authMethod,
    detail,
  };
}

function isAuthStatusPayload(value: unknown): value is AuthStatusPayload {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.loggedIn === "boolean" &&
    typeof candidate.authMethod === "string" &&
    knownAuthMethods.has(
      candidate.authMethod as ClaudeSubscriptionAuthMethod,
    ) &&
    typeof candidate.apiProvider === "string" &&
    typeof candidate.configDirectory === "string"
  );
}
