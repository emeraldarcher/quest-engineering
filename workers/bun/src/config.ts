import { existsSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import type {
  JsonValue,
  Reasoning,
  WorkspaceAccess,
} from "./protocol/types.ts";
import { isJsonValue } from "./protocol/types.ts";
import { validateHerdrSessionName } from "./session-host/herdr/connection.ts";
import { loadConfiguredWorkspace } from "./workspace/configured-workspace.ts";

export interface AuthorizedRoot {
  key: string;
  path: string;
  max_access: WorkspaceAccess;
  discover_depth: number;
  allow_unconfined_shell: boolean;
}
export interface WorkspaceBindingConfig {
  binding_id: string;
  workspace_id: string;
  authorized_root_key: string;
  source_repository_root: string;
  source_fingerprint?: string | null;
  publication_remote_name?: string | null;
  publication_repository_identity?: string | null;
  max_access: WorkspaceAccess;
  allow_unconfined_shell: boolean;
}
export interface WorkerConfig {
  controlPlaneUrl: string;
  workerId: string;
  workerToken: string;
  maxConcurrency: number;
  tags: string[];
  herdrSession: string;
  allowedRoots: AuthorizedRoot[];
  workspaceBindings: WorkspaceBindingConfig[];
  worktreeRoot: string;
  executorModels?: Array<{ provider: string; model: string }>;
  reasoningLevels?: Reasoning[];
  dataRoot: string;
  piModel?: string;
  piThinking: string;
  heartbeatMs: number;
  reconnectMs: number;
  resultTimeoutMs: number;
  provider: "pi" | "fake";
  fakeOutputs: Record<string, JsonValue>;
  fakeDelayMs: number;
  gitAuthorName?: string;
  gitAuthorEmail?: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): WorkerConfig {
  const controlPlaneUrl = required(env, "QE_CONTROL_PLANE_URL");
  const workerId = required(env, "QE_WORKER_ID");
  const workerToken = required(env, "QE_WORKER_TOKEN");
  const dataRoot = absolute(
    env.QE_WORKER_DATA_ROOT?.trim() || ".quest-engineering-worker",
    "QE_WORKER_DATA_ROOT",
  );
  mkdirSync(dataRoot, { recursive: true });
  const worktreeRoot = absolute(
    env.QE_WORKTREE_ROOT?.trim() || join(dataRoot, "worktrees"),
    "QE_WORKTREE_ROOT",
  );
  mkdirSync(worktreeRoot, { recursive: true });
  const allowedRoots = parseAllowedRoots(env.QE_ALLOWED_ROOTS_JSON);
  const persistedBindingsPath = join(dataRoot, "workspace-bindings.json");
  const configuredBindings = env.QE_WORKSPACE_BINDINGS_JSON?.trim()
    ? JSON.parse(env.QE_WORKSPACE_BINDINGS_JSON)
    : [];
  const persistedBindings = existsSync(persistedBindingsPath)
    ? JSON.parse(readFileSync(persistedBindingsPath, "utf8"))
    : [];
  const combinedBindings = [
    ...(Array.isArray(configuredBindings) ? configuredBindings : []),
    ...(Array.isArray(persistedBindings) ? persistedBindings : []),
  ];
  const workspaceBindings = parseBindings(
    JSON.stringify(combinedBindings),
    allowedRoots,
    realpathSync(worktreeRoot),
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
  const executorModels = models(
    env.QE_EXECUTOR_MODELS ?? env.QE_PI_MODEL,
    provider,
  );
  const reasoningLevels = reasoning(
    env.QE_REASONING_LEVELS ?? "low,medium,high",
  );
  if (provider === "fake" && env.QE_ENABLE_TEST_PROVIDER !== "1")
    throw new Error("The fake provider requires QE_ENABLE_TEST_PROVIDER=1.");
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

  return {
    controlPlaneUrl,
    workerId,
    workerToken,
    maxConcurrency,
    tags: csv(env.QE_WORKER_TAGS),
    herdrSession,
    allowedRoots,
    workspaceBindings,
    worktreeRoot,
    executorModels,
    reasoningLevels,
    dataRoot,
    ...(env.QE_PI_MODEL?.trim() ? { piModel: env.QE_PI_MODEL.trim() } : {}),
    piThinking: env.QE_PI_THINKING?.trim() || "medium",
    heartbeatMs,
    reconnectMs,
    resultTimeoutMs,
    provider,
    fakeOutputs,
    fakeDelayMs,
    ...(env.QE_GIT_AUTHOR_NAME?.trim()
      ? { gitAuthorName: env.QE_GIT_AUTHOR_NAME.trim() }
      : {}),
    ...(env.QE_GIT_AUTHOR_EMAIL?.trim()
      ? { gitAuthorEmail: env.QE_GIT_AUTHOR_EMAIL.trim() }
      : {}),
  };
}

function parseAllowedRoots(encoded: string | undefined): AuthorizedRoot[] {
  const value = encoded?.trim() ? JSON.parse(encoded) : [];
  if (!Array.isArray(value))
    throw new Error("QE_ALLOWED_ROOTS_JSON must be an array.");
  const keys = new Set<string>();
  return value.map((item: unknown) => {
    if (!item || typeof item !== "object" || Array.isArray(item))
      throw new Error("Each allowed root must be an object.");
    const x = item as Record<string, unknown>;
    const key = text(x.key, "allowed root key");
    if (keys.has(key)) throw new Error(`Duplicate allowed root key: ${key}`);
    keys.add(key);
    const path = realpathSync(
      absolute(text(x.path, "allowed root path"), "allowed root path"),
    );
    return {
      key,
      path,
      max_access: access(String(x.max_access ?? "read_write")),
      discover_depth: integer(x.discover_depth ?? 4, "discover_depth"),
      allow_unconfined_shell: x.allow_unconfined_shell === true,
    };
  });
}
function parseBindings(
  encoded: string | undefined,
  roots: AuthorizedRoot[],
  worktreeRoot: string,
): WorkspaceBindingConfig[] {
  const value = encoded?.trim() ? JSON.parse(encoded) : [];
  if (!Array.isArray(value))
    throw new Error("QE_WORKSPACE_BINDINGS_JSON must be an array.");
  return value.map((item: unknown) => {
    if (!item || typeof item !== "object" || Array.isArray(item))
      throw new Error("Each Workspace binding must be an object.");
    const x = item as Record<string, unknown>;
    const rootKey = text(x.authorized_root_key, "authorized_root_key");
    const root = roots.find((candidate) => candidate.key === rootKey);
    if (!root) throw new Error(`Unknown authorized root: ${rootKey}`);
    const source = loadConfiguredWorkspace(
      absolute(
        text(x.source_repository_root, "source_repository_root"),
        "source_repository_root",
      ),
    ).root;
    if (!contained(root.path, source))
      throw new Error(`Binding source is outside authorized root ${rootKey}.`);
    if (contained(source, worktreeRoot))
      throw new Error(
        "QE_WORKTREE_ROOT cannot be inside a bound source repository.",
      );
    return {
      binding_id: uuid(x.binding_id, "binding_id"),
      workspace_id: uuid(x.workspace_id, "workspace_id"),
      authorized_root_key: rootKey,
      source_repository_root: source,
      source_fingerprint:
        typeof x.source_fingerprint === "string" ? x.source_fingerprint : null,
      publication_remote_name:
        typeof x.publication_remote_name === "string"
          ? x.publication_remote_name
          : null,
      publication_repository_identity:
        typeof x.publication_repository_identity === "string"
          ? x.publication_repository_identity
          : null,
      max_access: access(String(x.max_access ?? root.max_access)),
      allow_unconfined_shell:
        x.allow_unconfined_shell === undefined
          ? root.allow_unconfined_shell
          : x.allow_unconfined_shell === true,
    };
  });
}
function contained(parent: string, child: string): boolean {
  const value = relative(parent, child);
  return value === "" || (!value.startsWith("..") && !isAbsolute(value));
}
function uuid(value: unknown, key: string): string {
  const x = text(value, key);
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      x,
    )
  )
    throw new Error(`${key} must be a UUID.`);
  return x;
}
function text(value: unknown, key: string): string {
  if (typeof value !== "string" || !value.trim())
    throw new Error(`${key} is required.`);
  return value.trim();
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
function integer(value: unknown, key: string): number {
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
  )
    throw new Error("QE_FAKE_OUTPUTS_JSON must be a JSON object.");
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
function models(
  value: string | undefined,
  provider: "pi" | "fake",
): Array<{ provider: string; model: string }> {
  const configured = csv(value);
  if (configured.length === 0 && provider === "fake")
    return [{ provider: "fake", model: "test" }];
  if (configured.length === 0)
    throw new Error("QE_EXECUTOR_MODELS is required for the Pi provider.");
  return configured.map((entry) => {
    const separator = entry.indexOf("/");
    if (separator < 1 || separator === entry.length - 1)
      throw new Error("Executor models must use provider/model syntax.");
    return {
      provider: entry.slice(0, separator),
      model: entry.slice(separator + 1),
    };
  });
}
function reasoning(value: string): Reasoning[] {
  const values = csv(value);
  if (!values.every((item) => ["low", "medium", "high"].includes(item)))
    throw new Error("QE_REASONING_LEVELS contains an unsupported level.");
  return values as Reasoning[];
}
function access(value: string): WorkspaceAccess {
  if (!["none", "read_only", "read_write"].includes(value))
    throw new Error("Workspace access is invalid.");
  return value as WorkspaceAccess;
}
function absolute(value: string, key: string): string {
  const path = resolve(value);
  if (!isAbsolute(path))
    throw new Error(`${key} must resolve to an absolute path.`);
  return path;
}
