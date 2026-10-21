import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type {
  EnvironmentRef,
  StreamedProcess,
  StreamedProcessExit,
  StreamedProcessStreamEvent,
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
  ClaudeProtocolTimeout,
  cancelClaudePreparation,
  observeClaudeProtocol,
  pump,
  sendMessage,
  waitForInit,
} from "../src/harnesses/claude-code/protocol.ts";
import { ManagedHarnessLifecycleStore } from "../src/harnesses/lifecycle-diagnostics.ts";

export const protocolSession = "11111111-1111-4111-8111-111111111111";
export const protocolEnvironment: EnvironmentRef = {
  backendKind: "fake-sbx",
  environmentId: "account-environment",
  incarnation: "account-incarnation",
  workerId: "protocol-worker",
  owner: {
    kind: "provider_account",
    providerAccountId: "account-1",
    credentialGeneration: 1,
  },
  profile: { id: "qe-claude-account-v2", digest: `sha256:${"a".repeat(64)}` },
};
export function protocolInit(cwd = "/qe/state/claude/empty-cwd") {
  return {
    type: "system",
    subtype: "init",
    session_id: protocolSession,
    claude_code_version: "2.1.292",
    apiKeySource: "oauth",
    cwd,
    model: CLAUDE_CODE_MODEL,
    effort: CLAUDE_CODE_EFFORT,
    permissionMode: "dontAsk",
    tools: [...CLAUDE_CODE_TOOLS],
    mcp_servers: [],
    skills: [],
    agents: [],
    plugins: [
      {
        name: "qe-account-cell",
        path: CLAUDE_CODE_PLUGIN_PATH,
        version: "1.0.0",
      },
      { name: "cc-plugin-sec-default", path: "builtin" },
    ],
  };
}

const probe = "Quest Engineering fixed zero-inference initialization probe.";

for (const dropDiagnostics of [false, true]) {
  test(`real protocol parser/validator success is independent of diagnostic loss=${dropDiagnostics}`, async () => {
    const fixture = processFixture();
    const db = new Database(":memory:");
    const store = new ManagedHarnessLifecycleStore(db);
    const diagnostics = dropDiagnostics
      ? null
      : store.begin({
          harnessKind: "claude_code",
          harnessProtocol: "qe_claude_account_cell_v1",
          reservedNativeSessionId: protocolSession,
          environment: protocolEnvironment,
        });
    diagnostics?.record("process_launch_requested");
    diagnostics?.bindProcess(fixture.process.handle);
    const frames = new AsyncFrameQueue();
    observeClaudeProtocol(fixture.process, frames, diagnostics, () => false);
    const sending = sendMessage(
      fixture.process,
      protocolSession,
      probe,
      false,
      diagnostics,
    );
    const written = JSON.parse(new TextDecoder().decode(fixture.writes[0]));
    expect(written).toMatchObject({ shouldQuery: false, isSynthetic: true });
    expect(fixture.writes[0]).toHaveLength(301);
    await sending;
    const native = { ...protocolInit(), ignoredNativeContext: "λ" };
    const serialized = `${JSON.stringify({ type: "system", subtype: "status" })}\n${JSON.stringify(native)}\n`;
    // Fragment every byte, including a split UTF-8 character in ignored content.
    for (const byte of new TextEncoder().encode(serialized))
      fixture.output(Uint8Array.of(byte));
    const init = await waitForInit(frames, 1000);
    attestClaudeInit(init, {
      sessionId: protocolSession,
      cwd: native.cwd,
      model: CLAUDE_CODE_MODEL,
      effort: CLAUDE_CODE_EFFORT,
    });
    diagnostics?.record("protocol_frame_validated", fixture.process.handle);
    if (diagnostics) {
      expect(store.get(diagnostics.preparationId)).toMatchObject({
        lastProvenStage: "protocol_frame_validated",
        modExecution: "unestablished",
        modEntrypoint: "unobservable_at_this_layer",
        modReady: "unobservable_at_this_layer",
      });
    }
    await cancelClaudePreparation(fixture.process, diagnostics);
    await fixture.process.exit;
    expect(diagnostics?.snapshot().observations.process_exit_observed).toBe(
      dropDiagnostics ? undefined : "observed",
    );
    db.close();
  });
}

