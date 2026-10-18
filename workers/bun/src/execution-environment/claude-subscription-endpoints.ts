export const CLAUDE_SUBSCRIPTION_ENDPOINT_CONTRACT = Object.freeze({
  schemaVersion: 1,
  claudeCodeVersion: "2.1.292",
  endpoints: Object.freeze([
    Object.freeze({
      host: "claude.com",
      phases: Object.freeze(["interaction_browser_authority"] as const),
      representativeUrls: Object.freeze([
        "https://claude.com/cai/oauth/authorize",
      ]),
      accountCellEgressRequired: false,
      rationale:
        "The human browser follows this authorization URL outside the account cell.",
    }),
    Object.freeze({
      host: "platform.claude.com",
      phases: Object.freeze([
        "interaction_browser_callback_authority",
        "token_exchange",
      ] as const),
      representativeUrls: Object.freeze([
        "https://platform.claude.com/oauth/code/callback",
        "https://platform.claude.com/v1/oauth/token",
      ]),
      accountCellEgressRequired: true,
      rationale:
        "The account-cell Claude process posts the accepted authorization code and PKCE verifier to the token endpoint.",
    }),
    Object.freeze({
      host: "api.anthropic.com",
      phases: Object.freeze([
        "profile_account_fetch",
        "subsequent_authenticated_account_control",
      ] as const),
      representativeUrls: Object.freeze([
        "https://api.anthropic.com/api/oauth/profile",
        "https://api.anthropic.com/api/oauth/claude_cli/roles",
      ]),
      accountCellEgressRequired: true,
      rationale:
        "The pinned runtime validates and enriches the subscription account through the first-party API and later uses that API for authenticated account runtime traffic.",
    }),
    Object.freeze({
      host: "claude.ai",
      phases: Object.freeze([
        "login_client_metadata",
        "subsequent_authenticated_account_control",
      ] as const),
      representativeUrls: Object.freeze([
        "https://claude.ai/oauth/claude-code-client-metadata",
      ]),
      accountCellEgressRequired: true,
      rationale:
        "The pinned Claude.ai subscription path defines client metadata and account-control authority on this exact origin.",
    }),
  ]),
});

/**
 * Reviewed hosts required from inside the credential-bearing account cell.
 * Browser-only authorities are intentionally excluded.
 */
export const CLAUDE_SUBSCRIPTION_REQUIRED_ACCOUNT_RUNTIME_HOSTS = Object.freeze(
  CLAUDE_SUBSCRIPTION_ENDPOINT_CONTRACT.endpoints
    .filter((endpoint) => endpoint.accountCellEgressRequired)
    .map((endpoint) => endpoint.host)
    .sort(),
);

/**
 * Exact source fragments in the pinned native artifact. They prove more than
 * URL presence: the authorization-code path posts to TOKEN_URL and profile
 * fetching uses BASE_API_URL. Tests bind these markers to the installed
 * 2.1.292 vendor binary without executing it or making network requests.
 */
export const CLAUDE_2_1_292_LOGIN_SOURCE_MARKERS = Object.freeze([
  "// Version: 2.1.292",
  'CLAUDE_AI_AUTHORIZE_URL:"https://claude.com/cai/oauth/authorize"',
  'CLAUDE_AI_ORIGIN:"https://claude.ai"',
  'TOKEN_URL:"https://platform.claude.com/v1/oauth/token"',
  'BASE_API_URL:"https://api.anthropic.com"',
  'DNe="https://claude.ai/oauth/claude-code-client-metadata"',
  'async function Tso(e,{state:n,codeVerifier:r,port:s,useManualRedirect:g=!1,expiresIn:h,clientId:b}){let w={grant_type:"authorization_code"',
  'await vt.post(pn().TOKEN_URL,w,{headers:{"Content-Type":"application/json"},timeout:30000})',
  "`$" + "{pn().BASE_API_URL}/api/oauth/profile`",
]);
