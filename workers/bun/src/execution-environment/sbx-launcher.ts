#!/usr/bin/env bun
import { CliSbxClient } from "./sbx-client.ts";
import type { EnvironmentCommand } from "./types.ts";

const input = parse(process.argv.slice(2));
const client = new CliSbxClient(input.sbx);
const sandboxes = await client.list();
const exact = sandboxes.find(
  (sandbox) =>
    sandbox.id === input.id &&
    sandbox.name === input.name &&
    sandbox.agent === input.agent &&
    sandbox.status === "running",
);
if (!exact) {
  console.error(
    "SBX launcher refused a stale, stopped, or mismatched environment ref.",
  );
  process.exit(74);
}
await ensureNonzeroPtySize();
const child = Bun.spawn(
  [client.executable, ...client.launcherArgs(input.name, input.command)],
  { stdin: "inherit", stdout: "inherit", stderr: "inherit" },
);
for (const signal of ["SIGWINCH", "SIGTERM", "SIGHUP"] as const)
  process.on(signal, () => child.kill(signal));
process.exitCode = await child.exited;

function parse(args: string[]): {
  sbx: string;
  name: string;
  id: string;
  agent: string;
  command: EnvironmentCommand;
} {
  const separator = args.indexOf("--");
  const optionArgs = separator < 0 ? args : args.slice(0, separator);
  const commandTail = separator < 0 ? [] : args.slice(separator + 1);
  const values = new Map<string, string>();
  for (let index = 0; index < optionArgs.length; index += 2) {
    const key = optionArgs[index];
    const value = optionArgs[index + 1];
    if (!key?.startsWith("--") || value === undefined)
      throw new Error("Malformed SBX launcher arguments.");
    values.set(key.slice(2), value);
  }
  const sbx = required(values, "sbx");
  const name = required(values, "name");
  const id = required(values, "id");
  const agent = values.get("agent") || "shell";
  let decoded: unknown;
  try {
    decoded = JSON.parse(
      Buffer.from(required(values, "command"), "base64").toString("utf8"),
    );
  } catch {
    throw new Error("Malformed SBX launcher command.");
  }
  if (!decoded || typeof decoded !== "object" || Array.isArray(decoded))
    throw new Error("Malformed SBX launcher command.");
  const command = decoded as Partial<EnvironmentCommand>;
  if (
    typeof command.executable !== "string" ||
    command.executable.length === 0 ||
    !Array.isArray(command.args) ||
    command.args.some((arg) => typeof arg !== "string") ||
    (command.cwd !== undefined && typeof command.cwd !== "string") ||
    (command.environment !== undefined &&
      (!command.environment ||
        typeof command.environment !== "object" ||
        Array.isArray(command.environment) ||
        Object.values(command.environment).some(
          (value) => typeof value !== "string",
        )))
  )
    throw new Error("Malformed SBX launcher command.");
  return {
    sbx,
    name,
    id,
    agent,
    command: {
      executable: command.executable,
      args: [...command.args, ...commandTail],
      ...(command.cwd ? { cwd: command.cwd } : {}),
      ...(command.environment
        ? { environment: { ...command.environment } }
        : {}),
      ...(command.timeoutMs ? { timeoutMs: command.timeoutMs } : {}),
    },
  };
}

async function ensureNonzeroPtySize(): Promise<void> {
  if (!process.stdin.isTTY) return;
  const probe = Bun.spawn(["/bin/stty", "size"], {
    stdin: "inherit",
    stdout: "pipe",
    stderr: "ignore",
  });
  const output = await new Response(probe.stdout).text();
  if ((await probe.exited) !== 0) return;
  const [rows, columns] = output
    .trim()
    .split(/\s+/)
    .map((value) => Number(value));
  if ((rows ?? 0) > 0 && (columns ?? 0) > 0) return;
  const resize = Bun.spawn(["/bin/stty", "rows", "24", "cols", "80"], {
    stdin: "inherit",
    stdout: "ignore",
    stderr: "ignore",
  });
  await resize.exited;
}

function required(values: Map<string, string>, key: string): string {
  const value = values.get(key);
  if (!value) throw new Error(`Missing SBX launcher ${key}.`);
  return value;
}