test("dropped/unproven Mod breadcrumbs leave timeout native interval unknown", async () => {
  const fixture = processFixture();
  const db = new Database(":memory:");
  const store = new ManagedHarnessLifecycleStore(db);
  const diagnostics = store.begin({
    harnessKind: "claude_code",
    harnessProtocol: "qe_claude_account_cell_v1",
    reservedNativeSessionId: protocolSession,
    environment: protocolEnvironment,
  });
  if (!diagnostics) throw new Error("fixture diagnostics unavailable");
  diagnostics.record("process_launch_requested");
  diagnostics.bindProcess(fixture.process.handle);
  const frames = new AsyncFrameQueue();
  observeClaudeProtocol(fixture.process, frames, diagnostics, () => true);
  await sendMessage(
    fixture.process,
    protocolSession,
    probe,
    false,
    diagnostics,
  );
  // Self-asserted text is not a trusted Mod lifecycle producer.
  fixture.output(
    new TextEncoder().encode(
      `${JSON.stringify({ type: "system", subtype: "ui_status", plugin: "qe-account-cell", text: "mod_ready" })}\n`,
    ),
  );
  await expect(
    waitForInit(frames, 20, () =>
      diagnostics.record("attestation_timeout_fired", fixture.process.handle),
    ),
  ).rejects.toBeInstanceOf(ClaudeProtocolTimeout);
  expect(store.get(diagnostics.preparationId)).toMatchObject({
    lastProvenStage: "probe_write_acknowledged",
    nativeAttestationInterval: "unknown",
    processStateAtTimeout: "unknown",
    modExecution: "unestablished",
    modReady: "unobservable_at_this_layer",
    observations: {
      attestation_timeout_fired: "observed",
      protocol_frame_observed: "not_observed",
    },
  });
  await cancelClaudePreparation(fixture.process, diagnostics);
  await fixture.process.exit;
  expect(diagnostics.snapshot().observations.cancellation_acknowledged).toBe(
    "observed",
  );
  db.close();
});

test("early exit fails frame waiter immediately and retains safe exit category", async () => {
  const fixture = processFixture();
  const db = new Database(":memory:");
  const diagnostics = new ManagedHarnessLifecycleStore(db).begin({
    harnessKind: "claude_code",
    harnessProtocol: "qe_claude_account_cell_v1",
    reservedNativeSessionId: protocolSession,
    environment: protocolEnvironment,
  });
  diagnostics?.bindProcess(fixture.process.handle);
  const frames = new AsyncFrameQueue();
  observeClaudeProtocol(fixture.process, frames, diagnostics, () => false);
  const waiting = waitForInit(frames, 1000);
  fixture.exit({ kind: "exited_nonzero", exitCode: 7 });
  await expect(waiting).rejects.not.toBeInstanceOf(ClaudeProtocolTimeout);
  expect(diagnostics?.snapshot().events.at(-1)?.exit).toEqual({
    kind: "exited_nonzero",
    exitCode: 7,
  });
  db.close();
});

test("native parsing failures and unknown fields never persist canary text", async () => {
  const secret = "SECRET_NATIVE_AUTH_URL_CODE_PROMPT_CANARY";
  const fixture = processFixture();
  const db = new Database(":memory:");
  const diagnostics = new ManagedHarnessLifecycleStore(db).begin({
    harnessKind: "claude_code",
    harnessProtocol: "qe_claude_account_cell_v1",
    reservedNativeSessionId: protocolSession,
    environment: protocolEnvironment,
  });
  diagnostics?.bindProcess(fixture.process.handle);
  const frames = new AsyncFrameQueue();
  observeClaudeProtocol(fixture.process, frames, diagnostics, () => true);
  fixture.output(new TextEncoder().encode(`{"${secret}":invalid}\n`));
  const error = await waitForInit(frames, 1000).catch(
    (value: unknown) => value,
  );
  expect(String(error)).not.toContain(secret);
  expect(
    JSON.stringify(db.query("SELECT * FROM managed_harness_lifecycle").all()),
  ).not.toContain(secret);
  await fixture.process.cancel();
  db.close();
});

test("a partial non-newline frame is unobserved until LF, without requiring stdin EOF", async () => {
  const fixture = processFixture();
  const db = new Database(":memory:");
  const diagnostics = new ManagedHarnessLifecycleStore(db).begin({
    harnessKind: "claude_code",
    harnessProtocol: "qe_claude_account_cell_v1",
    reservedNativeSessionId: protocolSession,
    environment: protocolEnvironment,
  });
  diagnostics?.bindProcess(fixture.process.handle);
  const frames = new AsyncFrameQueue();
  observeClaudeProtocol(fixture.process, frames, diagnostics, () => true);
  fixture.output(new TextEncoder().encode(JSON.stringify(protocolInit())));
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(diagnostics?.snapshot().observations.protocol_frame_observed).toBe(
    "not_observed",
  );
  fixture.output(Uint8Array.of(10));
  expect(await waitForInit(frames, 1000)).toEqual(protocolInit());
  expect(diagnostics?.snapshot().observations.protocol_frame_observed).toBe(
    "observed",
  );
  await fixture.process.cancel();
  db.close();
});

