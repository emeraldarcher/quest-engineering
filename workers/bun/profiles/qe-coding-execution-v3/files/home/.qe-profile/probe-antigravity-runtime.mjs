import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";

const executable = process.argv[2] || "/opt/qe/antigravity/agy";
const artifactSha256 = createHash("sha256")
  .update(readFileSync(executable))
  .digest("hex");
const version = run(["--version"]).trim();
const help = run(["--help"]);
const mcp = run(["mcp", "list"]);
const authPath = "/home/agent/.gemini/antigravity-cli/antigravity-oauth-token";
const auth = JSON.parse(readFileSync(authPath, "utf8"));
const access = auth?.token?.access_token;
const refresh = auth?.token?.refresh_token;
const idToken = auth?.id_token;
const authGenerationPath =
  "/home/agent/.gemini/antigravity-cli/qe-auth-generation";
const accountScopePath =
  "/home/agent/.gemini/antigravity-cli/qe-account-scope";
const authGeneration = readFileSync(authGenerationPath, "utf8").trim();
const accountScope = readFileSync(accountScopePath, "utf8").trim();
const onboardingPath =
  "/home/agent/.gemini/antigravity-cli/cache/onboarding.json";
const onboardingBytes = readFileSync(onboardingPath);
const onboardingSha256 = createHash("sha256")
  .update(onboardingBytes)
  .digest("hex");
const onboarding = JSON.parse(onboardingBytes.toString("utf8"));
let idClaims = {};
let idSignature = "";
try {
  const parts = idToken.split(".");
  idClaims = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
  idSignature = Buffer.from(parts[2], "base64url").toString("utf8");
} catch {}
const config = JSON.parse(
  readFileSync("/home/agent/.gemini/config/mcp_config.json", "utf8"),
);
const qe = config?.mcpServers?.qe;
const requiredFlags = [
  "--conversation",
  "--dangerously-skip-permissions",
  "--effort",
  "--log-file",
  "--model",
  "--prompt-interactive",
];
const capabilities = {
  executable: /^\d+\.\d+\.\d+(?:[-+].*)?$/.test(version),
  interactiveTui: help.includes("--prompt-interactive"),
  exactModelSelection: help.includes("--model"),
  modelDiscovery: help.includes("models"),
  reasoningDiscovery: help.includes("--effort"),
  privateHome: process.env.HOME === "/home/agent",
  nativeConversationIdentity: help.includes("--conversation"),
  mcp: mcp.split("\n").some((line) => /^qe\s/.test(line.trim()) && /\bstdio\b/.test(line) && /\benabled\b/.test(line)),
  stopHook: true,
  structuredCompletion: qe?.command === "/usr/bin/node" && Array.isArray(qe?.args) && qe.args[0] === "/qe/state/antigravity-control/mcp-server.mjs" && qe.disabled === false,
  retainedSessionRecovery: help.includes("--conversation"),
  deterministicState: statSync(executable).uid === 0 && (statSync(executable).mode & 0o022) === 0,
  autonomousGuestPermissions: help.includes("--dangerously-skip-permissions"),
  innerSandboxOptional: help.includes("--sandbox"),
  externallyManagedCredential:
    auth?.auth_method === "consumer" &&
    typeof access === "string" &&
    access.startsWith("qe-sbx-antigravity-access-") &&
    refresh === "qe-sbx-host-managed-no-refresh" &&
    idClaims?.iss === "qe-sbx-host-managed" &&
    idClaims?.sub === accountScope &&
    idClaims?.qe_sbx_proxy?.version === 1 &&
    idSignature === "not-a-signature" &&
    /^[a-f0-9]{64}$/.test(accountScope) &&
    /^[a-f0-9]{64}$/.test(authGeneration) &&
    (statSync(authPath).mode & 0o777) === 0o600 &&
    (statSync(authGenerationPath).mode & 0o777) === 0o600 &&
    (statSync(accountScopePath).mode & 0o777) === 0o600,
  guestRefreshDisabled: refresh === "qe-sbx-host-managed-no-refresh",
  humanCapturedOnboardingState:
    version === "1.2.7" &&
    onboardingSha256 ===
      "1aa3e7b17067c259f56b1c7feb17094172729c977d4a7fcbea030f9247c0bbe4" &&
    Object.keys(onboarding).sort().join(",") ===
      "consumerOnboardingComplete,enterpriseOnboardingComplete,onboardingComplete" &&
    onboarding.consumerOnboardingComplete === true &&
    onboarding.enterpriseOnboardingComplete === false &&
    onboarding.onboardingComplete === true &&
    (statSync(onboardingPath).mode & 0o777) === 0o600,
};
const compatible =
  requiredFlags.every((flag) => help.includes(flag)) &&
  Object.values(capabilities).every((value) => value === true);
process.stdout.write(
  `${JSON.stringify({
    schemaVersion: 1,
    compatible,
    capabilities,
    provenance: {
      executable,
      version,
      artifactSha256,
      platform: `${process.platform}/${process.arch}`,
    },
  })}\n`,
);
process.exitCode = compatible ? 0 : 41;

function run(args) {
  const result = spawnSync(executable, args, {
    encoding: "utf8",
    env: { ...process.env, HOME: "/home/agent", BROWSER: "/bin/false" },
  });
  if (result.status !== 0) {
    throw new Error(`Antigravity metadata command failed: ${args[0]}`);
  }
  return `${result.stdout || ""}${result.stderr || ""}`;
}
