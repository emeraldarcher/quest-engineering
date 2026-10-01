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
  args.includes("--print") ||
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
const exited = new Promise<number>((resolve) => {
  let settled = false;
  const finish = (code: number) => {
    if (settled) return;
    settled = true;
    resolve(code);
  };
  child.once("exit", (code) => finish(code ?? 1));
  child.once("error", () => finish(1));
});
let shutdownTimer: ReturnType<typeof setTimeout> | null = null;
for (const signal of ["SIGWINCH", "SIGTERM", "SIGHUP", "SIGINT"] as const)
  process.on(signal, () => {
    child.kill(signal);
    if (signal === "SIGWINCH" || shutdownTimer) return;
    shutdownTimer = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null)
        child.kill("SIGKILL");
    }, 5_000);
    shutdownTimer.unref();
  });
process.exitCode = await exited;
if (shutdownTimer) clearTimeout(shutdownTimer);

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
