import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { cleanupExecutionEnvironment } from "../src/execution-environment/run-cleanup.ts";
import { SbxExecutionEnvironmentBackend } from "../src/execution-environment/sbx-backend.ts";
import type {
  EnvironmentRef,
  StreamedProcessInfrastructureEvent,
} from "../src/execution-environment/types.ts";
import {
  attestClaudeInit,
  CLAUDE_CODE_EFFORT,
  CLAUDE_CODE_MODEL,
  CLAUDE_CODE_PLUGIN_PATH,
  CLAUDE_CODE_TOOLS,
} from "../src/harnesses/claude-code/adapter.ts";
import {
  AsyncFrameQueue,
  cancelClaudePreparation,
  observeClaudeProtocol,
  sendMessage,
  waitForInit,
} from "../src/harnesses/claude-code/protocol.ts";
import { ManagedHarnessLifecycleStore } from "../src/harnesses/lifecycle-diagnostics.ts";
import { sbxSpec } from "./sbx-support.ts";

const live = process.env.QE_LIVE_SBX === "1";
const session = "11111111-1111-4111-8111-111111111111";
const probe = "Quest Engineering fixed zero-inference initialization probe.";
const canary = "NATIVE_OUTPUT_PROMPT_AUTH_URL_CODE_CANARY";
const python = [
  "import os,sys,json,base64,time,re",
  "mode=os.environ['QE_MODE'];frame=base64.b64decode(os.environ['QE_FRAME'])",
  "line=sys.stdin.buffer.readline(); value=json.loads(line)",
  "assert len(line)==301 and line.endswith(b'\\n')",
  "assert line==(json.dumps(value,separators=(',',':'))+'\\n').encode()",
  "assert value['shouldQuery'] is False and value['isSynthetic'] is True and value['client_composed'] is True",
  "assert value['session_id']=='11111111-1111-4111-8111-111111111111'",
  "assert value['message']=={'role':'user','content':'Quest Engineering fixed zero-inference initialization probe.'}",
  "assert re.fullmatch('[0-9a-f-]{36}',value['uuid'])",
  "if mode=='exit': sys.exit(7)",
  "if mode=='ignored_mod_status':",
  " os.write(1,(json.dumps({'type':'system','subtype':'ui_status','plugin':'qe-account-cell','text':'mod_ready'})+'\\n').encode())",
  "if mode in ['healthy','fragmented','wrong_session']:",
  " if mode=='fragmented':",
  "  os.write(1,frame[:17])",
  "  while not os.path.exists(os.environ['QE_GATE']): time.sleep(0.002)",
  "  os.write(1,frame[17:])",
  " else: os.write(1,frame)",
  "while True: time.sleep(60)",
].join("\n");

