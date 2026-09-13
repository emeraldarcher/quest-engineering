import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export interface AntigravityCommandHookSpec {
  name: string;
  event: "PreInvocation" | "Stop";
  command: string;
  timeoutSeconds: number;
}

export interface AntigravityHookConfigInspection {
  hookConfigPresent: boolean;
  namespacedHookPresent: boolean;
  eventRegistered: boolean;
  commandMatches: boolean;
  timeoutMatches: boolean;
  namedHookCount: number;
  unrelatedHookNames: string[];
}

export interface AntigravityHookDiscoveryEvidence {
  hookDiscoveredByAntigravity: true;
  namedHookCount: number;
  hookConfigFileCount: number;
  nativeLogLine: string;
}

export interface SyntheticHookResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  output: Record<string, unknown>;
}

export interface AntigravityStopHookReadiness {
  hookConfigPresent: true;
  namespacedHookPresent: true;
  stopEventRegistered: true;
  hookDiscoveredByAntigravity: true;
  hookCommandRunnable: true;
  hookControlContextValid: true;
  syntheticHookInvocationSucceeded: true;
  discovery: AntigravityHookDiscoveryEvidence;
  syntheticOutput: Record<string, unknown>;
}

/** Merge one namespaced command hook without deleting unrelated user entries. */
export async function installAntigravityCommandHook(
  hookConfigPath: string,
  spec: AntigravityCommandHookSpec,
): Promise<void> {
  const config = await readHookConfigOrEmpty(hookConfigPath);
  const named = optionalRecord(config[spec.name]) ?? {};
  const events = Array.isArray(named[spec.event])
    ? [...(named[spec.event] as unknown[])]
    : [];
  const expected = commandEntry(spec);
  if (!events.some((entry) => sameCommandEntry(entry, expected)))
    events.push(expected);
  const updated = {
    ...config,
    [spec.name]: { ...named, [spec.event]: events },
  };
  await writeJsonAtomic(hookConfigPath, updated);
}

