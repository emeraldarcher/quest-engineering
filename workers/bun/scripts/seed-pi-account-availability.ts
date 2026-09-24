import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import {
  SBX_PI_EXECUTION_PROFILE_V2,
  SBX_PI_EXECUTION_PROFILE_V2_DEFINITION,
} from "../src/execution-environment/sbx-profile.ts";
import {
  ACCOUNT_AVAILABILITY_SCHEMA_VERSION,
  type AccountAvailabilityEvidence,
  newAccountAvailabilityEvidence,
} from "../src/harnesses/account-availability.ts";

interface Args {
  output: string;
  preservedSessionBoundary?: string;
  authPath: string;
  sessionsRoot: string;
  piPath: string;
}

const args = parseArgs(process.argv.slice(2));
const version = Bun.spawnSync([args.piPath, "--version"], {
  stdout: "pipe",
  stderr: "pipe",
})
  .stdout.toString()
  .trim();
const expectedVersion = SBX_PI_EXECUTION_PROFILE_V2_DEFINITION.piPackage
  .split("@")
  .at(-1);
if (version !== expectedVersion)
  throw new Error(
    `Host Pi ${version || "unknown"} does not match evidence profile Pi ${expectedVersion}`,
  );
const authStat = await stat(args.authPath);
const credential = JSON.parse(await readFile(args.authPath, "utf8"))[
  "openai-codex"
] as Record<string, unknown>;
if (credential?.type !== "oauth" || typeof credential.access !== "string")
  throw new Error("Current host openai-codex credential is unavailable");
const access = credential.access;
const payloadPart = access.split(".")[1];
if (!payloadPart) throw new Error("Current host credential is not JWT-shaped");
const payload = JSON.parse(
  Buffer.from(payloadPart, "base64url").toString("utf8"),
) as Record<string, unknown>;
const claim = payload["https://api.openai.com/auth"] as
  | Record<string, unknown>
  | undefined;
const accountId = claim?.chatgpt_account_id;
if (typeof accountId !== "string" || accountId !== credential.accountId)
  throw new Error("Current host credential account identity is invalid");
const context = {
  accountScope: createHash("sha256").update(accountId).digest("hex"),
  authGeneration: createHash("sha256")
    .update("qe-pi-auth-generation-v1\u0000")
    .update(accountId)
    .update("\u0000")
    .update(access)
    .digest("hex"),
  profileId: SBX_PI_EXECUTION_PROFILE_V2.id,
  profileDigest: SBX_PI_EXECUTION_PROFILE_V2.digest,
};

const records = new Map<string, AccountAvailabilityEvidence>();
for (const path of await jsonlFiles(args.sessionsRoot)) {
  let provider: string | null = null;
  let model: string | null = null;
  for (const line of (await readFile(path, "utf8")).split("\n")) {
    if (!line) continue;
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (event.type === "model_change") {
      provider = typeof event.provider === "string" ? event.provider : null;
      model = typeof event.modelId === "string" ? event.modelId : null;
      continue;
    }
    if (event.type !== "message") continue;
    const message = event.message as Record<string, unknown> | undefined;
    if (!message || message.role !== "assistant") continue;
    const observedAt = event.timestamp;
    const eventProvider =
      typeof message.provider === "string" ? message.provider : provider;
    const eventModel =
      typeof message.model === "string" ? message.model : model;
    const usage = message.usage as Record<string, unknown> | undefined;
    if (
      eventProvider !== "openai-codex" ||
      typeof eventModel !== "string" ||
      (message.stopReason !== "stop" && message.stopReason !== "toolUse") ||
      typeof observedAt !== "string" ||
      Date.parse(observedAt) < authStat.mtimeMs ||
      typeof usage?.output !== "number" ||
      usage.output <= 0
    )
      continue;
    retainLatest(
      records,
      newAccountAvailabilityEvidence(
        context,
        { provider: eventProvider, model: eventModel },
        "verified_available",
        "preserved_execution_success",
        new Date(observedAt),
      ),
    );
  }
}

