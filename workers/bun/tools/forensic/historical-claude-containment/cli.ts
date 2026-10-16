#!/usr/bin/env bun
import { lstat } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { CliSbxClient } from "../../../src/execution-environment/sbx-client.ts";
import { SbxPidfdPhysicalProcessController } from "./physical.ts";
import { runHistoricalContainment } from "./procedure.ts";
import {
  HISTORICAL_PRODUCT_DATABASE_NAME,
  ReadOnlyProductEvidenceReader,
} from "./product-evidence.ts";
import { ContainmentError, type ContainmentRunOptions } from "./types.ts";

interface CliOptions extends ContainmentRunOptions {
  productDatabaseUrlEnvironment: string;
  productDatabaseName: string;
  sbxExecutable: string;
}

export function parseContainmentArguments(args: readonly string[]): CliOptions {
  const values = new Map<string, string>();
  let executeCancellation = false;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index] as string;
    if (argument === "--execute-cancellation") {
      if (executeCancellation)
        invalid("Duplicate --execute-cancellation flag.");
      executeCancellation = true;
      continue;
    }
    if (!argument.startsWith("--")) invalid("Unexpected positional argument.");
    if (!VALUE_ARGUMENTS.has(argument))
      invalid(`Unknown argument ${argument}.`);
    if (values.has(argument)) invalid(`Duplicate argument ${argument}.`);
    const value = args[index + 1];
    if (!value || value.startsWith("--"))
      invalid(`Argument ${argument} requires a value.`);
    values.set(argument, value);
    index += 1;
  }
  const required = (name: string): string => {
    const value = values.get(name);
    if (!value) invalid(`Missing required argument ${name}.`);
    return value;
  };
  const databaseEnvironment = required("--product-database-url-env");
  if (!/^[A-Z][A-Z0-9_]*$/.test(databaseEnvironment))
    invalid("Product database URL environment-variable name is invalid.");
  const databaseName = required("--product-database-name");
  if (databaseName !== HISTORICAL_PRODUCT_DATABASE_NAME)
    invalid(
      "Product database name does not match the reviewed historical target.",
    );
  const timeout = optionalPositiveInteger(
    values.get("--settlement-timeout-ms"),
    "--settlement-timeout-ms",
  );
  const poll = optionalPositiveInteger(
    values.get("--settlement-poll-ms"),
    "--settlement-poll-ms",
  );
  return {
    workerLedgerPath: required("--worker-v2-ledger"),
    environmentLedgerPath: required("--environment-ledger"),
    journalPath: required("--containment-journal"),
    setupAttemptId: required("--setup-attempt-id"),
    containmentOperationId: required("--containment-operation-id"),
    productDatabaseUrlEnvironment: databaseEnvironment,
    productDatabaseName: databaseName,
    sbxExecutable: required("--sbx-executable"),
    executeCancellation,
    ...(values.has("--confirm-cancellation-request-id")
      ? {
          confirmCancellationRequestId: values.get(
            "--confirm-cancellation-request-id",
          ) as string,
        }
      : {}),
    ...(values.has("--confirm-physical-identity-digest")
      ? {
          confirmPhysicalIdentityDigest: values.get(
            "--confirm-physical-identity-digest",
          ) as string,
        }
      : {}),
    ...(timeout === undefined ? {} : { settlementTimeoutMs: timeout }),
    ...(poll === undefined ? {} : { settlementPollMs: poll }),
  };
}

async function main(): Promise<void> {
  if (process.argv.includes("--help")) {
    process.stdout.write(USAGE);
    return;
  }
  let product: ReadOnlyProductEvidenceReader | null = null;
  try {
    const options = parseContainmentArguments(process.argv.slice(2));
    await assertExecutable(options.sbxExecutable);
    const databaseUrl = process.env[options.productDatabaseUrlEnvironment];
    if (!databaseUrl)
      invalid(
        `Environment variable ${options.productDatabaseUrlEnvironment} is unavailable.`,
      );
    product = new ReadOnlyProductEvidenceReader(databaseUrl, {
      expectedDatabaseName: options.productDatabaseName,
    });
    const physical = new SbxPidfdPhysicalProcessController(
      new CliSbxClient(options.sbxExecutable),
    );
    const result = await runHistoricalContainment(options, {
      productEvidence: product,
      physical,
    });
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    const code =
      error instanceof ContainmentError ? error.code : "unexpected_failure";
    const message =
      error instanceof ContainmentError
        ? error.message
        : "Containment failed without exposing underlying data.";
    process.stderr.write(`${JSON.stringify({ error: code, message })}\n`);
    process.exitCode = 1;
  } finally {
    await product?.close().catch(() => undefined);
  }
}

async function assertExecutable(path: string): Promise<void> {
  if (!isAbsolute(path)) invalid("SBX executable path must be absolute.");
  const status = await lstat(path).catch(() => null);
  if (!status?.isFile() || status.isSymbolicLink())
    invalid("SBX executable must be one existing regular non-symlink file.");
  if ((status.mode & 0o111) === 0) invalid("SBX executable is not executable.");
}

function optionalPositiveInteger(
  value: string | undefined,
  name: string,
): number | undefined {
  if (value === undefined) return undefined;
  if (
    !/^\d+$/.test(value) ||
    Number(value) < 1 ||
    !Number.isSafeInteger(Number(value))
  )
    invalid(`${name} must be a positive integer.`);
  return Number(value);
}

function invalid(message: string): never {
  throw new ContainmentError("invalid_arguments", message);
}

const VALUE_ARGUMENTS = new Set([
  "--worker-v2-ledger",
  "--environment-ledger",
  "--containment-journal",
  "--product-database-url-env",
  "--product-database-name",
  "--sbx-executable",
  "--setup-attempt-id",
  "--containment-operation-id",
  "--confirm-cancellation-request-id",
  "--confirm-physical-identity-digest",
  "--settlement-timeout-ms",
  "--settlement-poll-ms",
]);

const USAGE = `Historical Claude process containment — review/implementation does not authorize execution.

Default mode is inspect-only and submits zero signals:
  bun run tools/forensic/historical-claude-containment/cli.ts \\
    --worker-v2-ledger /absolute/read-only/provider-account-setups.sqlite \\
    --environment-ledger /absolute/read-only/execution-environments.sqlite \\
    --containment-journal /absolute/separate/containment-journal.sqlite \\
    --product-database-url-env QE_CONTAINMENT_PRODUCT_DATABASE_URL \\
    --product-database-name qe_phase_e_fresh_16f44656_v3 \\
    --sbx-executable /absolute/path/to/sbx \\
    --setup-attempt-id <exact-reviewed-attempt-id> \\
    --containment-operation-id <explicit-uuid>

Destructive mode additionally requires all three exact interlocks:
  --execute-cancellation
  --confirm-cancellation-request-id <exact-existing-request-id>
  --confirm-physical-identity-digest <sha256 digest emitted by reviewed dry-run>

Never run destructive mode without a separate explicit human instruction:
  EXECUTE HISTORICAL CONTAINMENT
`;

if (import.meta.main) await main();
