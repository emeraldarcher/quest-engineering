import { existsSync, realpathSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

export interface ConfiguredWorkspace {
  root: string;
}

export function loadConfiguredWorkspace(path: string): ConfiguredWorkspace {
  const root = resolve(path);
  if (!existsSync(root) || !statSync(root).isDirectory())
    throw new Error(`Configured workspace is missing: ${root}`);
  if (!existsSync(join(root, ".git")))
    throw new Error(`Configured workspace is not a Git worktree: ${root}`);
  return { root: realpathSync(root) };
}
