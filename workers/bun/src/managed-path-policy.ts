import { createHash } from "node:crypto";
import type { Stats } from "node:fs";
import {
  accessSync,
  chmodSync,
  constants,
  existsSync,
  mkdirSync,
  realpathSync,
  statSync,
} from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";

export type ManagedPathPolicyErrorCode =
  | "managed_path_not_absolute"
  | "managed_directory_creation_failed"
  | "managed_directory_not_directory"
  | "managed_directory_canonicalization_failed"
  | "managed_directory_ownership_mismatch"
  | "managed_directory_unsafe_permissions"
  | "managed_roots_overlap"
  | "qe_home_source_overlap"
  | "worker_state_source_overlap"
  | "worktree_source_overlap";

/** A fail-closed local path-boundary error; its code does not extend Worker Protocol. */
export class ManagedPathPolicyError extends Error {
  readonly name = "ManagedPathPolicyError";

  constructor(
    readonly code: ManagedPathPolicyErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

export interface ManagedHostPaths {
  qeHome: string;
  dataRoot: string;
  worktreeRoot: string;
  dataRootSource: "QE_WORKER_DATA_ROOT" | "QE_HOME";
  worktreeRootSource: "QE_WORKTREE_ROOT" | "QE_HOME";
}

/** Select the complete greenfield host layout without touching the filesystem. */
export function selectManagedHostPaths(
  env: NodeJS.ProcessEnv,
  workerId: string,
  fallbackUserHome = homedir(),
): ManagedHostPaths {
  const configuredHome = env.QE_HOME?.trim();
  const qeHome = configuredHome
    ? absolutePath(configuredHome, "QE_HOME")
    : join(
        absolutePath(env.HOME?.trim() || fallbackUserHome, "user home"),
        ".qe",
      );
  const explicitDataRoot = env.QE_WORKER_DATA_ROOT?.trim();
  const explicitWorktreeRoot = env.QE_WORKTREE_ROOT?.trim();

  return {
    qeHome,
    dataRoot: explicitDataRoot
      ? absolutePath(explicitDataRoot, "QE_WORKER_DATA_ROOT")
      : join(qeHome, "state", "workers", workerStateDirectoryName(workerId)),
    worktreeRoot: explicitWorktreeRoot
      ? absolutePath(explicitWorktreeRoot, "QE_WORKTREE_ROOT")
      : join(qeHome, "worktrees"),
    dataRootSource: explicitDataRoot ? "QE_WORKER_DATA_ROOT" : "QE_HOME",
    worktreeRootSource: explicitWorktreeRoot ? "QE_WORKTREE_ROOT" : "QE_HOME",
  };
}

/** Create and validate every directory required by the current host layout. */
export function provisionManagedHostPaths(
  env: NodeJS.ProcessEnv,
  workerId: string,
  fallbackUserHome = homedir(),
): ManagedHostPaths {
  const selected = selectManagedHostPaths(env, workerId, fallbackUserHome);
  const qeHome = ensureManagedDirectory(selected.qeHome, "QE_HOME");

  let dataRoot: string;
  if (selected.dataRootSource === "QE_WORKER_DATA_ROOT") {
    dataRoot = ensureManagedDirectory(selected.dataRoot, "QE_WORKER_DATA_ROOT");
  } else {
    const stateRoot = ensureManagedDirectory(
      join(qeHome, "state"),
      "QE state root",
    );
    const workersRoot = ensureManagedDirectory(
      join(stateRoot, "workers"),
      "QE Worker state root",
    );
    dataRoot = ensureManagedDirectory(
      join(workersRoot, workerStateDirectoryName(workerId)),
      "QE Worker durable state root",
    );
  }

  const worktreeRoot = ensureManagedDirectory(
    selected.worktreeRootSource === "QE_WORKTREE_ROOT"
      ? selected.worktreeRoot
      : join(qeHome, "worktrees"),
    selected.worktreeRootSource === "QE_WORKTREE_ROOT"
      ? "QE_WORKTREE_ROOT"
      : "QE managed worktree root",
  );
  assertManagedComponentSeparation(dataRoot, worktreeRoot);

  return { ...selected, qeHome, dataRoot, worktreeRoot };
}

/** Stable filesystem-safe identity for one Worker's private durable state. */
export function workerStateDirectoryName(workerId: string): string {
  return `worker-${createHash("sha256").update(workerId).digest("hex")}`;
}

/**
 * Enforce the physical source boundary for the complete QE-managed host layout.
 * This is shared by startup, runtime binding admission, and Run provisioning.
 */
export function assertSourceHostSeparation(
  sourceRepositoryRoot: string,
  paths: Pick<ManagedHostPaths, "qeHome" | "dataRoot" | "worktreeRoot">,
): void {
  const source = canonicalExistingDirectory(
    sourceRepositoryRoot,
    "source repository root",
  );
  assertSeparatedFromSource(
    source,
    canonicalExistingDirectory(paths.qeHome, "QE_HOME"),
    "QE home",
    "QE_HOME",
    "qe_home_source_overlap",
  );
  assertSeparatedFromSource(
    source,
    canonicalExistingDirectory(paths.dataRoot, "QE Worker durable state root"),
    "QE Worker durable state root",
    "QE_WORKER_DATA_ROOT",
    "worker_state_source_overlap",
  );
  assertSeparatedFromSource(
    source,
    canonicalExistingDirectory(paths.worktreeRoot, "managed worktree root"),
    "QE managed worktree root",
    "QE_WORKTREE_ROOT",
    "worktree_source_overlap",
  );
}

function assertManagedComponentSeparation(
  dataRoot: string,
  worktreeRoot: string,
): void {
  if (contains(dataRoot, worktreeRoot) || contains(worktreeRoot, dataRoot)) {
    throw new ManagedPathPolicyError(
      "managed_roots_overlap",
      `QE Worker durable state root "${dataRoot}" and managed worktree root "${worktreeRoot}" must not contain one another. Configure specialized overrides as separate directories.`,
    );
  }
}

function assertSeparatedFromSource(
  source: string,
  managed: string,
  label: string,
  override: string,
  code: ManagedPathPolicyErrorCode,
): void {
  if (contains(source, managed) || contains(managed, source)) {
    throw new ManagedPathPolicyError(
      code,
      `${label} "${managed}" and source repository "${source}" must not contain one another. Configure ${override} outside every bound source repository, or remove the override to use the QE_HOME-derived default.`,
    );
  }
}

function absolutePath(path: string, label: string): string {
  if (!isAbsolute(path)) {
    throw new ManagedPathPolicyError(
      "managed_path_not_absolute",
      `${label} "${path}" must be an absolute path so QE-managed host state never depends on process cwd.`,
    );
  }
  return resolve(path);
}

function ensureManagedDirectory(requestedPath: string, label: string): string {
  const existed = existsSync(requestedPath);
  if (existed) canonicalExistingDirectory(requestedPath, label);
  try {
    mkdirSync(requestedPath, { recursive: true, mode: 0o700 });
  } catch (error) {
    throw new ManagedPathPolicyError(
      "managed_directory_creation_failed",
      `${label} "${requestedPath}" could not be created: ${errorMessage(error)}. Choose a writable per-user location.`,
      { cause: error },
    );
  }

  const canonical = canonicalExistingDirectory(requestedPath, label);
  if (!existed) {
    try {
      chmodSync(canonical, 0o700);
    } catch (error) {
      throw new ManagedPathPolicyError(
        "managed_directory_unsafe_permissions",
        `${label} "${canonical}" could not be restricted to private permissions: ${errorMessage(error)}.`,
        { cause: error },
      );
    }
  }

  const stat = statSync(canonical);
  const currentUid =
    typeof process.getuid === "function" ? process.getuid() : null;
  if (currentUid !== null && stat.uid !== currentUid) {
    throw new ManagedPathPolicyError(
      "managed_directory_ownership_mismatch",
      `${label} "${canonical}" is owned by uid ${stat.uid}, not the current uid ${currentUid}. Choose a directory owned by the current user.`,
    );
  }

  if (process.platform !== "win32" && (stat.mode & 0o022) !== 0) {
    throw new ManagedPathPolicyError(
      "managed_directory_unsafe_permissions",
      `${label} "${canonical}" is group- or world-writable. Restrict it to the current user before starting the Worker.`,
    );
  }

  try {
    accessSync(canonical, constants.R_OK | constants.W_OK | constants.X_OK);
  } catch (error) {
    throw new ManagedPathPolicyError(
      "managed_directory_creation_failed",
      `${label} "${canonical}" is not accessible: ${errorMessage(error)}.`,
      { cause: error },
    );
  }

  return canonical;
}

function canonicalExistingDirectory(path: string, label: string): string {
  let canonical: string;
  try {
    canonical = realpathSync(path);
  } catch (error) {
    throw new ManagedPathPolicyError(
      "managed_directory_canonicalization_failed",
      `${label} "${path}" could not be resolved safely: ${errorMessage(error)}.`,
      { cause: error },
    );
  }

  let stat: Stats;
  try {
    stat = statSync(canonical);
  } catch (error) {
    throw new ManagedPathPolicyError(
      "managed_directory_canonicalization_failed",
      `${label} "${canonical}" could not be inspected: ${errorMessage(error)}.`,
      { cause: error },
    );
  }
  if (!stat.isDirectory()) {
    throw new ManagedPathPolicyError(
      "managed_directory_not_directory",
      `${label} "${canonical}" must be a directory. Remove the non-directory path or choose another location.`,
    );
  }
  return canonical;
}

function contains(parent: string, child: string): boolean {
  const nested = relative(parent, child);
  return nested === "" || (!nested.startsWith("..") && !isAbsolute(nested));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
