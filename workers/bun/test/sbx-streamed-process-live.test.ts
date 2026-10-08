import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { cleanupExecutionEnvironment } from "../src/execution-environment/run-cleanup.ts";
import { SbxExecutionEnvironmentBackend } from "../src/execution-environment/sbx-backend.ts";
import type {
  EnvironmentRef,
  StreamedProcess,
  StreamedProcessInfrastructureEvent,
  StreamedProcessStreamEvent,
} from "../src/execution-environment/types.ts";
import { sbxSpec } from "./sbx-support.ts";

const live = process.env.QE_LIVE_SBX === "1";
const guestProgram = [
  "import json,os,sys",
  "def emit(stream,value):",
  " stream.write((json.dumps(value,separators=(',',':'))+'\\n').encode()); stream.flush()",
  "emit(sys.stdout.buffer,{'event':'started','cwd':os.getcwd(),'proof':os.environ.get('QE_STREAM_PROOF')})",
  "emit(sys.stderr.buffer,{'event':'diagnostic','stream':'stderr'})",
  "for line in sys.stdin.buffer:",
  " value=line.rstrip(b'\\n')",
  " emit(sys.stdout.buffer,{'event':'ack','hex':value.hex()})",
  " if value==b'exit': break",
].join("\n");

// Zero-provider physical proof. It uses only the shell SBX profile and local
// deterministic guest Python; there is no harness, terminal session, or network call.
test.skipIf(!live)(
  "live disposable SBX proves run-owned bidirectional streamed processes and restart truth",
  async () => {
    const parent = join(process.cwd(), ".pi", "tmp");
    await mkdir(parent, { recursive: true });
    const root = await mkdtemp(join(parent, "sbx-streamed-live-"));
    const events: StreamedProcessInfrastructureEvent[] = [];
    const createBackend = () =>
      new SbxExecutionEnvironmentBackend({
        workerId: "worker-sbx-test",
        dataRoot: root,
        reconciliationPollMs: 500,
        reconciliationAttempts: 120,
        onStreamedProcessEvent: (event) => events.push(event),
      });
    let backend = createBackend();
    let ref: EnvironmentRef | null = null;
    try {
      const environmentSpec = sbxSpec(`streamed-live-${Date.now()}`);
      const lease = await backend.ensure(environmentSpec);
      ref = lease.ref;
      expect(lease.capabilities).toContainEqual(
        expect.objectContaining({
          kind: "process.streamed",
          mode: "attached_only",
        }),
      );

      const process = await lease.spawnStreamed({
        executable: "/usr/bin/python3",
        args: ["-u", "-c", guestProgram],
        cwd: lease.paths.workspace,
        environment: { QE_STREAM_PROOF: "inside-sbx" },
      });
      expect(process.handle.environment).toEqual(lease.ref);
      expect(process.handle.observedExecutable).toMatch(
        /^\/usr\/bin\/python3(?:\.\d+)?$/,
      );
      const stdout = collect(process.stdout);
      const stderr = collect(process.stderr);
      expect(
        await process.write(new Uint8Array([0xff, 0x00, 0x0a])),
      ).toMatchObject({ certainty: "acknowledged", byteLength: 3 });
      expect(
        await process.write(new TextEncoder().encode("exit\n")),
      ).toMatchObject({ certainty: "acknowledged", byteLength: 5 });
      expect(await process.exit).toEqual({ kind: "exited", exitCode: 0 });
      const stdoutBytes = dataBytes(await stdout);
      const stderrBytes = dataBytes(await stderr);
      const stdoutText = new TextDecoder().decode(stdoutBytes);
      const stderrText = new TextDecoder().decode(stderrBytes);
      expect(stdoutText).toContain(
        `"event":"started","cwd":"${lease.paths.workspace}","proof":"inside-sbx"`,
      );
      expect(stdoutText).toContain('"event":"ack","hex":"ff00"');
      expect(stdoutText).toContain('"event":"ack","hex":"65786974"');
      expect(stderrText).toContain('"event":"diagnostic","stream":"stderr"');

      const cancelled = await lease.spawnStreamed({
        executable: "/usr/bin/python3",
        args: ["-u", "-c", guestProgram],
        cwd: lease.paths.workspace,
        environment: { QE_STREAM_PROOF: "cancel-proof" },
      });
      const cancelledStdout = collect(cancelled.stdout);
      const cancelledStderr = collect(cancelled.stderr);
      expect(await cancelled.cancel()).toMatchObject({
        certainty: "acknowledged",
      });
      expect(await cancelled.exit).toEqual({
        kind: "signaled",
        signal: "SIGTERM",
      });
      await Promise.all([cancelledStdout, cancelledStderr]);

      const restartSubject = await lease.spawnStreamed({
        executable: "/usr/bin/python3",
        args: ["-u", "-c", guestProgram],
        cwd: lease.paths.workspace,
        environment: { QE_STREAM_PROOF: "restart-proof" },
      });
      const restartHandle = structuredClone(restartSubject.handle);
      const restartStdout = collect(restartSubject.stdout);
      const restartStderr = collect(restartSubject.stderr);
      await backend.close();
      await Promise.all([restartStdout, restartStderr]);

      backend = createBackend();
      const recovered = await backend.recover(ref, environmentSpec);
      const restart = await recovered.reconcileStreamedProcess(restartHandle);
      expect(restart).toMatchObject({
        process: "gone",
        streamAttachment: "unavailable",
        streamRecovery: "not_recoverable",
      });

      const teardownSubject = await recovered.spawnStreamed({
        executable: "/usr/bin/python3",
        args: ["-u", "-c", guestProgram],
        cwd: recovered.paths.workspace,
        environment: { QE_STREAM_PROOF: "run-teardown-proof" },
      });
      const teardownStdout = collect(teardownSubject.stdout);
      const teardownStderr = collect(teardownSubject.stderr);
      const cleanup = await convergeCleanup(backend, ref);
      expect(cleanup).toBe("removed");
      expect(["signaled", "observation_unavailable"]).toContain(
        (await teardownSubject.exit).kind,
      );
      await Promise.all([teardownStdout, teardownStderr]);
      expect(
        events.some(
          (event) =>
            event.event === "process_cancelled" &&
            event.processGeneration ===
              teardownSubject.handle.processGeneration,
        ),
      ).toBe(true);
      expect(
        await backend.currentEnvironment(environmentSpec.runId),
      ).toBeNull();
      ref = null;
      expect(events.map((event) => event.event)).toEqual(
        expect.arrayContaining([
          "streamed_process_spawn_requested",
          "streamed_process_spawned",
          "stream_connected",
          "stdin_write_requested",
          "stdin_write_acknowledged",
          "process_cancel_requested",
          "process_cancelled",
          "process_exit_observed",
        ]),
      );
    } finally {
      if (ref) await convergeCleanup(backend, ref).catch(() => undefined);
      await backend.close();
      await rm(root, { recursive: true, force: true });
    }
  },
  12 * 60_000,
);

async function collect(
  stream: StreamedProcess["stdout"],
): Promise<StreamedProcessStreamEvent[]> {
  const events: StreamedProcessStreamEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

function dataBytes(events: readonly StreamedProcessStreamEvent[]): Uint8Array {
  const chunks = events.flatMap((event) =>
    event.kind === "data" ? [event.data] : [],
  );
  const result = new Uint8Array(
    chunks.reduce((length, chunk) => length + chunk.byteLength, 0),
  );
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

async function convergeCleanup(
  backend: SbxExecutionEnvironmentBackend,
  ref: EnvironmentRef,
): Promise<string> {
  let outcome = await cleanupExecutionEnvironment(backend, ref);
  for (
    let attempt = 0;
    outcome.state !== "removed" && attempt < 120;
    attempt += 1
  ) {
    await Bun.sleep(500);
    outcome = await cleanupExecutionEnvironment(backend, ref);
  }
  return outcome.state;
}
