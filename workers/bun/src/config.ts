import { createHash } from "node:crypto";
import {
  accessSync,
  constants,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  statSync,
} from "node:fs";
import { homedir } from "node:os";
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
  /** Exact host executable used for every Herdr CLI/server launch. */
  herdrBin?: string;
  allowedRoots: AuthorizedRoot[];
  workspaceBindings: WorkspaceBindingConfig[];
  retiredWorkspaceBindings?: WorkspaceBindingConfig[];
  configuredWorkspaceBindingIds?: string[];
  workspaceBindingsPath?: string;
  worktreeRoot: string;
  executorModels?: Array<{ provider: string; model: string }>;
  reasoningLevels?: Reasoning[];
  dataRoot: string;
  piModel?: string;
  piThinking: string;
  heartbeatMs: number;
  reconnectMs: number;
  resultTimeoutMs: number;
  /** Nonterminal liveness threshold; crossing it never authorizes a retry. */
  promptActivityStallMs?: number;
  provider: "pi" | "fake";
  enabledHarnesses?: Array<"pi" | "antigravity" | "fake">;
  fakeOutputs: Record<string, JsonValue>;
  fakeDelayMs: number;
  gitAuthorName?: string;
  gitAuthorEmail?: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): WorkerConfig {
  const controlPlaneUrl = required(env, "QE_CONTROL_PLANE_URL");
  const workerId = required(env, "QE_WORKER_ID");
  const workerToken = required(env, "QE_WORKER_TOKEN");
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(workerId))
    throw new Error("QE_WORKER_ID is invalid.");
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
  const workspaceBindingsPath = join(dataRoot, "workspace-bindings.json");
  const configuredBindings = parseBindings(
    env.QE_WORKSPACE_BINDINGS_JSON,
    allowedRoots,
    realpathSync(worktreeRoot),
  );
  const persistedState = existsSync(workspaceBindingsPath)
    ? persistedBindingState(
        JSON.parse(readFileSync(workspaceBindingsPath, "utf8")),
      )
    : { active: [], retired: [] };
  const persistedBindings = parseBindings(
    JSON.stringify(persistedState.active),
    allowedRoots,
    realpathSync(worktreeRoot),
  );
  const retiredWorkspaceBindings = parseBindings(
    JSON.stringify(persistedState.retired),
    allowedRoots,
    realpathSync(worktreeRoot),
  );
  const workspaceBindings = [...configuredBindings, ...persistedBindings];
  const maxConcurrency = positiveInteger(
    env.QE_MAX_CONCURRENCY ?? "1",
    "QE_MAX_CONCURRENCY",
  );
  const herdrHome = env.HOME?.trim() || homedir();
  const herdrSession = validateHerdrSessionName(
    env.QE_HERDR_SESSION?.trim() ||
      defaultHerdrSessionName(workerId, herdrHome),
  );
  assertHerdrDefaultSocketPathSafe(herdrSession, herdrHome);
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
  const promptActivityStallMs = positiveInteger(
    env.QE_PROMPT_ACTIVITY_STALL_MS ?? "30000",
    "QE_PROMPT_ACTIVITY_STALL_MS",
  );
  const provider = env.QE_WORKER_PROVIDER === "fake" ? "fake" : "pi";
  const herdrBin = env.QE_HERDR_BIN?.trim()
    ? exactExecutable(env.QE_HERDR_BIN, "QE_HERDR_BIN")
    : undefined;
  if (provider !== "fake" && !herdrBin)
    throw new Error(
      "QE_HERDR_BIN is required and must name the exact absolute Herdr executable.",
    );
  const enabledHarnesses =
    provider === "fake"
      ? (["fake"] as const)
      : harnesses(env.QE_WORKER_HARNESSES ?? "pi,antigravity");
  const executorModels = models(
    env.QE_EXECUTOR_MODELS !== undefined
      ? env.QE_EXECUTOR_MODELS
      : env.QE_PI_MODEL,
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

  return {
    controlPlaneUrl,
    workerId,
    workerToken,
    maxConcurrency,
    tags: csv(env.QE_WORKER_TAGS),
    herdrSession,
    ...(herdrBin ? { herdrBin } : {}),
    allowedRoots,
    workspaceBindings,
    retiredWorkspaceBindings,
    configuredWorkspaceBindingIds: configuredBindings.map(
      (binding) => binding.binding_id,
    ),
    workspaceBindingsPath,
    worktreeRoot,
    ...(executorModels === undefined ? {} : { executorModels }),
    reasoningLevels,
    dataRoot,
    ...(env.QE_PI_MODEL?.trim() ? { piModel: env.QE_PI_MODEL.trim() } : {}),
    piThinking: env.QE_PI_THINKING?.trim() || "medium",
    heartbeatMs,
    reconnectMs,
    resultTimeoutMs,
    promptActivityStallMs,
    provider,
    enabledHarnesses: [...enabledHarnesses],
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

export const HERDR_UNIX_SOCKET_SAFE_PATH_BYTES = 103;
const HERDR_SESSION_PREFIX = "qe-worker-";
const HERDR_SESSION_HASH_HEX_LENGTH = 10;
const HERDR_DEFAULT_SESSION_ROOT = [".config", "herdr", "sessions"] as const;
const HERDR_API_SOCKET = "herdr.sock";
const HERDR_CLIENT_SOCKET = "herdr-client.sock";

export interface HerdrDefaultSocketPaths {
  sessionDirectory: string;
  apiSocket: string;
  clientSocket: string;
}

export function herdrDefaultSocketPaths(
  sessionName: string,
  homeDirectory: string = homedir(),
): HerdrDefaultSocketPaths {
  const sessionDirectory = join(
    homeDirectory,
    ...HERDR_DEFAULT_SESSION_ROOT,
    sessionName,
  );
  return {
    sessionDirectory,
    apiSocket: join(sessionDirectory, HERDR_API_SOCKET),
    clientSocket: join(sessionDirectory, HERDR_CLIENT_SOCKET),
  };
}

export function assertHerdrDefaultSocketPathSafe(
  sessionName: string,
  homeDirectory: string = homedir(),
): void {
  const paths = herdrDefaultSocketPaths(sessionName, homeDirectory);
  for (const [kind, path] of [
    ["API", paths.apiSocket],
    ["client", paths.clientSocket],
  ] as const) {
    const bytes = Buffer.byteLength(path, "utf8");
    if (bytes > HERDR_UNIX_SOCKET_SAFE_PATH_BYTES)
      throw new Error(
        `Herdr ${kind} socket path is ${bytes} bytes; the safe Unix-domain socket limit is ${HERDR_UNIX_SOCKET_SAFE_PATH_BYTES} bytes. Shorten the host HOME path or configured Herdr session name.`,
      );
  }
}

export function defaultHerdrSessionName(
  workerId: string,
  homeDirectory: string = homedir(),
): string {
  const hash = createHash("sha256")
    .update(workerId)
    .digest("hex")
    .slice(0, HERDR_SESSION_HASH_HEX_LENGTH);
  const fixedBytes = Buffer.byteLength(
    `${HERDR_SESSION_PREFIX}-${hash}`,
    "utf8",
  );
  const root = join(homeDirectory, ...HERDR_DEFAULT_SESSION_ROOT);
  const socketWithoutSession = join(root, HERDR_CLIENT_SOCKET);
  const sessionBudget =
    HERDR_UNIX_SOCKET_SAFE_PATH_BYTES -
    Buffer.byteLength(socketWithoutSession, "utf8") -
    1;
  const readableBudget = Math.min(32, sessionBudget - fixedBytes);
  if (readableBudget < 1)
    throw new Error(
      "The host HOME path is too long for a collision-resistant default Herdr session socket.",
    );
  const readable =
    workerId
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, "-")
      .replace(/^[._-]+|[._-]+$/g, "")
      .slice(0, readableBudget)
      .replace(/[._-]+$/g, "") || "worker".slice(0, readableBudget);
  const sessionName = validateHerdrSessionName(
    `${HERDR_SESSION_PREFIX}${readable}-${hash}`,
  );
  assertHerdrDefaultSocketPathSafe(sessionName, homeDirectory);
  return sessionName;
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
function persistedBindingState(value: unknown): {
  active: unknown[];
  retired: unknown[];
} {
  if (Array.isArray(value)) return { active: value, retired: [] };
  if (
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    (value as Record<string, unknown>).version === 2 &&
    Array.isArray((value as Record<string, unknown>).active) &&
    Array.isArray((value as Record<string, unknown>).retired)
  )
    return {
      active: (value as Record<string, unknown>).active as unknown[],
      retired: (value as Record<string, unknown>).retired as unknown[],
    };
  throw new Error(
    "workspace-bindings.json must be an array or a version 2 binding state object.",
  );
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
): Array<{ provider: string; model: string }> | undefined {
  if (value === undefined)
    return provider === "fake"
      ? [{ provider: "fake", model: "test" }]
      : undefined;
  const configured = csv(value);
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
function harnesses(value: string): Array<"pi" | "antigravity"> {
  const values = csv(value);
  if (
    values.length === 0 ||
    !values.every((item) => item === "pi" || item === "antigravity")
  )
    throw new Error("QE_WORKER_HARNESSES must contain pi and/or antigravity.");
  return values as Array<"pi" | "antigravity">;
}
function reasoning(value: string): Reasoning[] {
  return csv(value);
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

function exactExecutable(value: string, key: string): string {
  if (!isAbsolute(value)) throw new Error(`${key} must be an absolute path.`);
  let path: string;
  try {
    path = realpathSync(value);
    if (!statSync(path).isFile()) throw new Error("not a file");
    accessSync(path, constants.X_OK);
  } catch {
    throw new Error(`${key} must identify an existing executable file.`);
  }
  return path;
}
