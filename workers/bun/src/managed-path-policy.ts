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
  | "managed_home_not_absolute"
  | "managed_directory_creation_failed"
  | "managed_directory_not_directory"
  | "managed_directory_canonicalization_failed"
  | "managed_directory_ownership_mismatch"
  | "managed_directory_unsafe_permissions"
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

export interface ManagedWorktreePaths {
  /** The selected QE managed-data home. An explicit worktree override need not create it. */
  qeHome: string;
  worktreeRoot: string;
  source: "QE_WORKTREE_ROOT" | "QE_HOME" | "user_home_default";
}

/** Select the effective path without touching the filesystem. */
export function selectManagedWorktreePaths(
  env: NodeJS.ProcessEnv,
  fallbackUserHome = homedir(),
): ManagedWorktreePaths {
  const configuredHome = env.QE_HOME?.trim();
  const qeHome = configuredHome
    ? absoluteManagedHome(configuredHome, "QE_HOME")
    : join(
        absoluteManagedHome(env.HOME?.trim() || fallbackUserHome, "user home"),
        ".qe",
      );
  const explicitWorktreeRoot = env.QE_WORKTREE_ROOT?.trim();
  return {
    qeHome,
    worktreeRoot: explicitWorktreeRoot
      ? resolve(explicitWorktreeRoot)
      : join(qeHome, "worktrees"),
    source: explicitWorktreeRoot
      ? "QE_WORKTREE_ROOT"
      : configuredHome
        ? "QE_HOME"
        : "user_home_default",
  };
}

/**
 * Resolve and provision the host-side QE worktree location without consulting cwd.
 * Explicit QE_WORKTREE_ROOT retains the historical behavior of resolving a relative
 * value against cwd; the built-in default is always derived from the OS/user home.
 */
export function provisionManagedWorktreePaths(
  env: NodeJS.ProcessEnv,
  fallbackUserHome = homedir(),
): ManagedWorktreePaths {
  const selected = selectManagedWorktreePaths(env, fallbackUserHome);
  if (selected.source === "QE_WORKTREE_ROOT") {
    return {
      ...selected,
      worktreeRoot: ensureManagedDirectory(
        selected.worktreeRoot,
        "QE_WORKTREE_ROOT",
      ),
    };
  }

  const canonicalQeHome = ensureManagedDirectory(selected.qeHome, "QE_HOME");
  return {
    ...selected,
    qeHome: canonicalQeHome,
    worktreeRoot: ensureManagedDirectory(
      join(canonicalQeHome, "worktrees"),
      "managed worktree root",
    ),
  };
}

/**
 * Enforce the symmetric physical-path boundary used by configuration loading,
 * runtime binding admission, and Run provisioning configuration.
 */
export function assertSourceWorktreeSeparation(
  sourceRepositoryRoot: string,
  worktreeRoot: string,
): { sourceRepositoryRoot: string; worktreeRoot: string } {
  const source = canonicalExistingDirectory(
    sourceRepositoryRoot,
    "source repository root",
  );
  const managed = canonicalExistingDirectory(
    worktreeRoot,
    "managed worktree root",
  );

  if (contains(source, managed) || contains(managed, source)) {
    throw new ManagedPathPolicyError(
      "worktree_source_overlap",
      `QE managed worktree root "${managed}" and source repository "${source}" must not contain one another. Configure QE_WORKTREE_ROOT outside every bound source repository, or remove the override to use the per-user default.`,
    );
  }

  return { sourceRepositoryRoot: source, worktreeRoot: managed };
}

function absoluteManagedHome(path: string, label: string): string {
  if (!isAbsolute(path)) {
    throw new ManagedPathPolicyError(
      "managed_home_not_absolute",
      `${label} "${path}" must be an absolute path so the managed worktree default never depends on process cwd.`,
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
    // Fail early for paths that exist but cannot actually be traversed/written.
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
