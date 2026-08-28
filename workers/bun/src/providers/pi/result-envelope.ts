import { mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { ExecuteAction, JsonValue } from "../../protocol/types.ts";
import { isJsonValue } from "../../protocol/types.ts";

export const STEP_RESULT_PROTOCOL_VERSION = 1 as const;

export interface ResultControl {
  protocolVersion: typeof STEP_RESULT_PROTOCOL_VERSION;
  workerId: string;
  lineageId: string;
  action: ExecuteAction;
  nonce: string;
  resultDirectory: string;
}

export interface StepResultEnvelope {
  protocolVersion: typeof STEP_RESULT_PROTOCOL_VERSION;
  kind: "quest_engineering_step_result";
  workerId: string;
  actionId: string;
  runId: string;
  occurrenceId: string;
  attemptId: string;
  nonce: string;
  createdAt: string;
  outputs: Record<string, JsonValue>;
}

export async function writeControlAtomic(
  path: string,
  control: ResultControl,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${crypto.randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(control, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
  await rename(temporary, path);
}

export async function readControl(path: string): Promise<ResultControl> {
  const value = JSON.parse(await readFile(path, "utf8")) as unknown;
  if (
    !record(value) ||
    value.protocolVersion !== STEP_RESULT_PROTOCOL_VERSION ||
    typeof value.workerId !== "string" ||
    typeof value.lineageId !== "string" ||
    typeof value.nonce !== "string" ||
    typeof value.resultDirectory !== "string" ||
    !record(value.action)
  ) {
    throw new Error("Result control file is invalid.");
  }
  return value as unknown as ResultControl;
}

export async function writeStepResultAtomic(
  directory: string,
  toolCallId: string,
  envelope: StepResultEnvelope,
): Promise<string> {
  await mkdir(directory, { recursive: true });
  const safeCallId =
    toolCallId.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 80) ||
    crypto.randomUUID();
  const publication = `${safeCallId}-${crypto.randomUUID()}`;
  const destination = join(directory, `result-${publication}.json`);
  const temporary = join(directory, `.result-${publication}.tmp`);
  await writeFile(temporary, `${JSON.stringify(envelope, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
  await rename(temporary, destination);
  return destination;
}

export async function collectStepResult(dispatch: {
  action: ExecuteAction;
  resultNonce: string;
  resultDirectory: string;
}): Promise<{ envelope: StepResultEnvelope; path: string }> {
  let names: string[];
  try {
    names = (await readdir(dispatch.resultDirectory))
      .filter((name) => /^result-[a-zA-Z0-9_-]+\.json$/.test(name))
      .sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      throw new Error("Pi settled without a structured step result.");
    throw error;
  }
  if (names.length !== 1)
    throw new Error(
      names.length === 0
        ? "Pi settled without a structured step result."
        : `Pi produced ${names.length} structured step results; exactly one is required.`,
    );
  const path = join(dispatch.resultDirectory, names[0] as string);
  const value = JSON.parse(await readFile(path, "utf8")) as unknown;
  validateEnvelope(value, dispatch);
  return { envelope: value, path };
}

function validateEnvelope(
  value: unknown,
  dispatch: { action: ExecuteAction; resultNonce: string },
): asserts value is StepResultEnvelope {
  const action = dispatch.action;
  if (
    !record(value) ||
    value.protocolVersion !== STEP_RESULT_PROTOCOL_VERSION ||
    value.kind !== "quest_engineering_step_result" ||
    value.workerId !== action.worker_id ||
    value.actionId !== action.action_id ||
    value.runId !== action.run_id ||
    value.occurrenceId !== action.occurrence_id ||
    value.attemptId !== action.attempt_id ||
    value.nonce !== dispatch.resultNonce ||
    typeof value.createdAt !== "string" ||
    !Number.isFinite(Date.parse(value.createdAt)) ||
    !record(value.outputs)
  ) {
    throw new Error("Structured step result envelope or identity is invalid.");
  }
  validateOutputs(action.declared_outputs, value.outputs);
}

export function validateOutputs(
  declared: string[],
  outputs: Record<string, unknown>,
): asserts outputs is Record<string, JsonValue> {
  const actual = Object.keys(outputs).sort();
  const expected = [...declared].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    const missing = expected.filter((key) => !actual.includes(key));
    const undeclared = actual.filter((key) => !expected.includes(key));
    throw new Error(
      `Structured outputs do not match declarations (missing: ${missing.join(",") || "none"}; undeclared: ${undeclared.join(",") || "none"}).`,
    );
  }
  if (!Object.values(outputs).every(isJsonValue))
    throw new Error("Structured outputs contain a non-JSON-compatible value.");
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
