import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { SbxExecutionEnvironmentBackend } from "../src/execution-environment/sbx-backend.ts";
import {
  CliSbxClient,
  type SbxCreateRequest,
  type SbxExecOptions,
} from "../src/execution-environment/sbx-client.ts";
import {
  SBX_CLAUDE_BROKER_RUN_PROFILE as profile,
  SBX_DISPOSABLE_RESOURCE_POLICY,
} from "../src/execution-environment/sbx-profile.ts";
import type {
  EnvironmentCommand,
  RunEnvironmentSpec,
  StreamedProcess,
} from "../src/execution-environment/types.ts";
import {
  attestClaudeInit,
  CLAUDE_CODE_MODEL,
  CLAUDE_CODE_PLUGIN_PATH,
  CLAUDE_CODE_TOOLS,
} from "../src/harnesses/claude-code/adapter.ts";
import {
  AsyncFrameQueue,
  observeClaudeProtocol,
  waitForInit,
} from "../src/harnesses/claude-code/protocol.ts";
import {
  type LifecycleIoCheckpoint,
  type ManagedHarnessLifecycle,
  ManagedHarnessLifecycleStore,
} from "../src/harnesses/lifecycle-diagnostics.ts";

const session = "11111111-1111-4111-8111-111111111111";
// Dedicated fixture control is a local Unix socket, not target stdio. Readiness
// uses a blocking FIFO rendezvous; there are no sleeps or monitoring loops.
const program = `import os,sys,json,socket,base64
server=socket.socket(socket.AF_UNIX,socket.SOCK_STREAM)
server.bind(sys.argv[1]);server.listen(1)
ready=os.open(sys.argv[2],os.O_WRONLY);os.write(ready,b'R');os.close(ready)
while True:
 c,_=server.accept()
 with c:
  f=c.makefile('rb');req=json.loads(f.readline())
  result={'ok':True}
  if req['op']=='read':
   remaining=req['size'];total=0
   while remaining:
    part=os.read(0,remaining)
    if not part: break
    remaining-=len(part);total+=len(part)
   result['bytesRead']=total
  elif req['op']=='emit':
   for part in req['parts']: os.write(req['fd'],base64.b64decode(part))
  c.sendall((json.dumps(result,separators=(',',':'))+'\\n').encode())
`;
const control = `import sys,socket,json,os
if sys.argv[1]=='ready':
 fd=os.open(sys.argv[2],os.O_RDONLY);assert os.read(fd,1)==b'R';os.close(fd);print('{"ok":true}')
else:
 s=socket.socket(socket.AF_UNIX,socket.SOCK_STREAM);s.connect(sys.argv[2]);s.sendall((sys.argv[3]+'\\n').encode());print(s.makefile().readline(),end='');s.close()
`;

class Witness {
  count = 0;
  private waiters: Array<{ size: number; done(): void }> = [];
  add(size: number) {
    this.count += size;
    for (const w of [...this.waiters])
      if (this.count >= w.size) {
        this.waiters.splice(this.waiters.indexOf(w), 1);
        w.done();
      }
  }
  until(size: number): Promise<void> {
    return this.count >= size
      ? Promise.resolve()
      : new Promise((done) => this.waiters.push({ size, done }));
  }
}
async function* witness(source: StreamedProcess["stdout"], value: Witness) {
  for await (const event of source) {
    if (event.kind === "data") value.add(event.data.byteLength);
    yield event;
  }
}
async function drain(source: StreamedProcess["stdout"]) {
  for await (const _event of source) {
    /* Never store bytes. */
  }
}
async function capture(
  diag: ManagedHarnessLifecycle,
  process: StreamedProcess,
  checkpoint: LifecycleIoCheckpoint,
) {
  let done!: () => void;
  const settled = new Promise<void>((resolve) => {
    done = resolve;
  });
  diag.captureIo(checkpoint, {
    ...process,
    observeIo: async () => {
      try {
        return await process.observeIo();
      } finally {
        setImmediate(done);
      } // Fixture completion notification, not a diagnostic poll.
    },
  });
  await settled;
  return diag
    .snapshot()
    .ioObservations.find((v) => v.checkpoint === checkpoint);
}

