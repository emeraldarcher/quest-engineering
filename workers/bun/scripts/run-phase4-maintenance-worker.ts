#!/usr/bin/env bun
import { writeFile } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { OwnedProcess } from "./lib/owned-process.ts";

if (process.env.QE_WORKER_DISPATCH_AVAILABILITY !== "maintenance")
  throw new Error(
    "Phase-4 diagnostic Worker launch requires QE_WORKER_DISPATCH_AVAILABILITY=maintenance.",
  );

const metadataArgument = process.argv[2];
if (!metadataArgument)
  throw new Error(
    "Usage: run-phase4-maintenance-worker.ts OWNERSHIP-METADATA.json",
  );

const cwd = process.cwd();
const metadataPath = resolve(metadataArgument);
const metadataRelative = relative(cwd, metadataPath);
if (
  isAbsolute(metadataRelative) ||
  metadataRelative === ".." ||
  metadataRelative.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`)
)
  throw new Error("Ownership metadata must remain inside the repository.");

const worker = await OwnedProcess.start({
  argv: [process.execPath, resolve(import.meta.dir, "../src/main.ts")],
  cwd,
  env: process.env,
});

let outcome:
  | { kind: "launcher_error" }
  | { kind: "unexpected_exit"; exit: number }
  | { kind: "stop_requested" } = { kind: "launcher_error" };
try {
  await persist({ state: "running", ownership: worker.metadata });

  let release: (() => void) | undefined;
  const stopRequested = new Promise<void>((resolveStop) => {
    release = resolveStop;
  });
  for (const signal of ["SIGINT", "SIGTERM"] as const)
    process.once(signal, () => release?.());

  outcome = await Promise.race([
    worker.wait().then((exit) => ({ kind: "unexpected_exit" as const, exit })),
    stopRequested.then(() => ({ kind: "stop_requested" as const })),
  ]);
} finally {
  const stopped = await worker.stop();
  await persist({
    state: "stopped",
    outcome,
    ownership: worker.metadata,
    teardown: stopped,
  });
}
if (outcome.kind === "unexpected_exit") process.exitCode = 1;

async function persist(value: Record<string, unknown>): Promise<void> {
  await writeFile(metadataPath, `${JSON.stringify(value, null, 2)}\n`, {
    mode: 0o600,
  });
}
