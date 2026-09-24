import { isAbsolute } from "node:path";

export interface OwnedProcessSnapshot {
  pid: number;
  parentPid: number;
  processGroupId: number;
  state: string;
  startedAt: string;
  command: string;
}

export interface OwnedProcessMetadata extends OwnedProcessSnapshot {
  sessionId: number;
  executable: string;
  argv: string[];
  cwd: string;
}

export interface OwnedProcessStopResult {
  pid: number;
  processGroupId: number;
  exitCode: number;
  forced: boolean;
  stoppedAt: string;
}

export interface OwnedProcessOptions {
  argv: [string, ...string[]];
  cwd: string;
  env?: Record<string, string | undefined>;
  stdoutPath?: string;
  stderrPath?: string;
  startupTimeoutMs?: number;
}

/**
 * Owns one direct executable and its dedicated POSIX process group.
 *
 * No shell is introduced. Bun's detached spawn performs setsid(2), making the
 * exact child PID the process-group leader. Teardown signals only that proven
 * group, waits for the direct child, and verifies that no group members remain.
 */
export class OwnedProcess {
  readonly pid: number;
  readonly processGroupId: number;
  private stopped = false;

  private constructor(
    private readonly child: ReturnType<typeof Bun.spawn>,
    readonly started: OwnedProcessSnapshot,
    readonly metadata: OwnedProcessMetadata,
  ) {
    this.pid = started.pid;
    this.processGroupId = started.processGroupId;
  }

  static async start(options: OwnedProcessOptions): Promise<OwnedProcess> {
    const [executable] = options.argv;
    if (!isAbsolute(executable))
      throw new Error("Owned process executable must be absolute.");
    if (!isAbsolute(options.cwd))
      throw new Error("Owned process cwd must be absolute.");
    if (options.stdoutPath && !isAbsolute(options.stdoutPath))
      throw new Error("Owned process stdout path must be absolute.");
    if (options.stderrPath && !isAbsolute(options.stderrPath))
      throw new Error("Owned process stderr path must be absolute.");

    const child = Bun.spawn(options.argv, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      detached: true,
      stdin: "ignore",
      stdout: options.stdoutPath ? Bun.file(options.stdoutPath) : "ignore",
      stderr: options.stderrPath ? Bun.file(options.stderrPath) : "ignore",
    });
    const timeoutMs = options.startupTimeoutMs ?? 5_000;
    try {
      const started = await waitForSnapshot(child.pid, timeoutMs);
      if (started.processGroupId !== child.pid)
        throw new Error(
          `Owned process ${child.pid} is not its process-group leader (pgid ${started.processGroupId}).`,
        );
      const sessionId = await processSessionId(child.pid);
      if (sessionId !== child.pid)
        throw new Error(
          `Owned process ${child.pid} is not its POSIX session leader (sid ${sessionId}).`,
        );
      return new OwnedProcess(child, started, {
        ...started,
        sessionId,
        executable,
        argv: [...options.argv],
        cwd: options.cwd,
      });
    } catch (error) {
      try {
        process.kill(child.pid, "SIGTERM");
      } catch {
        // The failed child has already exited.
      }
      await Promise.race([child.exited, Bun.sleep(1_000)]);
      throw error;
    }
  }

  wait(): Promise<number> {
    return this.child.exited;
  }

  async snapshot(): Promise<OwnedProcessSnapshot | null> {
    return processSnapshot(this.pid);
  }

  async groupMembers(): Promise<OwnedProcessSnapshot[]> {
    return processGroupMembers(this.processGroupId);
  }

  async stop(timeoutMs = 10_000): Promise<OwnedProcessStopResult> {
    if (this.stopped)
      throw new Error(`Owned process ${this.pid} was already stopped.`);
    this.stopped = true;
    const startedAt = Date.now();
    const gracefulDeadline = startedAt + Math.min(5_000, timeoutMs / 2);
    const deadline = startedAt + timeoutMs;
    let forced = false;

    signalGroup(this.processGroupId, "SIGTERM");
    let remaining = await waitForGroupExit(
      this.processGroupId,
      Math.max(0, gracefulDeadline - Date.now()),
    );
    if (remaining.length > 0) {
      forced = true;
      signalGroup(this.processGroupId, "SIGKILL");
      remaining = await waitForGroupExit(
        this.processGroupId,
        Math.max(0, deadline - Date.now()),
      );
    }
    if (remaining.length > 0)
      throw new Error(
        `Owned process group ${this.processGroupId} did not stop: ${remaining
          .map((process) => process.pid)
          .join(", ")}.`,
      );

    const exitCode = await this.child.exited;
    return {
      pid: this.pid,
      processGroupId: this.processGroupId,
      exitCode,
      forced,
      stoppedAt: new Date().toISOString(),
    };
  }

  async stopAndConfirm(
    disconnected: () => boolean | Promise<boolean>,
    options: { processTimeoutMs?: number; disconnectTimeoutMs?: number } = {},
  ): Promise<OwnedProcessStopResult> {
    const result = await this.stop(options.processTimeoutMs ?? 10_000);
    const deadline = Date.now() + (options.disconnectTimeoutMs ?? 10_000);
    while (Date.now() <= deadline) {
      if (await disconnected()) return result;
      await Bun.sleep(50);
    }
    throw new Error(
      `Owned process ${this.pid} exited, but authoritative disconnect was not observed.`,
    );
  }
}

