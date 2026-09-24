import {
  lstat,
  mkdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { HerdrApiError } from "./client.ts";

export const HERDR_OWNER_MARKER = ".qe-worker-owner.json";
export const HERDR_OWNERSHIP_SOURCE = "quest-engineering-worker-ownership";
export const HERDR_OWNERSHIP_TOKEN = "quest-engineering-worker/v1";

export interface HerdrSessionOwnershipRecord {
  version: 1;
  state: "claiming" | "active";
  workerId: string;
  sessionName: string;
  sessionIncarnation: string;
  sessionDirectory: string | null;
  sessionDirectoryIdentity: string | null;
  ownershipWorkspaceId: string | null;
  serverGeneration: string | null;
  createdAt: string;
  updatedAt: string;
}

export function ownerMarkerPath(sessionDirectory: string): string {
  return join(sessionDirectory, HERDR_OWNER_MARKER);
}

export async function readOwnershipRecord(
  path: string,
  label: string,
): Promise<HerdrSessionOwnershipRecord | null> {
  let contents: string;
  try {
    const metadata = await lstat(path);
    if (!metadata.isFile() || metadata.isSymbolicLink())
      throw ownershipConflict(`${label} is not a regular file.`);
    if (
      typeof process.getuid === "function" &&
      metadata.uid !== process.getuid()
    )
      throw ownershipConflict(`${label} is owned by another local user.`);
    contents = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    if (error instanceof HerdrApiError) throw error;
    throw new HerdrApiError(
      "backend_unavailable",
      `Could not read ${label}: ${error instanceof Error ? error.message : String(error)}`,
      "backend.session_ownership",
    );
  }
  try {
    const value = JSON.parse(contents) as Record<string, unknown>;
    if (
      value.version !== 1 ||
      !["claiming", "active"].includes(String(value.state)) ||
      !nonEmpty(value.workerId) ||
      !nonEmpty(value.sessionName) ||
      !nonEmpty(value.sessionIncarnation) ||
      !nullableText(value.sessionDirectory) ||
      !nullableText(value.sessionDirectoryIdentity) ||
      !nullableText(value.ownershipWorkspaceId) ||
      !nullableText(value.serverGeneration) ||
      !nonEmpty(value.createdAt) ||
      !nonEmpty(value.updatedAt)
    )
      throw new Error("required ownership fields are absent");
    return value as unknown as HerdrSessionOwnershipRecord;
  } catch (error) {
    throw ownershipConflict(
      `${label} is malformed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export async function writeOwnershipRecord(
  path: string,
  record: HerdrSessionOwnershipRecord,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(record, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true });
    if (error instanceof HerdrApiError) throw error;
    throw new HerdrApiError(
      "backend_unavailable",
      `Could not persist Herdr ownership: ${error instanceof Error ? error.message : String(error)}`,
      "backend.session_ownership",
    );
  }
}

export async function claimOwnerMarker(
  sessionDirectory: string,
  record: HerdrSessionOwnershipRecord,
  allowConcurrentClaim = false,
): Promise<HerdrSessionOwnershipRecord> {
  const path = ownerMarkerPath(sessionDirectory);
  const marker = { ...record, state: "active" as const };
  try {
    await writeFile(path, `${JSON.stringify(marker, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    return marker;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST")
      throw new HerdrApiError(
        "backend_unavailable",
        `Could not claim Herdr session ownership: ${error instanceof Error ? error.message : String(error)}`,
        "backend.session_ownership",
      );
    const existing = await readOwnershipRecord(path, "Herdr owner marker");
    if (existing && samePhysicalOwnership(existing, marker)) return existing;
    if (
      allowConcurrentClaim &&
      existing &&
      existing.workerId === marker.workerId &&
      existing.sessionName === marker.sessionName &&
      existing.sessionDirectory === marker.sessionDirectory &&
      existing.sessionDirectoryIdentity === marker.sessionDirectoryIdentity
    )
      return existing;
    throw ownershipConflict(
      `Herdr session directory '${sessionDirectory}' is already claimed by different or unverifiable ownership evidence.`,
    );
  }
}

export function assertMatchingOwnership(
  primary: HerdrSessionOwnershipRecord | null,
  marker: HerdrSessionOwnershipRecord | null,
  expected: {
    workerId: string;
    sessionName: string;
    sessionDirectory: string;
    sessionDirectoryIdentity: string;
  },
): HerdrSessionOwnershipRecord {
  if (!primary)
    throw ownershipConflict(
      `Herdr session '${expected.sessionName}' exists, but the QE Worker ownership record is missing.`,
    );
  if (
    primary.workerId !== expected.workerId ||
    primary.sessionName !== expected.sessionName
  )
    throw ownershipConflict(
      `The QE Worker ownership record belongs to Worker '${primary.workerId}' and session '${primary.sessionName}', not Worker '${expected.workerId}' and session '${expected.sessionName}'.`,
    );
  if (!marker) {
    if (
      primary.sessionDirectory === expected.sessionDirectory &&
      primary.sessionDirectoryIdentity === expected.sessionDirectoryIdentity
    )
      return primary;
    throw ownershipConflict(
      `Herdr session '${expected.sessionName}' has no matching durable session-directory owner marker.`,
    );
  }
  if (
    !samePhysicalOwnership(primary, marker) ||
    primary.sessionDirectory !== expected.sessionDirectory ||
    marker.sessionDirectory !== expected.sessionDirectory ||
    primary.sessionDirectoryIdentity !== expected.sessionDirectoryIdentity ||
    marker.sessionDirectoryIdentity !== expected.sessionDirectoryIdentity
  )
    throw ownershipConflict(
      `Ownership evidence conflicts for Herdr session '${expected.sessionName}'; refusing to adopt it.`,
    );
  return primary;
}

export function samePhysicalOwnership(
  left: HerdrSessionOwnershipRecord,
  right: HerdrSessionOwnershipRecord,
): boolean {
  return (
    left.version === right.version &&
    left.workerId === right.workerId &&
    left.sessionName === right.sessionName &&
    left.sessionIncarnation === right.sessionIncarnation &&
    left.sessionDirectory === right.sessionDirectory &&
    left.sessionDirectoryIdentity === right.sessionDirectoryIdentity
  );
}

export async function canonicalSessionDirectory(
  value: string,
): Promise<{ path: string; identity: string }> {
  const path = resolve(value);
  try {
    const canonical = await realpath(path);
    const value = await stat(canonical);
    if (!value.isDirectory())
      throw new Error("reported path is not a directory");
    return {
      path: canonical,
      identity: [value.dev, value.ino, value.birthtimeMs].join(":"),
    };
  } catch (error) {
    throw new HerdrApiError(
      "backend_unavailable",
      `Herdr session directory '${path}' cannot be verified: ${error instanceof Error ? error.message : String(error)}`,
      "backend.session_ownership",
    );
  }
}

export function ownershipConflict(message: string): HerdrApiError {
  return new HerdrApiError(
    "backend_incompatible",
    message,
    "backend.session_ownership",
  );
}

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function nullableText(value: unknown): value is string | null {
  return value === null || nonEmpty(value);
}
