import { readFile } from "node:fs/promises";
import { openaiCodexOAuth } from "/opt/qe/pi/node_modules/@earendil-works/pi-ai/dist/auth/oauth/openai-codex.js";

const accessSentinel =
  "eyJhbGciOiJub25lIiwidHlwIjoiSldUIn0.eyJodHRwczovL2FwaS5vcGVuYWkuY29tL2F1dGgiOnsiY2hhdGdwdF9hY2NvdW50X2lkIjoicHJveHktbWFuYWdlZCJ9fQ.";
const refreshSentinel = "oai-ort01-qe-proxy-managed";
const auth = JSON.parse(
  await readFile("/home/agent/.pi/agent/auth.json", "utf8"),
)["openai-codex"];
if (
  auth?.type !== "oauth" ||
  auth.access !== accessSentinel ||
  auth.refresh !== refreshSentinel ||
  typeof auth.expires !== "number"
)
  throw new Error("Pi OAuth credential file is not sentinel-only.");

// This calls Pi's actual ChatGPT-subscription refresh implementation. Docker's
// schema-v2 OAuth proxy must retain the host token and return only sentinels.
const refreshed = await openaiCodexOAuth.refresh(auth);
const result = {
  schemaVersion: 1,
  provider: openaiCodexOAuth.name,
  subscription: openaiCodexOAuth.isSubscription === true,
  credentialFileSentinelOnly: true,
  credentialFileExpiryValid: auth.expires > Date.now(),
  refreshSentinelOnly:
    refreshed.access === accessSentinel &&
    refreshed.refresh === refreshSentinel,
  accountSentinelValid: refreshed.accountId === "proxy-managed",
  expiryValid:
    typeof refreshed.expires === "number" && refreshed.expires > Date.now(),
};
process.stdout.write(`${JSON.stringify(result)}\n`);
if (!Object.values(result).every((value) => value !== false)) process.exitCode = 1;
