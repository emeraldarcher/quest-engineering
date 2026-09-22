import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export const CODEX_CLIENT_VERSION = "0.84.2";
export const CODEX_MODELS_ENDPOINT =
  `https://chatgpt.com/backend-api/codex/models?client_version=${CODEX_CLIENT_VERSION}`;
export const CODEX_ELIGIBILITY_SNAPSHOT =
  "/qe/state/openai-codex-model-eligibility.json";

export async function getCodexModelEligibility(options = {}) {
  const authPath = options.authPath ?? "/home/agent/.pi/agent/auth.json";
  const { accountId } = await readProxyIdentity(authPath);
  const accountScope = createHash("sha256").update(accountId).digest("hex");
  const snapshotPath =
    options.snapshotPath === undefined
      ? CODEX_ELIGIBILITY_SNAPSHOT
      : options.snapshotPath;
  if (snapshotPath !== null) {
    try {
      const cached = JSON.parse(await readFile(snapshotPath, "utf8"));
      const ageMs = Date.now() - Date.parse(cached?.observedAt);
      if (
        validSnapshot(cached) &&
        cached.accountScope === accountScope &&
        ageMs >= 0 &&
        ageMs <= (options.maxAgeMs ?? 60_000)
      )
        return cached;
    } catch {
      // Missing, stale, or malformed eligibility is refreshed below.
    }
  }
  return fetchCodexModelEligibility(options);
}

