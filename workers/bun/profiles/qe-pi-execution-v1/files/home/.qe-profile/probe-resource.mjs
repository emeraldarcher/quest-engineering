import { readFile } from "node:fs/promises";

const authPath = "/home/agent/.pi/agent/auth.json";
const auth = JSON.parse(await readFile(authPath, "utf8"))["openai-codex"];
if (auth?.type !== "oauth" || typeof auth.access !== "string")
  throw new Error("Externally managed openai-codex credential is missing");
const parts = auth.access.split(".");
if (parts.length !== 3) throw new Error("Proxy bearer is not JWT-shaped");
const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
const accountId = payload?.["https://api.openai.com/auth"]?.chatgpt_account_id;
if (typeof accountId !== "string" || accountId.length === 0 || accountId !== auth.accountId)
  throw new Error("Proxy account metadata is invalid");

const response = await fetch(
  "https://chatgpt.com/backend-api/codex/models?client_version=0.84.2",
  {
    headers: {
      Authorization: `Bearer ${auth.access}`,
      "ChatGPT-Account-ID": accountId,
      "OpenAI-Beta": "responses=experimental",
      originator: "pi",
      "User-Agent": "pi/0.84.2",
    },
    redirect: "error",
    signal: AbortSignal.timeout(20_000),
  },
);
let hasModels = false;
try {
  const body = await response.json();
  hasModels = Array.isArray(body?.models) || Array.isArray(body?.data);
} catch {
  hasModels = false;
}
if (!response.ok || !hasModels)
  throw new Error(`Subscription resource probe failed with HTTP ${response.status}`);
console.log(JSON.stringify({ authenticated: true, status: response.status, hasModels }));
