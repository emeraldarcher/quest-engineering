import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { AccountAvailability, HarnessModelCapability } from "./types";

export const ACCOUNT_AVAILABILITY_SCHEMA_VERSION = 1;
export const ACCOUNT_AVAILABILITY_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_EVIDENCE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_EVIDENCE_RECORDS = 256;
const SHA256 = /^[a-f0-9]{64}$/;
const PROFILE_DIGEST = /^sha256:[a-f0-9]{64}$/;
const SAFE_IDENTIFIER = /^[A-Za-z0-9@._:/-]{1,128}$/;

export interface AccountAvailabilityContext {
  accountScope: string;
  authGeneration: string;
  profileId: string;
  profileDigest: string;
}

export type AccountAvailabilityEvidenceSource =
  | "direct_execution_success"
  | "direct_provider_rejection"
  | "preserved_execution_success"
  | "preserved_provider_rejection";

export interface AccountAvailabilityEvidence
  extends AccountAvailabilityContext {
  provider: string;
  model: string;
  state: Exclude<AccountAvailability, "unknown">;
  observedAt: string;
  expiresAt: string;
  source: AccountAvailabilityEvidenceSource;
}

interface EvidenceDocument {
  schemaVersion: typeof ACCOUNT_AVAILABILITY_SCHEMA_VERSION;
  records: AccountAvailabilityEvidence[];
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function decodeEvidence(value: unknown): AccountAvailabilityEvidence {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Account availability evidence record is not an object");
  const record = value as Record<string, unknown>;
  const strings = [
    "accountScope",
    "authGeneration",
    "profileId",
    "profileDigest",
    "provider",
    "model",
    "observedAt",
    "expiresAt",
    "source",
  ] as const;
  for (const key of strings) {
    if (!isNonEmptyString(record[key]))
      throw new Error(`Account availability evidence ${key} is invalid`);
  }
  if (
    !SHA256.test(record.accountScope as string) ||
    !SHA256.test(record.authGeneration as string) ||
    !PROFILE_DIGEST.test(record.profileDigest as string) ||
    !SAFE_IDENTIFIER.test(record.profileId as string) ||
    !SAFE_IDENTIFIER.test(record.provider as string) ||
    !SAFE_IDENTIFIER.test(record.model as string)
  )
    throw new Error("Account availability evidence identity is invalid");
  if (
    record.state !== "verified_available" &&
    record.state !== "verified_unavailable"
  )
    throw new Error("Account availability evidence state is invalid");
  if (
    record.source !== "direct_execution_success" &&
    record.source !== "direct_provider_rejection" &&
    record.source !== "preserved_execution_success" &&
    record.source !== "preserved_provider_rejection"
  )
    throw new Error("Account availability evidence source is invalid");
  const observedAt = Date.parse(record.observedAt as string);
  const expiresAt = Date.parse(record.expiresAt as string);
  if (
    !Number.isFinite(observedAt) ||
    !Number.isFinite(expiresAt) ||
    expiresAt <= observedAt ||
    expiresAt - observedAt > MAX_EVIDENCE_TTL_MS
  )
    throw new Error("Account availability evidence lifetime is invalid");
  return record as unknown as AccountAvailabilityEvidence;
}

function decodeDocument(value: unknown): EvidenceDocument {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Account availability evidence document is not an object");
  const document = value as Record<string, unknown>;
  if (document.schemaVersion !== ACCOUNT_AVAILABILITY_SCHEMA_VERSION)
    throw new Error("Account availability evidence schema is unsupported");
  if (
    !Array.isArray(document.records) ||
    document.records.length > MAX_EVIDENCE_RECORDS
  )
    throw new Error("Account availability evidence records are invalid");
  return {
    schemaVersion: ACCOUNT_AVAILABILITY_SCHEMA_VERSION,
    records: document.records.map(decodeEvidence),
  };
}

function sameContext(
  record: AccountAvailabilityEvidence,
  context: AccountAvailabilityContext,
): boolean {
  return (
    record.accountScope === context.accountScope &&
    record.authGeneration === context.authGeneration &&
    record.profileId === context.profileId &&
    record.profileDigest === context.profileDigest
  );
}

function latestRecords(
  records: AccountAvailabilityEvidence[],
): AccountAvailabilityEvidence[] {
  return records
    .sort(
      (left, right) =>
        Date.parse(right.observedAt) - Date.parse(left.observedAt),
    )
    .slice(0, MAX_EVIDENCE_RECORDS)
    .sort((left, right) => recordKey(left).localeCompare(recordKey(right)));
}

function recordKey(record: AccountAvailabilityEvidence): string {
  return [
    record.accountScope,
    record.authGeneration,
    record.profileId,
    record.profileDigest,
    record.provider,
    record.model,
  ].join("\u0000");
}

export function newAccountAvailabilityEvidence(
  context: AccountAvailabilityContext,
  model: { provider: string; model: string },
  state: Exclude<AccountAvailability, "unknown">,
  source: AccountAvailabilityEvidenceSource,
  observedAt = new Date(),
): AccountAvailabilityEvidence {
  return {
    ...context,
    ...model,
    state,
    source,
    observedAt: observedAt.toISOString(),
    expiresAt: new Date(
      observedAt.getTime() + ACCOUNT_AVAILABILITY_TTL_MS,
    ).toISOString(),
  };
}

export class AccountAvailabilityEvidenceStore {
  private operation: Promise<unknown> = Promise.resolve();

