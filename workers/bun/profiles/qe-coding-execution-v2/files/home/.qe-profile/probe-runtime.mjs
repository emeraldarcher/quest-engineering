import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const PROVIDER_ID = "openai-codex";
const ACCOUNT_CLAIM = "https://api.openai.com/auth";
const EXPECTED_REFRESH = "qe-sbx-host-managed-no-refresh";
const EXPECTED_EXPIRY = Number.MAX_SAFE_INTEGER;
const EXPECTED_KID = "qe-sbx-host-managed-v1";
const EXPECTED_SIGNATURE = Buffer.from("not-a-signature", "utf8").toString("base64url");
const pi = await import(
  "/opt/qe/pi/node_modules/@earendil-works/pi-coding-agent/dist/index.js"
);
const requiredExports = ["ModelRuntime"];
const { getSupportedThinkingLevels } = await import(
  "/opt/qe/pi/node_modules/@earendil-works/pi-ai/dist/index.js"
);
const missingExports = requiredExports.filter(
  (name) => typeof pi[name] !== "function",
);

function decodeJsonPart(value) {
  return JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
}

async function validateExternallyManagedCredential(authPath) {
  const raw = await readFile(authPath, "utf8");
  const document = JSON.parse(raw);
  if (Object.keys(document).length !== 1) throw new Error("Unexpected credential entries");
  const credential = document[PROVIDER_ID];
  if (
    credential?.type !== "oauth" ||
    typeof credential.access !== "string" ||
    credential.refresh !== EXPECTED_REFRESH ||
    credential.expires !== EXPECTED_EXPIRY ||
    Object.keys(credential).some(
      (key) => !["type", "access", "refresh", "expires", "accountId"].includes(key),
    )
  ) {
    throw new Error("Invalid externally managed credential contract");
  }
  const parts = credential.access.split(".");
  if (parts.length !== 3 || parts[2] !== EXPECTED_SIGNATURE)
    throw new Error("Proxy bearer is not the expected nonsecret JWT-shaped sentinel");
  const header = decodeJsonPart(parts[0]);
  const payload = decodeJsonPart(parts[1]);
  const accountId = payload?.[ACCOUNT_CLAIM]?.chatgpt_account_id;
  if (
    header?.alg !== "none" ||
    header?.typ !== "JWT" ||
    header?.kid !== EXPECTED_KID ||
    typeof accountId !== "string" ||
    accountId.length === 0 ||
    credential.accountId !== accountId ||
    payload?.qe_sbx_proxy?.version !== 1 ||
    !/^[a-f0-9]{32}$/u.test(payload?.qe_sbx_proxy?.sandbox ?? "")
  ) {
    throw new Error("Proxy bearer metadata is invalid");
  }
  const authGeneration = (
    await readFile(join(dirname(authPath), "qe-auth-generation"), "utf8")
  ).trim();
  if (!/^[a-f0-9]{64}$/u.test(authGeneration))
    throw new Error("Proxy auth generation is invalid");
  return credential.access;
}

let fixtureDirectory;
let authPath = process.argv[2];
if (!authPath) {
  fixtureDirectory = await mkdtemp(join(tmpdir(), "qe-pi-auth-contract-"));
  authPath = join(fixtureDirectory, "auth.json");
  const encode = (value) => Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
  const accountId = "qe-nonsecret-account-fixture";
  const access = [
    encode({ alg: "none", typ: "JWT", kid: EXPECTED_KID }),
    encode({
      [ACCOUNT_CLAIM]: { chatgpt_account_id: accountId },
      qe_sbx_proxy: { version: 1, sandbox: "0".repeat(32) },
    }),
    EXPECTED_SIGNATURE,
  ].join(".");
  await writeFile(join(fixtureDirectory, "qe-auth-generation"), `${"0".repeat(64)}\n`, {
    mode: 0o600,
  });
  await writeFile(
    authPath,
    `${JSON.stringify({
      [PROVIDER_ID]: {
        type: "oauth",
        access,
        refresh: EXPECTED_REFRESH,
        expires: EXPECTED_EXPIRY,
        accountId,
      },
    })}\n`,
    { mode: 0o600 },
  );
}

let externallyManagedCredential = false;
let runtimeCatalog = false;
let fetchCalls = 0;
try {
  const expectedAccess = await validateExternallyManagedCredential(authPath);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    fetchCalls += 1;
    throw new Error("Externally managed guest credential attempted network refresh");
  };
  try {
    const runtime = await pi.ModelRuntime.create({
      authPath,
      modelsPath: null,
      refreshOnCreate: false,
      allowModelNetwork: false,
    });
    const resolved = await runtime.getAuth(PROVIDER_ID, {
      minOAuthValidityMs: 5 * 60 * 1000,
    });
    externallyManagedCredential = resolved?.auth?.apiKey === expectedAccess;
    const available = await runtime.getAvailable();
    runtimeCatalog =
      available.some((model) => model.provider === PROVIDER_ID) &&
      available
        .filter((model) => model.provider === PROVIDER_ID)
        .every(
          (model) =>
            typeof model.id === "string" &&
            model.id.length > 0 &&
            Array.isArray(getSupportedThinkingLevels(model)),
        );
  } finally {
    globalThis.fetch = originalFetch;
  }
} finally {
  if (fixtureDirectory) await rm(fixtureDirectory, { recursive: true, force: true });
}

const nodeMajor = Number(process.versions.node.split(".")[0]);
const gitVersion = execFileSync("/usr/bin/git", ["--version"], {
  encoding: "utf8",
}).trim();
const packageJson = JSON.parse(
  readFileSync(
    "/opt/qe/pi/node_modules/@earendil-works/pi-coding-agent/package.json",
    "utf8",
  ),
);
const cli = "/opt/qe/pi/node_modules/.bin/pi";
const help = execFileSync(cli, ["--help"], { encoding: "utf8" });
const requiredFlags = [
  "--model",
  "--thinking",
  "--no-extensions",
  "--extension",
  "--no-skills",
  "--no-prompt-templates",
  "--no-context-files",
  "--tools",
];
const missingFlags = requiredFlags.filter((flag) => !help.includes(flag));
const capabilities = {
  nodeRuntime: Number.isInteger(nodeMajor) && nodeMajor >= 22,
  git: /^git version 2\./.test(gitVersion),
  modelRuntime: missingExports.length === 0,
  runtimeCatalog,
  interactiveCli: missingFlags.length === 0,
  nativeExtensions: help.includes("--extension"),
  structuredTools: help.includes("--tools"),
  externallyManagedCredential,
  jwtAccountClaim: externallyManagedCredential,
  syntheticExpiry: externallyManagedCredential,
  guestRefreshDisabled: externallyManagedCredential && fetchCalls === 0,
  nodeProxyConfigured: process.env.NODE_USE_ENV_PROXY === "1",
};
const compatible = Object.values(capabilities).every(Boolean);
process.stdout.write(
  `${JSON.stringify({
    schemaVersion: 2,
    compatible,
    capabilities,
    provenance: {
      piPackage: packageJson.version,
      node: process.versions.node,
      git: gitVersion,
    },
    missingExports,
    missingFlags,
  })}\n`,
);
if (!compatible) process.exitCode = 1;