if (args.preservedSessionBoundary) {
  const boundary = JSON.parse(
    await readFile(args.preservedSessionBoundary, "utf8"),
  ) as Record<string, unknown>;
  const nativeSession = boundary.nativeSession as
    | Record<string, unknown>
    | undefined;
  const events = Array.isArray(nativeSession?.events)
    ? nativeSession.events
    : [];
  for (const value of events) {
    const event = value as Record<string, unknown>;
    const usage = event.usage as Record<string, unknown> | undefined;
    const cost = usage?.cost as Record<string, unknown> | undefined;
    const observedAt = event.timestamp;
    if (
      event.role !== "assistant" ||
      event.provider !== "openai-codex" ||
      typeof event.model !== "string" ||
      event.stopReason !== "error" ||
      typeof event.errorMessage !== "string" ||
      !/model is not supported when using codex with a chatgpt account/i.test(
        event.errorMessage,
      ) ||
      typeof observedAt !== "string" ||
      Date.parse(observedAt) < authStat.mtimeMs ||
      usage?.input !== 0 ||
      usage.output !== 0 ||
      cost?.total !== 0
    )
      continue;
    retainLatest(
      records,
      newAccountAvailabilityEvidence(
        context,
        { provider: event.provider, model: event.model },
        "verified_unavailable",
        "preserved_provider_rejection",
        new Date(observedAt),
      ),
    );
  }
}

await mkdir(dirname(args.output), { recursive: true, mode: 0o700 });
await writeFile(
  args.output,
  `${JSON.stringify(
    {
      schemaVersion: ACCOUNT_AVAILABILITY_SCHEMA_VERSION,
      records: [...records.values()].sort((left, right) =>
        `${left.provider}/${left.model}`.localeCompare(
          `${right.provider}/${right.model}`,
        ),
      ),
    },
    null,
    2,
  )}\n`,
  { mode: 0o600 },
);
console.log(
  JSON.stringify({
    output: args.output,
    records: [...records.values()].map((record) => ({
      provider: record.provider,
      model: record.model,
      state: record.state,
      observedAt: record.observedAt,
      source: record.source,
    })),
  }),
);

function retainLatest(
  records: Map<string, AccountAvailabilityEvidence>,
  evidence: AccountAvailabilityEvidence,
): void {
  const key = `${evidence.provider}\u0000${evidence.model}`;
  const current = records.get(key);
  if (
    !current ||
    Date.parse(evidence.observedAt) > Date.parse(current.observedAt)
  )
    records.set(key, evidence);
}

async function jsonlFiles(root: string): Promise<string[]> {
  const values: string[] = [];
  async function visit(path: string): Promise<void> {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const child = join(path, entry.name);
      if (entry.isDirectory()) await visit(child);
      else if (entry.isFile() && entry.name.endsWith(".jsonl"))
        values.push(child);
    }
  }
  await visit(root);
  return values.sort();
}

function parseArgs(values: string[]): Args {
  const result: Partial<Args> = {};
  for (let index = 0; index < values.length; index += 1) {
    const key = values[index];
    const value = values[index + 1];
    if (!value) throw new Error(`Missing value for ${key}`);
    index += 1;
    if (key === "--output") result.output = resolve(value);
    else if (key === "--preserved-session-boundary")
      result.preservedSessionBoundary = resolve(value);
    else if (key === "--auth") result.authPath = resolve(value);
    else if (key === "--sessions") result.sessionsRoot = resolve(value);
    else if (key === "--pi") result.piPath = resolve(value);
    else throw new Error(`Unknown argument: ${key}`);
  }
  const agentDir = getAgentDir();
  return {
    output:
      result.output ??
      resolve(process.cwd(), ".pi/tmp/pi-account-availability-seed.json"),
    ...(result.preservedSessionBoundary
      ? { preservedSessionBoundary: result.preservedSessionBoundary }
      : {}),
    authPath: result.authPath ?? join(agentDir, "auth.json"),
    sessionsRoot: result.sessionsRoot ?? join(agentDir, "sessions"),
    piPath:
      result.piPath ??
      Bun.which("pi") ??
      (() => {
        throw new Error("Host Pi executable is unavailable");
      })(),
  };
}
