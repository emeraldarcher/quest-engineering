import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import {
  assertHerdrDefaultSocketPathSafe,
  defaultHerdrSessionName,
  herdrDefaultSocketPaths,
} from "../src/config.ts";
import { LocalHerdrConnectionProvider } from "../src/session-host/herdr/connection.ts";

const enabled = process.env.QE_RUN_HERDR_STARTUP_LIVE === "1";
const iterations = Number(process.env.QE_HERDR_STARTUP_ITERATIONS ?? "20");

test.skipIf(!enabled)(
  "fresh default Worker-owned Herdr sessions start and support restart adoption without execution activity",
  async () => {
    expect(process.env.QE_HERDR_SESSION).toBeUndefined();
    expect(Number.isSafeInteger(iterations)).toBe(true);
    expect(iterations).toBeGreaterThanOrEqual(20);
    expect(iterations).toBeLessThanOrEqual(50);

    const parent = join(process.cwd(), ".pi", "tmp");
    await mkdir(parent, { recursive: true });
    const generations = new Set<string>();
    const records: Array<{
      workerId: string;
      dataRoot: string;
      sessionName: string;
      sessionIncarnation: string;
      serverGeneration: string;
      socketPaths: ReturnType<typeof herdrDefaultSocketPaths>;
    }> = [];
    let activeSession: string | null = null;

    try {
      for (let iteration = 0; iteration < iterations; iteration += 1) {
        const dataRoot = await mkdtemp(
          join(parent, `herdr-startup-live-${iteration}-`),
        );
        const workerId = `phase4-stress-${iteration}-${randomUUID()}-${"x".repeat(40)}`;
        expect(Buffer.byteLength(workerId)).toBeGreaterThan(80);
        expect(Buffer.byteLength(workerId)).toBeLessThanOrEqual(128);
        const sessionName = defaultHerdrSessionName(workerId);
        activeSession = sessionName;
        assertHerdrDefaultSocketPathSafe(sessionName);
        const socketPaths = herdrDefaultSocketPaths(sessionName);
        const provider = new LocalHerdrConnectionProvider(sessionName, {
          workerId,
          dataRoot,
        });
        const identity = await provider.ensureInfrastructure();
        generations.add(identity.serverGeneration);

        const connection = await provider.connect("pi");
        try {
          const snapshot = await connection.client.snapshot();
          expect(snapshot.workspaces).toHaveLength(1);
          expect(snapshot.panes).toHaveLength(1);
          expect(snapshot.agents).toEqual([]);
        } finally {
          connection.client.disconnect();
        }

        const restarted = new LocalHerdrConnectionProvider(sessionName, {
          workerId,
          dataRoot,
        });
        const adopted = await restarted.ensureInfrastructure();
        expect(adopted.sessionIncarnation).toBe(identity.sessionIncarnation);
        expect(adopted.serverGeneration).toBe(identity.serverGeneration);
        expect((await restarted.readiness("pi")).ready).toBe(true);

        await stopSession(sessionName);
        activeSession = null;
        records.push({
          workerId,
          dataRoot,
          sessionName,
          sessionIncarnation: identity.sessionIncarnation,
          serverGeneration: identity.serverGeneration,
          socketPaths,
        });
      }
      expect(generations.size).toBe(iterations);
      console.log(
        JSON.stringify({
          iterations,
          distinctWorkerStates: records.length,
          distinctServerGenerations: generations.size,
          executionAgents: 0,
          prompts: 0,
          finalState: "all_stopped",
          records,
        }),
      );
    } finally {
      if (activeSession)
        await stopSession(activeSession).catch(() => undefined);
    }
  },
  5 * 60_000,
);

async function stopSession(sessionName: string): Promise<void> {
  const child = Bun.spawn(["herdr", "session", "stop", "--json", sessionName], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (exitCode !== 0) {
    const detail = `${stdout}\n${stderr}`;
    if (!/not running|not found/iu.test(detail))
      throw new Error(`Could not stop disposable Herdr session: ${detail}`);
  }
}