export async function removeAntigravityCommandHook(
  hookConfigPath: string,
  hookName: string,
): Promise<void> {
  let config: Record<string, unknown>;
  try {
    config = parseConfig(await readFile(hookConfigPath, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  if (!(hookName in config)) return;
  const { [hookName]: _removed, ...remaining } = config;
  if (Object.keys(remaining).length === 0) {
    await rm(hookConfigPath, { force: true });
    return;
  }
  await writeJsonAtomic(hookConfigPath, remaining);
}

export async function inspectAntigravityCommandHook(
  hookConfigPath: string,
  spec: AntigravityCommandHookSpec,
): Promise<AntigravityHookConfigInspection> {
  let config: Record<string, unknown>;
  try {
    config = parseConfig(await readFile(hookConfigPath, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      return {
        hookConfigPresent: false,
        namespacedHookPresent: false,
        eventRegistered: false,
        commandMatches: false,
        timeoutMatches: false,
        namedHookCount: 0,
        unrelatedHookNames: [],
      };
    throw error;
  }
  const named = optionalRecord(config[spec.name]);
  const events =
    named && Array.isArray(named[spec.event])
      ? (named[spec.event] as unknown[])
      : [];
  const matching = events.find((entry) =>
    sameCommandEntry(entry, commandEntry(spec)),
  );
  const record = optionalRecord(matching);
  return {
    hookConfigPresent: true,
    namespacedHookPresent: named !== null,
    eventRegistered: events.length > 0,
    commandMatches: record?.command === spec.command,
    timeoutMatches: record?.timeout === spec.timeoutSeconds,
    namedHookCount: Object.keys(config).length,
    unrelatedHookNames: Object.keys(config).filter(
      (name) => name !== spec.name,
    ),
  };
}

export async function waitForAntigravityHookDiscovery(input: {
  logPath: string;
  minimumNamedHooks: number;
  minimumConfigFiles: number;
  timeoutMs: number;
}): Promise<AntigravityHookDiscoveryEvidence> {
  const started = Date.now();
  const pattern = /loaded (\d+) named hooks from (\d+) hooks\.json file\(s\)/g;
  while (Date.now() - started < input.timeoutMs) {
    try {
      const log = await readFile(input.logPath, "utf8");
      for (const match of log.matchAll(pattern)) {
        const namedHookCount = Number(match[1]);
        const hookConfigFileCount = Number(match[2]);
        if (
          namedHookCount >= input.minimumNamedHooks &&
          hookConfigFileCount >= input.minimumConfigFiles
        )
          return {
            hookDiscoveredByAntigravity: true,
            namedHookCount,
            hookConfigFileCount,
            nativeLogLine: match[0],
          };
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await Bun.sleep(100);
  }
  throw new Error(
    "Antigravity did not report loading the expected workspace hook configuration.",
  );
}

export async function runSyntheticAntigravityHook(input: {
  argv: string[];
  payload: Record<string, unknown>;
  env: Record<string, string | undefined>;
}): Promise<SyntheticHookResult> {
  const child = Bun.spawn(input.argv, {
    env: input.env,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  child.stdin.write(JSON.stringify(input.payload));
  child.stdin.end();
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  const output = parseOutput(stdout);
  return { exitCode, stdout, stderr, output };
}

/**
 * Authoritative zero-inference Stop readiness: exact config, native discovery
 * log, executable command, and acceptance by the bound generic bridge.
 */
export async function proveAntigravityStopHookReadiness(input: {
  hookConfigPath: string;
  spec: AntigravityCommandHookSpec;
  logPath: string;
  syntheticArgv: string[];
  syntheticPayload: Record<string, unknown>;
  env: Record<string, string | undefined>;
  timeoutMs?: number;
}): Promise<AntigravityStopHookReadiness> {
  const inspection = await inspectAntigravityCommandHook(
    input.hookConfigPath,
    input.spec,
  );
  if (
    !inspection.hookConfigPresent ||
    !inspection.namespacedHookPresent ||
    !inspection.eventRegistered ||
    !inspection.commandMatches ||
    !inspection.timeoutMatches
  )
    throw new Error(
      `Antigravity Stop hook configuration is missing or incompatible: ${JSON.stringify(inspection)}.`,
    );
  const discovery = await waitForAntigravityHookDiscovery({
    logPath: input.logPath,
    minimumNamedHooks: inspection.namedHookCount,
    minimumConfigFiles: 1,
    timeoutMs: input.timeoutMs ?? 20_000,
  });
  const synthetic = await runSyntheticAntigravityHook({
    argv: input.syntheticArgv,
    payload: input.syntheticPayload,
    env: input.env,
  });
  if (synthetic.exitCode !== 0)
    throw new Error(
      `Antigravity Stop hook command failed (${synthetic.exitCode}): ${synthetic.stderr.trim() || synthetic.stdout.trim()}`,
    );
  if (synthetic.output.decision !== "continue")
    throw new Error(
      `Antigravity Stop hook did not reach the expected bridge context: ${synthetic.stdout.trim()}`,
    );
  return {
    hookConfigPresent: true,
    namespacedHookPresent: true,
    stopEventRegistered: true,
    hookDiscoveredByAntigravity: true,
    hookCommandRunnable: true,
    hookControlContextValid: true,
    syntheticHookInvocationSucceeded: true,
    discovery,
    syntheticOutput: synthetic.output,
  };
}

function commandEntry(spec: AntigravityCommandHookSpec) {
  return {
    type: "command",
    command: spec.command,
    timeout: spec.timeoutSeconds,
  };
}

function sameCommandEntry(
  value: unknown,
  expected: ReturnType<typeof commandEntry>,
): boolean {
  const entry = optionalRecord(value);
  return (
    entry?.type === expected.type &&
    entry.command === expected.command &&
    entry.timeout === expected.timeout
  );
}

async function readHookConfigOrEmpty(
  path: string,
): Promise<Record<string, unknown>> {
  try {
    return parseConfig(await readFile(path, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
}

function parseConfig(value: string): Record<string, unknown> {
  const parsed = JSON.parse(value) as unknown;
  const config = optionalRecord(parsed);
  if (!config)
    throw new Error("Antigravity hooks configuration must be a JSON object.");
  return config;
}

async function writeJsonAtomic(
  path: string,
  value: Record<string, unknown>,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${crypto.randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
    flag: "wx",
  });
  await rename(temporary, path);
}

function parseOutput(stdout: string): Record<string, unknown> {
  try {
    return optionalRecord(JSON.parse(stdout.trim())) ?? {};
  } catch {
    return {};
  }
}

function optionalRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
