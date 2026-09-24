#!/usr/bin/env node
import { spawn } from "node:child_process";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { verifyEnvironmentAttestation } from "../pi/sbx-herdr-state-extension.ts";

const [executable, ...args] = process.argv.slice(2);
if (executable !== "/opt/qe/antigravity/agy") {
  console.error("QE Antigravity launcher refused an unexpected executable.");
  process.exit(74);
}

let expectedArgs: unknown;
try {
  expectedArgs = JSON.parse(
    process.env.QE_ANTIGRAVITY_EXPECTED_ARGV_JSON ?? "null",
  );
} catch {
  expectedArgs = null;
}
if (
  !Array.isArray(expectedArgs) ||
  !expectedArgs.every((value) => typeof value === "string") ||
  JSON.stringify(args) !== JSON.stringify(expectedArgs) ||
  args.includes("--sandbox") ||
  args.filter((value) => value === "--model").length !== 1 ||
  args.filter((value) => value === "--log-file").length !== 1 ||
  args.filter((value) => value === "--dangerously-skip-permissions").length !==
    1
) {
  console.error("QE Antigravity launcher refused unexpected argv.");
  process.exit(74);
}

const statePath = process.env.QE_SBX_RUNTIME_STATE_PATH?.trim();
if (!statePath?.startsWith("/")) {
  console.error("QE Antigravity launcher has no runtime-state path.");
  process.exit(74);
}

let attestation: Record<string, string | number> | undefined;
let attestationFailure: string | undefined;
try {
  attestation = await verifyEnvironmentAttestation(process.env, process.cwd());
} catch (error) {
  attestationFailure =
    error instanceof Error ? error.message : "unknown attestation failure";
}
await publish(statePath, {
  schemaVersion: 1,
  sequence: Date.now() * 1000,
  lastWorkingSequence: 0,
  providerTurnSequence: 0,
  state: "idle",
  observedAt: new Date().toISOString(),
  ...(attestation ? { attestation } : {}),
  ...(attestationFailure ? { attestationFailure } : {}),
});
if (!attestation) process.exit(74);

const child = spawn(executable, args, {
  env: process.env,
  stdio: "inherit",
});
for (const signal of ["SIGWINCH", "SIGTERM", "SIGHUP", "SIGINT"] as const)
  process.on(signal, () => child.kill(signal));
process.exitCode = await new Promise<number>((resolve) => {
  child.once("exit", (code) => resolve(code ?? 1));
  child.once("error", () => resolve(1));
});

async function publish(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${crypto.randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value)}\n`, {
    encoding: "utf8",
    mode: 0o600,
    flag: "wx",
  });
  await rename(temporary, path);
}