export async function fetchCodexModelEligibility(options = {}) {
  const authPath = options.authPath ?? "/home/agent/.pi/agent/auth.json";
  const { auth, accountId } = await readProxyIdentity(authPath);
  const request = options.fetch ?? fetch;
  const response = await request(CODEX_MODELS_ENDPOINT, {
    headers: {
      Authorization: `Bearer ${auth.access}`,
      "ChatGPT-Account-ID": accountId,
      "OpenAI-Beta": "responses=experimental",
      originator: "pi",
      "User-Agent": `pi/${CODEX_CLIENT_VERSION}`,
    },
    redirect: "error",
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok)
    throw new Error(`Subscription model catalog failed with HTTP ${response.status}`);
  let body;
  try {
    body = await response.json();
  } catch {
    throw new Error("Subscription model catalog was not valid JSON");
  }
  const decoded = decodeCodexModelEligibility(body);
  const catalog = {
    schemaVersion: 1,
    authenticated: true,
    status: response.status,
    accountScope: createHash("sha256").update(accountId).digest("hex"),
    observedAt: new Date().toISOString(),
    models: decoded.models,
    excluded: decoded.excluded,
  };
  if (options.snapshotPath !== null)
    await writeEligibilitySnapshot(
      options.snapshotPath ?? CODEX_ELIGIBILITY_SNAPSHOT,
      catalog,
    );
  return catalog;
}

/**
 * Decode the account-scoped contract used by the native Codex model picker.
 * A model is schedulable only when the provider explicitly marks it API
 * supported and picker-visible. Unknown record shapes fail the whole catalog
 * closed rather than becoming implicit entitlement.
 */
export function decodeCodexModelEligibility(body) {
  const records = Array.isArray(body?.models)
    ? body.models
    : Array.isArray(body?.data)
      ? body.data
      : null;
  if (!records)
    throw new Error("Subscription model catalog has no models array");
  const models = [];
  const excluded = [];
  const seen = new Set();
  for (const record of records) {
    if (!record || typeof record !== "object" || Array.isArray(record))
      throw new Error("Subscription model catalog contains a malformed record");
    const model = record.slug;
    if (typeof model !== "string" || model.length === 0 || seen.has(model))
      throw new Error("Subscription model catalog contains an invalid model slug");
    seen.add(model);
    if (typeof record.supported_in_api !== "boolean")
      throw new Error(`Subscription model ${model} has unknown API support`);
    if (record.visibility !== "list" && record.visibility !== "hide")
      throw new Error(`Subscription model ${model} has unknown visibility`);
    const reasoning = decodeReasoning(record.supported_reasoning_levels, model);
    const rolloutAllowed =
      record.enabled !== false &&
      record.available !== false &&
      record.eligible !== false &&
      record.rollout_eligible !== false;
    if (
      record.supported_in_api !== true ||
      record.visibility !== "list" ||
      !rolloutAllowed
    ) {
      excluded.push({
        model,
        reason:
          record.supported_in_api !== true
            ? "not_supported_in_api"
            : record.visibility !== "list"
              ? "not_visible"
              : "rollout_ineligible",
      });
      continue;
    }
    const defaultReasoning =
      typeof record.default_reasoning_level === "string"
        ? record.default_reasoning_level
        : null;
    if (defaultReasoning !== null && !reasoning.includes(defaultReasoning))
      throw new Error(
        `Subscription model ${model} has an invalid default reasoning level`,
      );
    models.push({
      provider: "openai-codex",
      model,
      displayName:
        typeof record.display_name === "string" && record.display_name.length > 0
          ? record.display_name
          : model,
      reasoning,
      defaultReasoning,
    });
  }
  return { models, excluded };
}

export function intersectCodexModelCatalog(harnessModels, eligibilityModels) {
  const eligible = new Map(
    eligibilityModels.map((model) => [model.model, model]),
  );
  const models = [];
  for (const harness of harnessModels) {
    if (harness.provider !== "openai-codex") continue;
    const provider = eligible.get(harness.model);
    if (!provider) continue;
    const reasoning = harness.reasoning.filter((value) =>
      provider.reasoning.includes(value),
    );
    if (
      (harness.reasoning.length > 0 || provider.reasoning.length > 0) &&
      reasoning.length === 0
    )
      continue;
    models.push({
      provider: harness.provider,
      model: harness.model,
      displayName: harness.displayName,
      reasoning,
    });
  }
  return models;
}

async function readProxyIdentity(authPath) {
  const auth = JSON.parse(await readFile(authPath, "utf8"))["openai-codex"];
  if (auth?.type !== "oauth" || typeof auth.access !== "string")
    throw new Error("Externally managed openai-codex credential is missing");
  const parts = auth.access.split(".");
  if (parts.length !== 3) throw new Error("Proxy bearer is not JWT-shaped");
  const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
  const accountId = payload?.["https://api.openai.com/auth"]?.chatgpt_account_id;
  if (
    typeof accountId !== "string" ||
    accountId.length === 0 ||
    accountId !== auth.accountId
  )
    throw new Error("Proxy account metadata is invalid");
  return { auth, accountId };
}

function validSnapshot(value) {
  return Boolean(
    value &&
      value.schemaVersion === 1 &&
      value.authenticated === true &&
      value.status === 200 &&
      typeof value.accountScope === "string" &&
      /^[a-f0-9]{64}$/.test(value.accountScope) &&
      typeof value.observedAt === "string" &&
      Number.isFinite(Date.parse(value.observedAt)) &&
      Array.isArray(value.models) &&
      value.models.every(
        (model) =>
          model?.provider === "openai-codex" &&
          typeof model.model === "string" &&
          typeof model.displayName === "string" &&
          Array.isArray(model.reasoning) &&
          model.reasoning.every((level) => typeof level === "string") &&
          (model.defaultReasoning === null ||
            typeof model.defaultReasoning === "string"),
      ) &&
      Array.isArray(value.excluded),
  );
}

async function writeEligibilitySnapshot(path, value) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value)}\n`, {
    encoding: "utf8",
    mode: 0o600,
    flag: "wx",
  });
  await rename(temporary, path);
}

function decodeReasoning(value, model) {
  if (!Array.isArray(value))
    throw new Error(`Subscription model ${model} has unknown reasoning support`);
  const levels = value.map((item) =>
    typeof item === "string"
      ? item
      : item && typeof item === "object" && typeof item.effort === "string"
        ? item.effort
        : null,
  );
  if (levels.some((item) => item === null) || new Set(levels).size !== levels.length)
    throw new Error(`Subscription model ${model} has malformed reasoning support`);
  return levels;
}