test.skipIf(process.env.QE_LIVE_SBX !== "1")(
  "provider-free physical I/O proof through real spawnStreamed, relay, and Linux pipes",
  async () => {
    const parent =
      process.env.QE_IO_PROOF_ROOT ?? resolve(import.meta.dir, "../.pi/tmp");
    await mkdir(parent, { recursive: true });
    const root = await mkdtemp(join(parent, "content-free-io-"));
    const created = new Set<string>();
    const operations: string[] = [];
    class FixtureClient extends CliSbxClient {
      override async create(r: SbxCreateRequest) {
        if (created.size || !r.name.startsWith("qe-run-io-content-free-"))
          throw new Error("fixture gate");
        await super.create(r);
        created.add(r.name);
        operations.push("fixture_create");
      }
      override async exec(
        n: string,
        c: EnvironmentCommand,
        o: SbxExecOptions = {},
      ) {
        if (!created.has(n) || c.executable.includes("claude"))
          throw new Error("retained/native exec prohibited");
        operations.push("fixture_exec");
        return super.exec(n, c, o);
      }
      override streamLauncherArgs(n: string, c: EnvironmentCommand) {
        if (!created.has(n) || c.executable !== "/usr/bin/python3")
          throw new Error("stream gate");
        operations.push("fixture_stream");
        return super.streamLauncherArgs(n, c);
      }
      override async copyTo(n: string, h: string, g: string) {
        if (!created.has(n)) throw new Error("copy gate");
        return super.copyTo(n, h, g);
      }
      override async denyNetwork(n: string, r: readonly string[]) {
        if (!created.has(n)) throw new Error("policy gate");
        return super.denyNetwork(n, r);
      }
      override async setDynamicSecret(): Promise<void> {
        throw new Error("credentials prohibited");
      }
      override async removeDynamicSecret(): Promise<void> {
        throw new Error("credentials prohibited");
      }
      override async stop(): Promise<void> {
        throw new Error("no retained or fixture stop");
      }
      override async remove(): Promise<void> {
        throw new Error("no retained or fixture remove");
      }
    }
    const workerId = `io-proof-${crypto.randomUUID()}`;
    const runId = `io-content-free-${crypto.randomUUID()}`;
    const spec: RunEnvironmentSpec = {
      workerId,
      owner: { kind: "run", runId },
      layout: { kind: "run" },
      workspace: {
        workspaceId: `fixture-${crypto.randomUUID()}`,
        access: "none",
        materialization: {
          kind: "disposable_fixture",
          sourceIdentity: runId,
          frozenBase: { kind: "fixture", value: "content-free-io" },
        },
      },
      profile: profile.identity,
      resourcePolicy: SBX_DISPOSABLE_RESOURCE_POLICY.identity,
      networkRequirements: [],
      credentialGrants: [],
      controlChannels: [],
      requiredCapabilities: [
        { kind: "credentials", mode: "none" },
        { kind: "network_policy", mode: "deny_all" },
      ],
    };
    const backend = new SbxExecutionEnvironmentBackend({
      workerId,
      dataRoot: join(root, "worker"),
      client: new FixtureClient(),
      executionProfile: profile,
      onStreamedProcessEvent: () => undefined,
    });
    const dbPath = join(root, "diagnostics.sqlite");
    const db = new Database(dbPath);
    const store = new ManagedHarnessLifecycleStore(db);
    const cases: unknown[] = [];
    const canaries = Array.from(
      { length: 3 },
      () => `synthetic-${crypto.randomUUID()}-${crypto.randomUUID()}`,
    );
    let fixtureRef: unknown = null;
    try {
      const lease = await backend.ensure(spec);
      fixtureRef = lease.ref;
      await writeFile(
        join(root, "fixture.json"),
        JSON.stringify({ spec, ref: lease.ref, retained: true }, null, 2),
      );
      for (const mode of [
        "no_read",
        "full_read",
        "partial_read",
        "stdout_17",
        "stderr_23",
        "fragmented_totals",
        "invalid_protocol",
        "valid_attestation",
        "canaries",
        "closed_stdin",
      ]) {
        const suffix = crypto.randomUUID().slice(0, 8);
        const socket = `${lease.paths.temp}/io-${suffix}.sock`;
        const fifo = `${lease.paths.temp}/io-${suffix}.fifo`;
        const made = await lease.exec({
          executable: "/usr/bin/python3",
          args: ["-c", "import os,sys;os.mkfifo(sys.argv[1],0o600)", fifo],
          cwd: lease.paths.workspace,
          environment: {},
        });
        expect(made.exitCode).toBe(0);
        const target = await lease.spawnStreamed({
          executable: "/usr/bin/python3",
          args: ["-u", "-c", program, socket, fifo],
          cwd: lease.paths.workspace,
          environment: {},
        });
        const stdout = new Witness(),
          stderr = new Witness();
        let release!: () => void;
        const parserGate = new Promise<void>((resolve) => {
          release = resolve;
        });
        const protocol =
          mode === "invalid_protocol" || mode === "valid_attestation";
        const diag = store.begin({
          harnessKind: "fixture",
          harnessProtocol: "provider_free_io_fixture",
          reservedNativeSessionId: session,
          environment: lease.ref,
        });
        if (!diag) throw new Error("fixture diagnostics unavailable");
        diag.bindProcess(target.handle);
        const frames = new AsyncFrameQueue();
        const observed = {
          ...target,
          stdout: (async function* () {
            for await (const event of witness(target.stdout, stdout)) {
              if (protocol) await parserGate;
              yield event;
            }
          })(),
        };
        const stderrDrain = drain(witness(target.stderr, stderr));
        const stdoutDrain = protocol ? null : drain(observed.stdout);
        const parserDiag = protocol
          ? store.begin({
              harnessKind: "fixture",
              harnessProtocol: "parser_fixture",
              reservedNativeSessionId: session,
              environment: lease.ref,
            })
          : null;
        parserDiag?.bindProcess(target.handle);
        if (protocol)
          observeClaudeProtocol(observed, frames, parserDiag, () => true);
        const command = async (request: unknown) => {
          const result = await lease.exec({
            executable: "/usr/bin/python3",
            args: ["-c", control, "command", socket, JSON.stringify(request)],
            cwd: lease.paths.workspace,
            environment: {},
            timeoutMs: 30_000,
          });
          expect(result.exitCode).toBe(0);
          return JSON.parse(result.stdout) as {
            ok: boolean;
            bytesRead?: number;
          };
        };
        const emit = async (fd: number, parts: Uint8Array[]) => {
          const watcher = fd === 1 ? stdout : stderr;
          const expected =
            watcher.count + parts.reduce((n, p) => n + p.byteLength, 0);
          await command({
            op: "emit",
            fd,
            parts: parts.map((p) => Buffer.from(p).toString("base64")),
          });
          await watcher.until(expected);
        };
        const ready = await lease.exec({
          executable: "/usr/bin/python3",
          args: ["-c", control, "ready", fifo],
          cwd: lease.paths.workspace,
          environment: {},
          timeoutMs: 30_000,
        });
        expect(ready.exitCode).toBe(0);
        const input =
          mode === "canaries"
            ? new TextEncoder().encode(canaries[0])
            : new Uint8Array(97).fill(65);
        expect(await target.write(input)).toMatchObject({
          certainty: "acknowledged",
          byteLength: input.byteLength,
        });
        diag.record("probe_write_acknowledged", target.handle);
        const initial = await capture(diag, target, "probe_write_acknowledged");
        expect(initial).toMatchObject({
          status: "available",
          sample: {
            stdin: { status: "observed", unreadBytes: input.byteLength },
            stdoutBytes: 0,
            stderrBytes: 0,
            terminal: "not_observed",
          },
        });
        let expectedUnread = input.byteLength;
        let expectedStdout = 0,
          expectedStderr = 0;
        if (mode === "full_read" || mode === "partial_read") {
          const read = mode === "full_read" ? input.byteLength : 31;
          expect((await command({ op: "read", size: read })).bytesRead).toBe(
            read,
          );
          expectedUnread -= read;
        }
        if (mode === "stdout_17") {
          await emit(1, [new Uint8Array(17).fill(66)]);
          expectedStdout = 17;
        }
        if (mode === "stderr_23") {
          await emit(2, [new Uint8Array(23).fill(67)]);
          expectedStderr = 23;
        }
        if (mode === "fragmented_totals") {
          await emit(
            1,
            [2, 5, 1, 9].map((n) => new Uint8Array(n).fill(68)),
          );
          await emit(
            2,
            [3, 7, 1].map((n) => new Uint8Array(n).fill(69)),
          );
          expectedStdout = 17;
          expectedStderr = 11;
        }
        if (mode === "canaries") {
          const out = new TextEncoder().encode(canaries[1]),
            err = new TextEncoder().encode(canaries[2]);
          await emit(1, [out]);
          await emit(2, [err]);
          expectedStdout = out.byteLength;
          expectedStderr = err.byteLength;
        }
        if (protocol) {
          const init = {
            type: "system",
            subtype: "init",
            session_id: session,
            claude_code_version: "2.1.292",
            apiKeySource: "oauth",
            cwd: lease.paths.workspace,
            model: CLAUDE_CODE_MODEL,
            permissionMode: "dontAsk",
            tools: [...CLAUDE_CODE_TOOLS],
            mcp_servers: [],
            skills: [],
            agents: [],
            plugins: [
              { name: "qe-account-cell", path: CLAUDE_CODE_PLUGIN_PATH },
              { name: "cc-plugin-sec-default", path: "builtin" },
            ],
            extra_context: canaries[1],
          };
          const bytes = new TextEncoder().encode(
            mode === "invalid_protocol"
              ? `${canaries[1]} invalid JSON\n`
              : `${JSON.stringify(init)}\n`,
          );
          await emit(1, [bytes]);
          expectedStdout = bytes.byteLength;
        }
        if (mode === "closed_stdin") await target.closeStdin();
        const snapshot = await target.observeIo();
        expect(snapshot).toMatchObject({
          status: "available",
          sample: { stdoutBytes: expectedStdout, stderrBytes: expectedStderr },
        });
        if (mode === "closed_stdin")
          expect(snapshot).toMatchObject({
            sample: { stdin: { status: "unavailable", reason: "closed" } },
          });
        else
          expect(snapshot).toMatchObject({
            sample: {
              stdin: { status: "observed", unreadBytes: expectedUnread },
            },
          });
        // Persist the second existing checkpoint before releasing a deliberately bad parser.
        diag.record("attestation_timeout_fired", target.handle);
        const second = await capture(diag, target, "attestation_timeout_fired");
        if (protocol) {
          // A separate observer owns actual init milestones; timeout evidence above stays frozen.
          release();
          if (mode === "invalid_protocol") {
            await expect(waitForInit(frames, 1_000)).rejects.toThrow();
            expect(frames.cursor).toBe(0);
            expect(
              parserDiag?.snapshot().observations.protocol_frame_observed,
            ).toBe("not_observed");
          } else {
            const init = await waitForInit(frames, 1_000);
            attestClaudeInit(init, {
              sessionId: session,
              cwd: lease.paths.workspace,
              model: CLAUDE_CODE_MODEL,
            });
            parserDiag?.record("protocol_frame_validated", target.handle);
            expect(
              parserDiag?.snapshot().observations.protocol_frame_observed,
            ).toBe("observed");
            expect(
              parserDiag?.snapshot().observations.protocol_frame_validated,
            ).toBe("observed");
          }
        }
        // Invalid JSON already exercises the unchanged parser's normal disconnect behavior.
        if (mode !== "invalid_protocol")
          expect(await target.cancel()).toMatchObject({
            certainty: "acknowledged",
          });
        const exit = await target.exit;
        await Promise.all([stdoutDrain, stderrDrain]);
        const final =
          mode === "invalid_protocol"
            ? null
            : await capture(diag, target, "process_exit_observed");
        if (final?.status === "available") {
          expect(final).toMatchObject({
            status: "available",
            sample: {
              terminal: "observed",
              stdoutBytes: expectedStdout,
              stderrBytes: expectedStderr,
            },
          });
          if (mode !== "closed_stdin")
            expect(final).toMatchObject({
              beforeCancellation: {
                stdin: { status: "observed", unreadBytes: expectedUnread },
              },
            });
        }
        // A lost final diagnostic is not a failed cancellation/terminal exit.
        if (mode !== "invalid_protocol") expect(exit.kind).toBe("signaled");
        cases.push({
          mode,
          preparationId: diag.preparationId,
          initial,
          second,
          final,
          exit,
          parserFrames: frames.cursor,
          parserObservations: parserDiag?.snapshot().observations ?? null,
          stdoutBytes: expectedStdout,
          stderrBytes: expectedStderr,
        });
      }
      expect(
        cases.some(
          (row) =>
            (row as { final?: { status: string } }).final?.status ===
            "available",
        ),
      ).toBe(true);
      const persisted = JSON.stringify(
        db.query("SELECT * FROM managed_harness_lifecycle").all(),
      );
      expect(canaries.some((s) => persisted.includes(s))).toBe(false);
      expect(canaries.some((s) => JSON.stringify(cases).includes(s))).toBe(
        false,
      );
    } finally {
      await backend.close();
      db.close();
      const persistedBytes = await readFile(dbPath);
      const canaryOccurrences = canaries.reduce(
        (n, s) => n + Number(persistedBytes.includes(Buffer.from(s))),
        0,
      );
      await writeFile(
        join(root, "proof.json"),
        JSON.stringify(
          {
            cases,
            fixtureRef,
            operations,
            canaryOccurrences,
            canaryPayloadHashes: 0,
            providerTraffic: 0,
            ClaudeExecutions: 0,
            credentials: 0,
            inference: 0,
            retainedGuestExecs: 0,
            retainedMutations: 0,
            fixtureRetained: true,
          },
          null,
          2,
        ),
      );
      expect(canaryOccurrences).toBe(0);
    }
  },
  12 * 60_000,
);