export async function processSnapshot(
  pid: number,
): Promise<OwnedProcessSnapshot | null> {
  const child = Bun.spawn(
    [
      "/bin/ps",
      "-p",
      String(pid),
      "-o",
      "pid=",
      "-o",
      "ppid=",
      "-o",
      "pgid=",
      "-o",
      "state=",
      "-o",
      "lstart=",
      "-o",
      "command=",
    ],
    { stdin: "ignore", stdout: "pipe", stderr: "pipe" },
  );
  const [stdout, code] = await Promise.all([
    new Response(child.stdout).text(),
    child.exited,
  ]);
  if (code !== 0 || !stdout.trim()) return null;
  return parseSnapshot(stdout.trim());
}

async function processSessionId(pid: number): Promise<number> {
  const child = Bun.spawn(
    [
      "/usr/bin/python3",
      "-c",
      "import os,sys; print(os.getsid(int(sys.argv[1])))",
      String(pid),
    ],
    { stdin: "ignore", stdout: "pipe", stderr: "pipe" },
  );
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0)
    throw new Error(
      `Could not inspect owned process session: ${stderr.trim()}`,
    );
  const sessionId = Number(stdout.trim());
  if (!Number.isInteger(sessionId) || sessionId <= 0)
    throw new Error(`Invalid owned process session ID: ${stdout.trim()}`);
  return sessionId;
}

async function processGroupMembers(
  processGroupId: number,
): Promise<OwnedProcessSnapshot[]> {
  const child = Bun.spawn(
    [
      "/bin/ps",
      "-axo",
      "pid=",
      "-o",
      "ppid=",
      "-o",
      "pgid=",
      "-o",
      "state=",
      "-o",
      "lstart=",
      "-o",
      "command=",
    ],
    { stdin: "ignore", stdout: "pipe", stderr: "pipe" },
  );
  const [stdout, code] = await Promise.all([
    new Response(child.stdout).text(),
    child.exited,
  ]);
  if (code !== 0) throw new Error("Could not inspect owned process group.");
  return stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map(parseSnapshot)
    .filter(
      (process) =>
        process.processGroupId === processGroupId &&
        !process.state.startsWith("Z"),
    );
}

function parseSnapshot(line: string): OwnedProcessSnapshot {
  const match = line.match(/^(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.{24})\s+(.+)$/);
  if (!match)
    throw new Error(`Could not parse process ownership snapshot: ${line}`);
  return {
    pid: Number(match[1]),
    parentPid: Number(match[2]),
    processGroupId: Number(match[3]),
    state: match[4] ?? "",
    startedAt: match[5] ?? "",
    command: match[6] ?? "",
  };
}

async function waitForSnapshot(
  pid: number,
  timeoutMs: number,
): Promise<OwnedProcessSnapshot> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    const snapshot = await processSnapshot(pid);
    if (snapshot) return snapshot;
    await Bun.sleep(25);
  }
  throw new Error(`Owned process ${pid} did not become observable.`);
}

async function waitForGroupExit(
  processGroupId: number,
  timeoutMs: number,
): Promise<OwnedProcessSnapshot[]> {
  const deadline = Date.now() + timeoutMs;
  let members: OwnedProcessSnapshot[] = [];
  do {
    members = await processGroupMembers(processGroupId);
    if (members.length === 0) return [];
    await Bun.sleep(25);
  } while (Date.now() <= deadline);
  return members;
}

function signalGroup(
  processGroupId: number,
  signal: "SIGTERM" | "SIGKILL",
): void {
  try {
    process.kill(-processGroupId, signal);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ESRCH") throw error;
  }
}