test("diagnostic observer failure cannot drop a real fragmented init", async () => {
  const frames = new AsyncFrameQueue();
  const init = protocolInit();
  async function* bytes() {
    for (const byte of new TextEncoder().encode(`${JSON.stringify(init)}\n`))
      yield { kind: "data" as const, sequence: 0, data: Uint8Array.of(byte) };
  }
  await pump(bytes(), frames, () => {
    throw new Error("UNTRUSTED_OBSERVER_ERROR_CANARY");
  });
  expect(await waitForInit(frames, 1000)).toEqual(init);
});

test("real unchanged Mod registers tools without a lifecycle emitter; Worker does not invent Mod stages", async () => {
  const path = resolve(
    import.meta.dir,
    "../profiles/qe-claude-account-v2/files/home/.qe-profile/claude-plugins/plugins/qe-account-cell/hooks/register.ts",
  );
  type Hook = (
    engine: unknown,
    event: unknown,
    next: (event: unknown) => unknown,
  ) => Promise<unknown>;
  const callbacks = new Map<string, Hook>();
  const registered: string[] = [];
  let diagnosticsEmitted = 0;
  const module = (await import(path)) as {
    register(on: (name: string, hook: Hook) => { catch(): void }): void;
  };
  module.register((name, hook) => {
    callbacks.set(name, hook);
    return { catch: () => undefined };
  });
  const env: Record<string, string> = {
    QE_ACCOUNT_CELL_MOD_PROTOCOL: "qe_claude_account_cell_v1",
    QE_CLAUDE_MODEL: CLAUDE_CODE_MODEL,
    QE_CLAUDE_EFFORT: CLAUDE_CODE_EFFORT,
  };
  const start = callbacks.get("session.start");
  if (!start) throw new Error("missing real Mod startup hook");
  await start(
    {
      env: { get: async (name: string) => env[name] },
      session: { id: async () => protocolSession },
      tool: {
        register: async ({ name }: { name: string }) => registered.push(name),
      },
      ui: {
        status: () => diagnosticsEmitted++,
        log: () => diagnosticsEmitted++,
      },
      process: {
        run: () => {
          throw new Error("Startup must not call the bridge");
        },
      },
    },
    { cwd: "/qe/state/claude/empty-cwd" },
    (event) => event,
  );
  expect(registered).toHaveLength(8);
  expect(diagnosticsEmitted).toBe(0);
  expect(callbacks.has("prompt.submit")).toBe(true);
  // No prompt.submit or turn.step invoked by this fixture.
  const source = await readFile(
    resolve(import.meta.dir, "../src/harnesses/claude-code/adapter.ts"),
    "utf8",
  );
  expect(source).toContain("waitForInit(frames, 30_000,");
});

function processFixture() {
  let output!: ReadableStreamDefaultController<Uint8Array>;
  let settleExit!: (value: StreamedProcessExit) => void;
  const exit = new Promise<StreamedProcessExit>(
    (resolve) => (settleExit = resolve),
  );
  const stdout = new ReadableStream<Uint8Array>({ start: (c) => (output = c) });
  let terminal = false;
  const writes: Uint8Array[] = [];
  const finish = (value: StreamedProcessExit) => {
    if (terminal) return;
    terminal = true;
    output.close();
    settleExit(value);
  };
  const process: StreamedProcess = {
    handle: {
      contractVersion: 1,
      backendKind: protocolEnvironment.backendKind,
      environment: protocolEnvironment,
      processGeneration: "process-1",
      backendProcessId: "1000",
      processStartIdentity: "start-1",
      executable: "/opt/qe/claude/claude",
    },
    stdout: readable(stdout),
    stderr: readable(new ReadableStream({ start: (c) => c.close() })),
    exit,
    write: async (data) => {
      writes.push(new Uint8Array(data));
      return {
        certainty: "acknowledged",
        writeId: crypto.randomUUID(),
        byteLength: data.byteLength,
      };
    },
    cancel: async () => {
      finish({ kind: "signaled", signal: "SIGTERM" });
      return { certainty: "acknowledged", cancellationId: crypto.randomUUID() };
    },
    closeStdin: async () => ({
      certainty: "acknowledged",
      writeId: crypto.randomUUID(),
      byteLength: 0,
    }),
    disconnect: async () => undefined,
    inspect: async () => ({
      handle: process.handle,
      process: "running",
      streamAttachment: "attached",
      streamRecovery: "current_worker_only",
    }),
  };
  return {
    process,
    writes,
    output: (data: Uint8Array) => output.enqueue(data),
    exit: finish,
  };
}

async function* readable(
  source: ReadableStream<Uint8Array>,
): AsyncIterable<StreamedProcessStreamEvent> {
  const reader = source.getReader();
  for (;;) {
    const result = await reader.read();
    if (result.done) break;
    yield { kind: "data", sequence: 0, data: result.value };
  }
  yield { kind: "eof", sequence: 0 };
}
