#!/usr/bin/env node
import { type ChildProcess, spawn } from "node:child_process";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { verifyEnvironmentAttestation } from "../pi/sbx-herdr-state-extension.ts";
import {
  type AntigravityInitialConversationRequest,
  initialConversationAcknowledgement,
  initialConversationArgs,
  parseInitialConversationBinding,
  parseInitialConversationRequest,
} from "./initial-conversation.ts";

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
  args.includes("--prompt-interactive") ||
  args.filter((value) => value === "--model").length !== 1 ||
  args.filter((value) => value === "--log-file").length !== 1 ||
  args.filter((value) => value === "--dangerously-skip-permissions").length !==
    1
) {
  console.error("QE Antigravity launcher refused unexpected argv.");
  process.exit(74);
}

const statePath = process.env.QE_SBX_RUNTIME_STATE_PATH?.trim();
const requestPath =
  process.env.QE_ANTIGRAVITY_INITIAL_DISPATCH_REQUEST_PATH?.trim();
const acknowledgementPath =
  process.env.QE_ANTIGRAVITY_INITIAL_DISPATCH_ACK_PATH?.trim();
const initialConversationLogPath =
  process.env.QE_ANTIGRAVITY_INITIAL_DISPATCH_LOG_PATH?.trim();
if (
  !statePath?.startsWith("/") ||
  !requestPath?.startsWith("/") ||
  !acknowledgementPath?.startsWith("/") ||
  !initialConversationLogPath?.startsWith("/")
) {
  console.error("QE Antigravity launcher has no exact runtime control paths.");
  process.exit(74);
}

let binding: ReturnType<typeof parseInitialConversationBinding>;
try {
  binding = parseInitialConversationBinding(
    process.env.QE_ANTIGRAVITY_INITIAL_DISPATCH_BINDING_JSON,
  );
} catch (error) {
  console.error(
    error instanceof Error ? error.message : "invalid initial dispatch binding",
  );
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

let active: RunningChild | null = null;
let shuttingDown = false;
for (const signal of ["SIGWINCH", "SIGTERM", "SIGHUP", "SIGINT"] as const)
  process.on(signal, () => {
    if (signal === "SIGWINCH") {
      active?.child.kill(signal);
      return;
    }
    shuttingDown = true;
    const target = active;
    target?.child.kill(signal);
    if (target)
      setTimeout(() => {
        if (target.child.exitCode === null && target.child.signalCode === null)
          target.child.kill("SIGKILL");
      }, 5_000).unref();
  });

active = launch(args);
process.exitCode = await superviseInitialConversation(active);

async function superviseInitialConversation(
  initial: RunningChild,
): Promise<number> {
  while (!shuttingDown) {
    const exited = await exitedOrDelay(initial, 50);
    if (exited !== null) return exited;
    let encoded: string;
    try {
      encoded = await readFile(requestPath as string, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      console.error("QE Antigravity launcher could not read initial dispatch.");
      return 74;
    }

    let request: AntigravityInitialConversationRequest;
    let initialArgs: string[];
    try {
      request = parseInitialConversationRequest(encoded, binding);
      initialArgs = initialConversationArgs(
        args,
        request.prompt,
        initialConversationLogPath as string,
      );
    } catch (error) {
      console.error(
        error instanceof Error
          ? error.message
          : "invalid Antigravity initial conversation request",
      );
      return 74;
    }
    await rm(requestPath as string, { force: true });

    const stopped = await stopConversationFreeChild(initial);
    if (!stopped) {
      await publish(
        acknowledgementPath as string,
        initialConversationAcknowledgement(
          request,
          "failed",
          new Date().toISOString(),
          "conversation-free Antigravity process did not stop within the bounded transition",
        ),
      );
      return 74;
    }

    if (shuttingDown) return await initial.exited;

    const prompted = launch(initialArgs);
    active = prompted;
    if (!(await spawned(prompted))) {
      await stopConversationFreeChild(prompted);
      await publish(
        acknowledgementPath as string,
        initialConversationAcknowledgement(
          request,
          "failed",
          new Date().toISOString(),
          "native --prompt-interactive process did not start",
        ),
      );
      return 74;
    }
    try {
      await publish(
        acknowledgementPath as string,
        initialConversationAcknowledgement(
          request,
          "started",
          new Date().toISOString(),
        ),
      );
    } catch {
      // Preserve the one submitted native prompt. The host will reconcile the
      // missing acknowledgement against append-only native log evidence.
      console.error(
        "QE Antigravity launcher could not publish initial-dispatch acknowledgement.",
      );
    }
    return await prompted.exited;
  }
  return await initial.exited;
}

interface RunningChild {
  child: ChildProcess;
  exited: Promise<number>;
  didSpawn: Promise<boolean>;
}

function launch(childArgs: readonly string[]): RunningChild {
  const child = spawn(executable as string, [...childArgs], {
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
  const didSpawn = new Promise<boolean>((resolve) => {
    let settled = false;
    const finish = (value: boolean) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    child.once("spawn", () => finish(true));
    child.once("error", () => finish(false));
  });
  return { child, exited, didSpawn };
}

async function spawned(child: RunningChild): Promise<boolean> {
  return await Promise.race([child.didSpawn, delay(5_000).then(() => false)]);
}

async function stopConversationFreeChild(
  child: RunningChild,
): Promise<boolean> {
  child.child.kill("SIGTERM");
  if (
    await Promise.race([
      child.exited.then(() => true),
      delay(5_000).then(() => false),
    ])
  )
    return true;
  child.child.kill("SIGKILL");
  return await Promise.race([
    child.exited.then(() => true),
    delay(5_000).then(() => false),
  ]);
}

async function exitedOrDelay(
  child: RunningChild,
  delayMs: number,
): Promise<number | null> {
  return await Promise.race([child.exited, delay(delayMs).then(() => null)]);
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

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
