import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import type { WorkerConfig } from "../config.ts";
import type { DispatchRecord } from "../dispatch/registry.ts";
import type { ArtifactInstance } from "../protocol/types.ts";

const MAX_DOCUMENT_BYTES = 1_048_576;

export interface MaterializedArtifact {
  artifactId: string;
  kind: string;
  path: string;
  filename: string;
  contentHash: string;
}

/**
 * Materializes immutable document inputs below Worker-owned state, never below
 * the Git worktree. The logical artifact ID remains authoritative; paths are
 * disposable harness execution details.
 */
export function materializeExecutionArtifacts(
  config: Pick<WorkerConfig, "dataRoot">,
  dispatch: Pick<DispatchRecord, "action">,
): Record<string, MaterializedArtifact> {
  const root = executionArtifactRoot(config);
  const actionRoot = join(
    root,
    digest(dispatch.action.run_id).slice(0, 20),
    digest(dispatch.action.occurrence_id).slice(0, 20),
    digest(dispatch.action.attempt_id).slice(0, 20),
  );
  const materialized: Record<string, MaterializedArtifact> = {};

  for (const [inputName, artifact] of Object.entries(
    dispatch.action.execution.work.inputs,
  )) {
    const document = documentValue(artifact);
    if (!document) continue;
    const content = Buffer.from(document.content, "utf8");
    if (content.byteLength > MAX_DOCUMENT_BYTES)
      throw new Error(
        `Document artifact ${artifact.id} exceeds the safe materialization limit.`,
      );
    const actualHash = `sha256:${createHash("sha256").update(content).digest("hex")}`;
    const expectedHash = artifact.content_hash ?? document.content_hash;
    if (!expectedHash || actualHash !== expectedHash)
      throw new Error(
        `Document artifact ${artifact.id} failed content-hash verification.`,
      );

    mkdirSync(actionRoot, { recursive: true });
    const filename = versionedFilename(
      safeFilename(
        artifact.filename ?? document.filename,
        artifact.kind,
        document.media_type,
      ),
      artifact.version,
      digest(artifact.id).slice(0, 8),
    );
    const path = join(actionRoot, filename);
    writeImmutable(path, content);
    const manifestPath = `${path}.qe-artifact.json`;
    writeImmutable(
      manifestPath,
      Buffer.from(
        JSON.stringify(
          {
            artifact_id: artifact.id,
            semantic_kind: artifact.kind,
            producer_occurrence_id: artifact.producer_occurrence_id,
            version: artifact.version ?? null,
            supersedes_artifact_id: artifact.supersedes_artifact_id ?? null,
            media_type: artifact.media_type ?? document.media_type,
            content_hash: actualHash,
            filename: artifact.filename ?? document.filename,
          },
          null,
          2,
        ),
      ),
    );
    materialized[inputName] = {
      artifactId: artifact.id,
      kind: artifact.kind,
      path,
      filename,
      contentHash: actualHash,
    };
  }
  return materialized;
}

export function executionArtifactRoot(
  config: Pick<WorkerConfig, "dataRoot">,
): string {
  return resolve(config.dataRoot, "execution-artifacts");
}

function documentValue(artifact: ArtifactInstance): {
  content: string;
  content_hash: string | null;
  filename: string | null;
  media_type: string;
} | null {
  const value = artifact.value;
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  if (value.kind !== "document" || typeof value.content !== "string")
    return null;
  return {
    content: value.content,
    content_hash:
      typeof value.content_hash === "string" ? value.content_hash : null,
    filename: typeof value.filename === "string" ? value.filename : null,
    media_type:
      typeof value.media_type === "string" ? value.media_type : "text/plain",
  };
}

function safeFilename(
  supplied: string | null | undefined,
  type: string,
  mediaType: string,
): string {
  const fallback = `${type.replaceAll("_", "-")}${mediaType === "text/markdown" ? ".md" : ".txt"}`;
  if (!supplied || basename(supplied) !== supplied) return fallback;
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(supplied)
    ? supplied
    : fallback;
}

function versionedFilename(
  filename: string,
  version: number | null | undefined,
  identity: string,
): string {
  const dot = filename.lastIndexOf(".");
  const stem = dot > 0 ? filename.slice(0, dot) : filename;
  const extension = dot > 0 ? filename.slice(dot) : "";
  return `${stem}${version ? `-v${version}` : ""}-${identity}${extension}`;
}

function writeImmutable(path: string, content: Uint8Array): void {
  if (existsSync(path)) {
    const existing = readFileSync(path);
    if (!existing.equals(content))
      throw new Error(
        `Immutable execution artifact materialization changed at ${path}.`,
      );
    return;
  }
  writeFileSync(path, content, { flag: "wx", mode: 0o400 });
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
