import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
  HARNESS_CONTROL_PROTOCOL_VERSION,
  type HarnessControlDescriptor,
  HarnessControlError,
} from "./types.ts";

export const HARNESS_CONTROL_PATH_ENV = "QE_HARNESS_CONTROL_PATH";

export async function writeControlDescriptor(
  path: string,
  descriptor: HarnessControlDescriptor,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${crypto.randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(descriptor)}\n`, {
    encoding: "utf8",
    mode: 0o600,
    flag: "wx",
  });
  await rename(temporary, path);
}

export async function readControlDescriptor(
  path: string,
): Promise<HarnessControlDescriptor> {
  let value: unknown;
  try {
    value = JSON.parse(await readFile(path, "utf8"));
  } catch {
    throw new HarnessControlError(
      "bridge_unavailable",
      "Quest Engineering harness control descriptor is unavailable.",
    );
  }
  if (
    !record(value) ||
    value.protocolVersion !== HARNESS_CONTROL_PROTOCOL_VERSION ||
    !record(value.endpoint) ||
    value.endpoint.host !== "127.0.0.1" ||
    !Number.isSafeInteger(value.endpoint.port) ||
    Number(value.endpoint.port) < 1 ||
    Number(value.endpoint.port) > 65_535 ||
    typeof value.bridgeGeneration !== "string" ||
    value.bridgeGeneration.length < 16 ||
    typeof value.contextToken !== "string" ||
    value.contextToken.length < 32
  )
    throw new HarnessControlError(
      "invalid_request",
      "Quest Engineering harness control descriptor is invalid.",
    );
  return value as unknown as HarnessControlDescriptor;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
