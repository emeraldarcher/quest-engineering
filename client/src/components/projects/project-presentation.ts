import type { Workspace, WorkspaceSource } from "../../api/contracts";
import { availableProductKey } from "../management/management-key";

export type ProjectStatusTone =
  | "ready"
  | "preparing"
  | "offline"
  | "attention"
  | "unbound";

export interface ProjectStatusPresentation {
  icon: string;
  shortLabel: string;
  detailLabel: string;
  description: string;
  tone: ProjectStatusTone;
}

export function projectStatus(
  state: Workspace["binding"]["state"],
): ProjectStatusPresentation {
  switch (state) {
    case "ready":
      return {
        icon: "●",
        shortLabel: "Ready",
        detailLabel: "Ready for Quests",
        description: "This Project is available to Quest Engineering.",
        tone: "ready",
      };
    case "preparing":
      return {
        icon: "◌",
        shortLabel: "Preparing…",
        detailLabel: "Preparing Project…",
        description: "Quest Engineering is connecting this repository.",
        tone: "preparing",
      };
    case "offline":
      return {
        icon: "○",
        shortLabel: "Offline",
        detailLabel: "Offline",
        description:
          "This Project is configured, but no Worker that can currently access it is online. Existing history is unaffected; new Quests will wait until it becomes available.",
        tone: "offline",
      };
    case "attention_required":
      return {
        icon: "!",
        shortLabel: "Needs attention",
        detailLabel: "Needs attention",
        description: "Quest Engineering couldn't connect this repository.",
        tone: "attention",
      };
    case "unbound":
      return {
        icon: "◇",
        shortLabel: "Not connected",
        detailLabel: "Not connected",
        description: "This Project is not currently connected to a repository.",
        tone: "unbound",
      };
  }
}

export function sourceIdentity(source: WorkspaceSource): string {
  return (
    source.publication_repository_identity ??
    (source.source_kind === "local_git"
      ? "Local Git repository"
      : "Git repository")
  );
}

export function projectRepositoryIdentity(
  workspace: Workspace,
  sources: WorkspaceSource[],
): string {
  const source = matchingSource(workspace, sources);
  if (source) return sourceIdentity(source);
  if (workspace.source_fingerprint) {
    const identity = repositoryIdentityFromFingerprint(
      workspace.source_fingerprint,
    );
    if (identity) return identity;
  }
  return workspace.source_kind === "local_git"
    ? "Local Git repository"
    : "Git repository";
}

export function matchingSource(
  workspace: Workspace,
  sources: WorkspaceSource[],
): WorkspaceSource | null {
  if (workspace.source_fingerprint) {
    return (
      sources.find(
        (source) =>
          source.source_kind === workspace.source_kind &&
          source.source_fingerprint === workspace.source_fingerprint,
      ) ?? null
    );
  }
  return (
    sources.find(
      (source) =>
        source.source_kind === workspace.source_kind &&
        source.source_fingerprint === null &&
        source.name.toLocaleLowerCase() === workspace.name.toLocaleLowerCase(),
    ) ?? null
  );
}

export function repositoryIdentityFromFingerprint(
  fingerprint: string,
): string | null {
  const clean = fingerprint
    .replace(/\?.*$/, "")
    .replace(/\.git$/, "")
    .replace(/\/$/, "");
  const match = clean.match(
    /(?:https?:\/\/|ssh:\/\/git@|git@)?github\.com(?::|\/)([^/]+)\/([^/]+)$/i,
  );
  return match?.[1] && match[2] ? `${match[1]}/${match[2]}` : null;
}

export function defaultProjectName(source: WorkspaceSource): string {
  const repository = source.publication_repository_identity?.split("/").at(-1);
  return titleCase(repository ?? source.name);
}

export function availableProjectKey(
  name: string,
  existingKeys: Iterable<string>,
  preferredSuffix = 1,
): string {
  return availableProductKey(name, existingKeys, "project", preferredSuffix);
}

function titleCase(value: string): string {
  const words = value.replace(/[-_]+/g, " ").trim().split(/\s+/);
  return words
    .map((word) => `${word.charAt(0).toLocaleUpperCase()}${word.slice(1)}`)
    .join(" ");
}