test.skipIf(!live)(
  "physical provider-free lifecycle: real spawn/stdio/parser/validator/timeout/cancel and stopped evidence",
  async () => {
    const parent =
      process.env.QE_LIFECYCLE_PROOF_ROOT ??
      resolve(import.meta.dir, "../.pi/tmp");
    await mkdir(parent, { recursive: true });
    const root = await mkdtemp(join(parent, "lifecycle-proof-"));
    const infra: StreamedProcessInfrastructureEvent[] = [];
    const backend = new SbxExecutionEnvironmentBackend({
      workerId: "lifecycle-provider-free-proof",
      dataRoot: join(root, "worker"),
      reconciliationPollMs: 500,
      reconciliationAttempts: 120,
      onStreamedProcessEvent: (event) => infra.push(event),
    });
    const dbPath = join(root, "evidence.sqlite");
    let db = new Database(dbPath);
    let store = new ManagedHarnessLifecycleStore(db);
    let ref: EnvironmentRef | null = null;
    const cases: Array<{
      mode: string;
      preparationId: string;
      elapsedMs: number;
    }> = [];
    try {
      const lease = await backend.ensure(
        sbxSpec(
          `lifecycle-${crypto.randomUUID()}`,
          "lifecycle-provider-free-proof",
        ),
      );
      ref = lease.ref;
      for (const mode of [
        "healthy",
        "fragmented",
        "silent",
        "ignored_mod_status",
        "exit",
        "wrong_session",
      ]) {
        const diag = store.begin({
          harnessKind: "claude_code",
          harnessProtocol: "qe_claude_account_cell_v1",
          reservedNativeSessionId: session,
          environment: ref,
        });
        if (!diag) throw new Error("fixture diagnostics unavailable");
        const init = {
          type: "system",
          subtype: "init",
          session_id:
            mode === "wrong_session"
              ? "22222222-2222-4222-8222-222222222222"
              : session,
          claude_code_version: "2.1.292",
          apiKeySource: "oauth",
          cwd: lease.paths.workspace,
          model: CLAUDE_CODE_MODEL,
          effort: CLAUDE_CODE_EFFORT,
          permissionMode: "dontAsk",
          tools: [...CLAUDE_CODE_TOOLS],
          mcp_servers: [],
          skills: [],
          agents: [],
          plugins: [
            { name: "qe-account-cell", path: CLAUDE_CODE_PLUGIN_PATH },
            { name: "cc-plugin-sec-default", path: "builtin" },
          ],
          extra_native_output: canary,
        };
        const gate = `${lease.paths.workspace}/gate-${crypto.randomUUID()}`;
        diag.record("process_launch_requested");
        const target = await lease.spawnStreamed(
          {
            executable: "/usr/bin/python3",
            args: ["-u", "-c", python],
            cwd: lease.paths.workspace,
            environment: {
              QE_MODE: mode,
              QE_FRAME: Buffer.from(`${JSON.stringify(init)}\n`).toString(
                "base64",
              ),
              QE_GATE: gate,
            },
          },
          { bufferBytes: 1024 * 1024, acknowledgementTimeoutMs: 30_000 },
        );
        diag.bindProcess(target.handle);
        const frames = new AsyncFrameQueue();
        let firstData!: () => void;
        const data = new Promise<void>((resolve) => (firstData = resolve));
        const source = target.stdout;
        const observed = {
          ...target,
          stdout: (async function* () {
            for await (const event of source) {
              if (event.kind === "data") firstData();
              yield event;
            }
          })(),
        };
        let cancelled = false;
        observeClaudeProtocol(observed, frames, diag, () => cancelled);
        const start = performance.now();
        try {
          await sendMessage(target, session, probe, false, diag);
          if (mode === "fragmented") {
            await data;
            expect(frames.cursor).toBe(0);
            const released = await lease.exec({
              executable: "/usr/bin/python3",
              args: [
                "-c",
                "import pathlib,sys;pathlib.Path(sys.argv[1]).touch()",
                gate,
              ],
              cwd: lease.paths.workspace,
              environment: {},
              timeoutMs: 30_000,
            });
            expect(released.exitCode).toBe(0);
          }
          const waiting = waitForInit(frames, 30_000, () =>
            diag.record("attestation_timeout_fired", target.handle),
          );
          if (mode === "silent" || mode === "ignored_mod_status") {
            await expect(waiting).rejects.toThrow("protocol frame timed out");
            expect(diag.snapshot()).toMatchObject({
              lastProvenStage: "probe_write_acknowledged",
              nativeAttestationInterval: "unknown",
              modExecution: "unestablished",
              modReady: "unobservable_at_this_layer",
              observations: {
                protocol_frame_observed: "not_observed",
                attestation_timeout_fired: "observed",
              },
            });
          } else if (mode === "exit") {
            await expect(waiting).rejects.toThrow();
            expect(await target.exit).toEqual({
              kind: "exited_nonzero",
              exitCode: 7,
            });
          } else {
            const received = await waiting;
            if (mode === "wrong_session") {
              expect(() =>
                attestClaudeInit(received, {
                  sessionId: session,
                  cwd: lease.paths.workspace,
                  model: CLAUDE_CODE_MODEL,
                }),
              ).toThrow();
              diag.record("protocol_frame_rejected", target.handle);
              expect(diag.snapshot().observations.protocol_frame_observed).toBe(
                "not_observed",
              );
            } else {
              attestClaudeInit(received, {
                sessionId: session,
                cwd: lease.paths.workspace,
                model: CLAUDE_CODE_MODEL,
              });
              diag.record("protocol_frame_validated", target.handle);
              expect(diag.snapshot().lastProvenStage).toBe(
                "protocol_frame_validated",
              );
            }
          }
        } finally {
          cancelled = true;
          if (mode !== "exit") await cancelClaudePreparation(target, diag);
          await target.exit;
        }
        expect(diag.snapshot().observations.process_exit_observed).toBe(
          "observed",
        );
        cases.push({
          mode,
          preparationId: diag.preparationId,
          elapsedMs: Math.round(performance.now() - start),
        });
      }
      db.close();
      db = new Database(dbPath);
      store = new ManagedHarnessLifecycleStore(db);
      for (const proof of cases)
        expect(store.get(proof.preparationId)).not.toBeNull();
      expect(
        JSON.stringify(
          db.query("SELECT * FROM managed_harness_lifecycle").all(),
        ),
      ).not.toContain(canary);
      expect(JSON.stringify(infra)).not.toContain(canary);
    } finally {
      let cleanup = "not_created";
      if (ref) {
        let result = await cleanupExecutionEnvironment(backend, ref);
        for (let i = 0; result.state !== "removed" && i < 120; i++) {
          await Bun.sleep(500);
          result = await cleanupExecutionEnvironment(backend, ref);
        }
        cleanup = result.state;
      }
      await backend.close();
      db.close();
      await writeFile(
        join(root, "proof.json"),
        `${JSON.stringify({ cases, infra, cleanup, providerTraffic: 0, credentialOperations: 0, modelTurns: 0 }, null, 2)}\n`,
      );
      expect(cleanup).toBe("removed");
    }
  },
  12 * 60_000,
);