  constructor(private readonly path: string) {}

  private serialized<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operation.then(operation, operation);
    this.operation = result.catch(() => undefined);
    return result;
  }

  private async readDocument(): Promise<EvidenceDocument> {
    try {
      return decodeDocument(JSON.parse(await readFile(this.path, "utf8")));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT")
        return {
          schemaVersion: ACCOUNT_AVAILABILITY_SCHEMA_VERSION,
          records: [],
        };
      throw error;
    }
  }

  private async writeDocument(document: EvidenceDocument): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    const tempPath = `${this.path}.${randomUUID()}.tmp`;
    await writeFile(tempPath, `${JSON.stringify(document, null, 2)}\n`, {
      mode: 0o600,
    });
    try {
      await rename(tempPath, this.path);
    } catch (error) {
      await unlink(tempPath).catch(() => undefined);
      throw error;
    }
  }

  async record(evidence: AccountAvailabilityEvidence): Promise<void> {
    const decoded = decodeEvidence(evidence);
    await this.serialized(async () => {
      const document = await this.readDocument();
      const key = recordKey(decoded);
      const previous = document.records.find(
        (record) => recordKey(record) === key,
      );
      if (
        previous &&
        Date.parse(previous.observedAt) > Date.parse(decoded.observedAt)
      )
        return;
      const records = document.records.filter(
        (record) => recordKey(record) !== key,
      );
      records.push(decoded);
      await this.writeDocument({
        ...document,
        records: latestRecords(records),
      });
    });
  }

  async importFile(path: string): Promise<void> {
    const imported = decodeDocument(JSON.parse(await readFile(path, "utf8")));
    await this.serialized(async () => {
      const document = await this.readDocument();
      const records = new Map(
        document.records.map((record) => [recordKey(record), record]),
      );
      for (const record of imported.records) {
        const previous = records.get(recordKey(record));
        if (
          !previous ||
          Date.parse(record.observedAt) >= Date.parse(previous.observedAt)
        )
          records.set(recordKey(record), record);
      }
      await this.writeDocument({
        ...document,
        records: latestRecords([...records.values()]),
      });
    });
  }

  async recheck(
    context: AccountAvailabilityContext,
    model: { provider: string; model: string },
  ): Promise<void> {
    await this.serialized(async () => {
      const document = await this.readDocument();
      await this.writeDocument({
        ...document,
        records: document.records.filter(
          (record) =>
            !(
              sameContext(record, context) &&
              record.provider === model.provider &&
              record.model === model.model
            ),
        ),
      });
    });
  }

  async annotate(
    models: HarnessModelCapability[],
    context: AccountAvailabilityContext,
    now = new Date(),
  ): Promise<HarnessModelCapability[]> {
    return this.serialized(async () => {
      const document = await this.readDocument();
      const nowMs = now.getTime();
      const unexpired = document.records.filter(
        (record) => Date.parse(record.expiresAt) > nowMs,
      );
      if (unexpired.length !== document.records.length)
        await this.writeDocument({ ...document, records: unexpired });
      const current = new Map<string, AccountAvailabilityEvidence>();
      for (const record of unexpired) {
        if (!sameContext(record, context)) continue;
        current.set(`${record.provider}\u0000${record.model}`, record);
      }
      return models.map((model) => ({
        ...model,
        accountAvailability:
          current.get(`${model.provider}\u0000${model.model}`)?.state ??
          "unknown",
      }));
    });
  }
}
