import { mkdirSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import type { JsonValue } from "./protocol/types.ts";
import { isJsonValue } from "./protocol/types.ts";
import { validateHerdrSessionName } from "./session-host/herdr/connection.ts";
import { loadConfiguredWorkspace } from "./workspace/configured-workspace.ts";

export interface WorkerConfig {
  controlPlaneUrl: string;
  workerId: string;
  workerToken: string;
  maxConcurrency: number;
  tags: string[];
  herdrSession: string;
  workspaceRoot: string;
  dataRoot: string;
  piModel?: string;
  piThinking: string;
  heartbeatMs: number;
  reconnectMs: number;
  resultTimeoutMs: number;
  provider: "pi" | "fake";
  fakeOutputs: Record<string, JsonValue>;
  fakeDelayMs: number;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): WorkerConfig {
  const controlPlaneUrl = required(env, "QE_CONTROL_PLANE_URL");
  const workerId = required(env, "QE_WORKER_ID");
  const workerToken = required(env, "QE_WORKER_TOKEN");
  const workspaceRoot = loadConfiguredWorkspace(
    absolute(required(env, "QE_WORKSPACE_ROOT"), "QE_WORKSPACE_ROOT"),
  ).root;
  const dataRoot = absolute(
    env.QE_WORKER_DATA_ROOT?.trim() || ".quest-engineering-worker",
    "QE_WORKER_DATA_ROOT",
  );
  const maxConcurrency = positiveInteger(
    env.QE_MAX_CONCURRENCY ?? "1",
    "QE_MAX_CONCURRENCY",
  );
  const herdrSession = validateHerdrSessionName(
    env.QE_HERDR_SESSION?.trim() || "quest-engineering-worker",
  );
  const heartbeatMs = positiveInteger(
    env.QE_HEARTBEAT_MS ?? "10000",
    "QE_HEARTBEAT_MS",
  );
  const reconnectMs = positiveInteger(
    env.QE_RECONNECT_MS ?? "1000",
    "QE_RECONNECT_MS",
  );
  const resultTimeoutMs = positiveInteger(
    env.QE_RESULT_TIMEOUT_MS ?? "21600000",
    "QE_RESULT_TIMEOUT_MS",
  );
  const provider = env.QE_WORKER_PROVIDER === "fake" ? "fake" : "pi";
  if (provider === "fake" && env.QE_ENABLE_TEST_PROVIDER !== "1") {
    throw new Error("The fake provider requires QE_ENABLE_TEST_PROVIDER=1.");
  }
  const fakeOutputs = parseFakeOutputs(env.QE_FAKE_OUTPUTS_JSON);
  const fakeDelayMs = nonNegativeInteger(
    env.QE_FAKE_DELAY_MS ?? "0",
    "QE_FAKE_DELAY_MS",
  );

  let parsed: URL;
  try {
    parsed = new URL(controlPlaneUrl);
  } catch {
    throw new Error(
      "QE_CONTROL_PLANE_URL must be an absolute ws:// or wss:// URL.",
    );
  }
  if (!["ws:", "wss:"].includes(parsed.protocol))
    throw new Error("QE_CONTROL_PLANE_URL must use ws:// or wss://.");
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(workerId))
    throw new Error("QE_WORKER_ID is invalid.");

  mkdirSync(dataRoot, { recursive: true });
  return {
    controlPlaneUrl,
    workerId,
    workerToken,
    maxConcurrency,
    tags: csv(env.QE_WORKER_TAGS),
    herdrSession,
    workspaceRoot,
    dataRoot,
    ...(env.QE_PI_MODEL?.trim() ? { piModel: env.QE_PI_MODEL.trim() } : {}),
    piThinking: env.QE_PI_THINKING?.trim() || "medium",
    heartbeatMs,
    reconnectMs,
    resultTimeoutMs,
    provider,
    fakeOutputs,
    fakeDelayMs,
  };
}

function required(env: NodeJS.ProcessEnv, key: string): string {
  const value = env[key]?.trim();
  if (!value) throw new Error(`${key} is required.`);
  return value;
}
function positiveInteger(value: string, key: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1)
    throw new Error(`${key} must be a positive integer.`);
  return parsed;
}
function nonNegativeInteger(value: string, key: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0)
    throw new Error(`${key} must be a non-negative integer.`);
  return parsed;
}
function parseFakeOutputs(
  encoded: string | undefined,
): Record<string, JsonValue> {
  if (!encoded?.trim()) return {};
  const value = JSON.parse(encoded) as unknown;
  if (
    !isJsonValue(value) ||
    Array.isArray(value) ||
    value === null ||
    typeof value !== "object"
  ) {
    throw new Error("QE_FAKE_OUTPUTS_JSON must be a JSON object.");
  }
  return value;
}
function csv(value: string | undefined): string[] {
  return [
    ...new Set(
      (value ?? "")
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean),
    ),
  ];
}
function absolute(value: string, key: string): string {
  const path = resolve(value);
  if (!isAbsolute(path))
    throw new Error(`${key} must resolve to an absolute path.`);
  return path;
}
