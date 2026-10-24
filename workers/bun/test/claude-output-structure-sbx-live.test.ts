import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
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
  sendMessage,
  waitForInit,
} from "../src/harnesses/claude-code/protocol.ts";
import { ManagedHarnessLifecycleStore } from "../src/harnesses/lifecycle-diagnostics.ts";

const session = "11111111-1111-4111-8111-111111111111";
const probe = "Quest Engineering fixed zero-inference initialization probe.";
// Fixture-only Unix control socket and blocking FIFO rendezvous. No sleeps,
// polling, native/vendor agents, credentials, or provider access.
const program = `import os,sys,json,socket,base64
server=socket.socket(socket.AF_UNIX,socket.SOCK_STREAM)
server.bind(sys.argv[1]);server.listen(1)
ready=os.open(sys.argv[2],os.O_WRONLY);os.write(ready,b'R');os.close(ready)
while True:
 c,_=server.accept()
 with c:
  req=json.loads(c.makefile('rb').readline());result={'ok':True}
  if req['op']=='read':
   remaining=req['size'];total=0
   while remaining:
    part=os.read(0,remaining)
    if not part:break
    remaining-=len(part);total+=len(part)
   result['bytesRead']=total
  elif req['op']=='emit':
   for part in req['parts']:os.write(req['fd'],base64.b64decode(part))
  c.sendall((json.dumps(result,separators=(',',':'))+'\\n').encode())
`;
const control = `import sys,socket,os
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
async function drain(source: StreamedProcess["stderr"], witness: Witness) {
  for await (const e of source)
    if (e.kind === "data") witness.add(e.data.byteLength);
}
async function files(root: string): Promise<string[]> {
  const result: string[] = [];
  for (const f of await readdir(root, { withFileTypes: true })) {
    const p = join(root, f.name);
    if (f.isDirectory()) result.push(...(await files(p)));
    else if (f.isFile()) result.push(p);
  }
  return result;
}

test.skipIf(process.env.QE_LIVE_SBX !== "1")(
  "provider-free physical pre-probe/output-census proof through the production transport and parser",
  async () => {
    const parent =
      process.env.QE_OUTPUT_STRUCTURE_PROOF_ROOT ??
      resolve(import.meta.dir, "../.pi/tmp");
    await mkdir(parent, { recursive: true });
    const root = await mkdtemp(join(parent, "output-structure-"));
    const created = new Set<string>(),
      operations: string[] = [];
    class FixtureClient extends CliSbxClient {
      override async create(r: SbxCreateRequest) {
        if (created.size || !r.name.startsWith("qe-run-output-structure-"))
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
        throw new Error("no stop");
      }
      override async remove(): Promise<void> {
        throw new Error("no remove");
      }
    }
    const runId = `output-structure-${crypto.randomUUID()}`,
      workerId = `output-proof-${crypto.randomUUID()}`;
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
          frozenBase: { kind: "fixture", value: "output-structure" },
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
    const db = new Database(join(root, "diagnostics.sqlite")),
      store = new ManagedHarnessLifecycleStore(db);
    const canaries = Array.from(
      { length: 8 },
      () => `synthetic-${crypto.randomUUID()}-${crypto.randomUUID()}`,
    );
    const foreignSession = crypto.randomUUID();
    canaries.push(foreignSession);
    const nonJsonCanary = canaries[5];
    if (!nonJsonCanary) throw new Error("fixture canary missing");
    const cases: unknown[] = [];
    let fixtureRef: unknown = null;
    try {
      const lease = await backend.ensure(spec);
      fixtureRef = lease.ref;
      await writeFile(
        join(root, "fixture.json"),
        JSON.stringify({ spec, ref: lease.ref, retained: true }, null, 2),
      );
      for (const mode of [
        "startup_198",
        "post_probe_198",
        "matching_init",
        "mismatching_init",
        "other_reviewed",
        "unknown_discriminators",
        "non_json",
        "fragmented",
        "canaries",
      ]) {
        const suffix = crypto.randomUUID().slice(0, 8),
          socket = `${lease.paths.temp}/output-${suffix}.sock`,
          fifo = `${lease.paths.temp}/output-${suffix}.fifo`;
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
        const parserGate = new Promise<void>((r) => {
          release = r;
        });
        const diag = store.begin({
          harnessKind: "fixture",
          harnessProtocol: "provider_free_output_structure_fixture",
          reservedNativeSessionId: session,
          environment: lease.ref,
        });
        if (!diag) throw new Error("fixture diagnostics unavailable");
        diag.bindProcess(target.handle);
        const frames = new AsyncFrameQueue();
        let ioCalls = 0,
          postDone!: () => void;
        const postSettled = new Promise<void>((r) => {
          postDone = r;
        });
        const observed: StreamedProcess = {
          ...target,
          stdout: (async function* () {
            for await (const e of target.stdout) {
              if (e.kind === "data") stdout.add(e.data.byteLength);
              if (mode === "non_json") await parserGate;
              yield e;
            }
          })(),
          observeIo: async () => {
            const number = ++ioCalls;
            try {
              return await target.observeIo();
            } finally {
              if (number === 2) setImmediate(postDone);
            }
          },
        };
        const stderrDrain = drain(target.stderr, stderr);
        observeClaudeProtocol(observed, frames, diag, () => true);
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
          const watcher = fd === 1 ? stdout : stderr,
            count = watcher.count + parts.reduce((n, p) => n + p.byteLength, 0);
          await command({
            op: "emit",
            fd,
            parts: parts.map((p) => Buffer.from(p).toString("base64")),
          });
          await watcher.until(count);
        };
        const ready = await lease.exec({
          executable: "/usr/bin/python3",
          args: ["-c", control, "ready", fifo],
          cwd: lease.paths.workspace,
          environment: {},
          timeoutMs: 30_000,
        });
        expect(ready.exitCode).toBe(0);
        const encode = (value: unknown) =>
          new TextEncoder().encode(`${JSON.stringify(value)}\n`);
        const bytes198 = new TextEncoder().encode(
          `${JSON.stringify({ type: "keep_alive" }).padEnd(197, " ")}\n`,
        );
        if (mode === "startup_198") await emit(1, [bytes198]);
        const init = {
          type: "system",
          subtype: "init",
          session_id: mode === "mismatching_init" ? foreignSession : session,
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
          unknownNativeField: canaries[0],
        };
        const fragmented = encode({
          type: "system",
          subtype: "status",
          status: null,
          ignored: `λ${canaries[1]}`,
        }).subarray(0, -1);
        // Fixture-only rendezvous: actual relay ACK, then controlled child read/output,
        // then return the real receipt. This makes windows deterministic without
        // changing production code, faking counters, or waiting for activity there.
        observed.write = async (data) => {
          const receipt = await target.write(data);
          expect(receipt).toMatchObject({
            certainty: "acknowledged",
            byteLength: 301,
          });
          expect(
            (await command({ op: "read", size: data.byteLength })).bytesRead,
          ).toBe(301);
          if (mode === "post_probe_198") await emit(1, [bytes198]);
          if (mode === "matching_init" || mode === "mismatching_init")
            await emit(1, [encode(init)]);
          if (mode === "other_reviewed")
            await emit(1, [
              encode({
                type: "system",
                subtype: "status",
                status: null,
                session_id: foreignSession,
                message: canaries[2],
              }),
            ]);
          if (mode === "unknown_discriminators")
            await emit(1, [
              encode({
                type: canaries[3],
                subtype: canaries[4],
                session_id: foreignSession,
              }),
              encode({
                type: "system",
                subtype: canaries[4],
                payload: canaries[5],
              }),
            ]);
          if (mode === "non_json")
            await emit(1, [
              new TextEncoder().encode(`${nonJsonCanary.padEnd(197, " ")}\n`),
            ]);
          if (mode === "fragmented")
            await emit(
              1,
              Array.from(fragmented, (byte) => Uint8Array.of(byte)),
            );
          if (mode === "canaries") {
            await emit(1, [
              encode({
                type: "control_response",
                session_id: foreignSession,
                response: {
                  subtype: canaries[0],
                  error: canaries[1],
                  applied: { model: canaries[2], effort: canaries[3] },
                  tools: canaries[4],
                  plugins: canaries[5],
                  cwd: canaries[6],
                  auth_status: canaries[7],
                  apiKeySource: canaries[0],
                },
              }),
            ]);
            await emit(2, [new TextEncoder().encode(canaries[7])]);
          }
          return receipt;
        };
        await sendMessage(observed, session, probe, false, diag);
        await postSettled;
        const pre = diag
            .snapshot()
            .ioObservations.find((x) => x.checkpoint === "before_probe_write"),
          post = diag
            .snapshot()
            .ioObservations.find(
              (x) => x.checkpoint === "probe_write_acknowledged",
            );
        expect(pre).toMatchObject({
          status: "available",
          sample: {
            stdoutBytes: mode === "startup_198" ? 198 : 0,
            stderrBytes: 0,
            stdin: { status: "observed", unreadBytes: 0 },
          },
        });
        expect(post).toMatchObject({
          status: "available",
          sample: {
            stdoutBytes: stdout.count,
            stderrBytes: stderr.count,
            stdin: { status: "observed", unreadBytes: 0 },
          },
        });
        expect(diag.snapshot().probeIoDelta).toEqual({
          status: "available",
          stdoutBytes: stdout.count - (mode === "startup_198" ? 198 : 0),
          stderrBytes: stderr.count,
        });
        if (mode === "startup_198" || mode === "post_probe_198")
          expect(post).toMatchObject({ sample: { stdoutBytes: 198 } });
        if (mode === "fragmented") {
          expect(diag.snapshot().outputCensus.counters.totalOutputUnits).toBe(
            0,
          );
          expect(diag.snapshot().outputCensus.counters.nonJsonUnits).toBe(0);
          await emit(1, [Uint8Array.of(10)]);
        }
        if (mode === "non_json") {
          release();
          await expect(waitForInit(frames, 1_000)).rejects.toThrow();
        } else if (mode === "matching_init" || mode === "mismatching_init") {
          const frame = await waitForInit(frames, 1_000);
          if (mode === "matching_init") {
            attestClaudeInit(frame, {
              sessionId: session,
              cwd: lease.paths.workspace,
              model: CLAUDE_CODE_MODEL,
            });
            diag.record("protocol_frame_validated", target.handle);
          } else {
            expect(() =>
              attestClaudeInit(frame, {
                sessionId: session,
                cwd: lease.paths.workspace,
                model: CLAUDE_CODE_MODEL,
              }),
            ).toThrow();
            diag.record("protocol_frame_rejected", target.handle);
          }
        } else {
          await expect(waitForInit(frames, 10)).rejects.toThrow("timed out");
          expect(diag.snapshot().outputCensus.frameValidated).toBe(false);
        }
        const census = diag.snapshot().outputCensus;
        if (mode === "matching_init")
          expect(census).toMatchObject({
            frameValidated: true,
            counters: {
              systemInitCandidateCount: 1,
              sessionIdPresentCount: 1,
              reservedSessionMatchCount: 1,
              reservedSessionMismatchCount: 0,
            },
          });
        if (mode === "mismatching_init")
          expect(census).toMatchObject({
            frameValidated: false,
            counters: {
              systemInitCandidateCount: 1,
              sessionIdPresentCount: 1,
              reservedSessionMatchCount: 0,
              reservedSessionMismatchCount: 1,
            },
          });
        if (mode === "other_reviewed" || mode === "fragmented")
          expect(census.categories["system/status"]?.count).toBe(1);
        if (mode === "unknown_discriminators")
          expect(census.counters.unknownDiscriminatorUnits).toBe(2);
        if (mode === "non_json")
          expect(census.counters).toMatchObject({
            nonJsonUnits: 1,
            nonJsonDecodedUtf8Bytes: 198,
            validJsonUnits: 0,
          });
        if (mode === "canaries")
          expect(census.categories.control_response?.count).toBe(1);
        if (mode !== "non_json")
          expect(await target.cancel()).toMatchObject({
            certainty: "acknowledged",
          });
        const exit = await target.exit;
        await stderrDrain;
        cases.push({
          mode,
          preparationId: diag.preparationId,
          pre,
          post,
          delta: diag.snapshot().probeIoDelta,
          census: diag.snapshot().outputCensus,
          stdoutBytes: stdout.count,
          stderrBytes: stderr.count,
          exit,
        });
        expect(diag.snapshot().modExecution).toBe("unestablished");
      }
    } finally {
      await backend.close();
      db.close();
      const proof = {
        cases,
        fixtureRef,
        operations,
        fixtureCheckpointRendezvous: true,
        completedCases: cases.length,
        canaryCount: canaries.length,
        canaryOccurrences: 0,
        canaryPayloadHashes: 0,
        ClaudeExecutions: 0,
        providerTraffic: 0,
        credentials: 0,
        inference: 0,
        ProductRuns: 0,
        retainedGuestExecs: 0,
        retainedMutations: 0,
        cleanup: "retained",
      };
      await writeFile(join(root, "proof.json"), JSON.stringify(proof, null, 2));
      let occurrences = 0;
      const scanned = await files(root);
      for (const file of scanned) {
        const bytes = await readFile(file);
        for (const canary of canaries)
          if (bytes.includes(Buffer.from(canary))) occurrences++;
      }
      proof.canaryOccurrences = occurrences;
      await writeFile(
        join(root, "proof.json"),
        JSON.stringify(
          { ...proof, durableFilesScanned: scanned.length },
          null,
          2,
        ),
      );
      expect(occurrences).toBe(0);
    }
  },
  600_000,
);
