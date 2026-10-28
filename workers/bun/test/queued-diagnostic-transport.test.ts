import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import ts from "typescript";
import { SbxStreamedProcessTransport } from "../src/execution-environment/sbx-streamed-process.ts";
import {
  StreamedProcessManager,
  type StreamedProcessTransport,
} from "../src/execution-environment/streamed-process.ts";
import type { EnvironmentRef } from "../src/execution-environment/types.ts";

function sourceFile(path: string) {
  const text = readFileSync(new URL(path, import.meta.url), "utf8");
  return ts.createSourceFile(
    path,
    text,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
}
function namedMethod(source: ts.SourceFile, name: string): ts.Node {
  let found: ts.Node | undefined;
  function visit(node: ts.Node) {
    if (
      (ts.isMethodDeclaration(node) || ts.isFunctionDeclaration(node)) &&
      node.name?.getText(source) === name
    )
      found = node;
    ts.forEachChild(node, visit);
  }
  visit(source);
  if (!found) throw Error("Missing reviewed source method");
  return found;
}

test("mechanical timeout call order has one existing physical await and no diagnostic await/timer", () => {
  const source = sourceFile("../src/harnesses/claude-code/protocol.ts");
  const method = namedMethod(source, "cancelClaudePreparation");
  const text = method.getText(source);
  expect(text.indexOf(".atTimeout(process)")).toBeLessThan(
    text.indexOf("await process.cancel()"),
  );
  const awaits: ts.AwaitExpression[] = [];
  function visit(node: ts.Node) {
    if (ts.isAwaitExpression(node)) awaits.push(node);
    ts.forEachChild(node, visit);
  }
  visit(method);
  expect(awaits.map((node) => node.expression.getText(source))).toEqual([
    "process.cancel()",
  ]);
  expect(text).not.toContain("setTimeout");
  expect(text).not.toContain(".write(");
});
test("new diagnostic projection schedules no database work before physical cancellation", () => {
  const source = sourceFile("../src/harnesses/lifecycle-diagnostics.ts");
  const method = namedMethod(source, "recordQueuedProbeCancellation");
  function visit(node: ts.Node) {
    if (ts.isCallExpression(node)) {
      const name = ts.isPropertyAccessExpression(node.expression)
        ? node.expression.name.text
        : node.expression.getText(source);
      expect(
        ["save", "scheduleCensusSave", "setImmediate", "setTimeout"].includes(
          name,
        ),
      ).toBe(false);
    }
    ts.forEachChild(node, visit);
  }
  visit(method);
});

test("capability imports/call paths cannot invoke readiness, inference or async I/O", () => {
  const source = sourceFile(
    "../src/harnesses/claude-code/queued-probe-cancellation.ts",
  );
  for (const name of ["atTimeout", "observe", "matches"]) {
    const method = namedMethod(source, name);
    const text = method.getText(source);
    function visit(node: ts.Node) {
      expect(ts.isAwaitExpression(node)).toBe(false);
      ts.forEachChild(node, visit);
    }
    visit(method);
    for (const forbidden of [
      "setTimeout",
      "setInterval",
      "attestClaudeInit",
      "attestClaudeEffort",
      "nativeSessionRef",
      "needs_confirmation",
      ".registry",
      ".store",
      ".write(",
    ])
      expect(text).not.toContain(forbidden);
  }
});
test("canonical ownership lookup is before probe; timeout ownership closure is memory-only", () => {
  const source = sourceFile("../src/harnesses/claude-code/adapter.ts");
  const text = namedMethod(source, "prepare").getText(source);
  expect(text.indexOf("this.currentDispatch?.")).toBeLessThan(
    text.indexOf("await sendMessage("),
  );
  const from = text.indexOf("const current = active.dispatch");
  const to = text.indexOf("return {", from);
  const guard = text.slice(from, to);
  expect(from).toBeGreaterThan(0);
  for (const forbidden of [
    "currentDispatch",
    ".store",
    ".registry",
    "assertCurrent",
    "await",
  ])
    expect(guard).not.toContain(forbidden);
  expect(text).toContain("waitForInit(frames, 30_000");
});
test("terminal ACK revocation is synchronous and revokes only diagnostic authority", () => {
  const executor = sourceFile("../src/dispatch/executor.ts");
  const text = namedMethod(executor, "acknowledgeTerminal").getText(executor);
  expect(text.indexOf("acknowledgeServerTerminal")).toBeLessThan(
    text.indexOf("revokeDiagnosticCapabilities"),
  );
  expect(text.indexOf("revokeDiagnosticCapabilities")).toBeLessThan(
    text.indexOf("await "),
  );
  const adapter = sourceFile("../src/harnesses/claude-code/adapter.ts");
  const revoke = namedMethod(adapter, "revokeDiagnosticCapabilities").getText(
    adapter,
  );
  expect(revoke).toContain("queuedProbeCancellation?.invalidate()");
  for (const forbidden of [
    "await",
    ".sessions",
    "initialized =",
    "nativeSessionRef",
    ".process.cancel",
  ])
    expect(revoke).not.toContain(forbidden);
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
function transportFixture(supported = true) {
  const written: Uint8Array[] = [];
  const exited = deferred<number>();
  const queued: Array<{ type: number; payload: Uint8Array } | null> = [];
  let waiting:
    | ((value: { type: number; payload: Uint8Array } | null) => void)
    | null = null;
  const feed = (type: number, payload = new Uint8Array()) => {
    const frame = { type, payload };
    if (waiting) {
      const resolve = waiting;
      waiting = null;
      resolve(frame);
    } else queued.push(frame);
  };
  const frames = {
    next: () =>
      queued.length
        ? Promise.resolve(queued.shift())
        : new Promise((resolve) => {
            waiting = resolve as typeof waiting;
          }),
    cancel: async () => {
      waiting?.(null);
    },
  };
  const child = {
    stdin: {
      write: (data: Uint8Array) => {
        written.push(data);
        return data.byteLength;
      },
      flush: () => new Promise<number>(() => {}),
      end: () => 0,
    },
    stderr: new ReadableStream({
      start(c) {
        c.close();
      },
    }),
    exited: exited.promise,
    kill: () => undefined,
  };
  // Synthetic constructor inputs only; never call open/Bun.spawn/SBX.
  const transport = Reflect.construct(SbxStreamedProcessTransport, [
    child,
    frames,
    {
      backendProcessId: "123",
      processStartIdentity: "start",
      observedExecutable: "/fixture/target",
      observedExecutableIdentity: "1:2",
    },
    30_000,
    "generation",
    "marker",
    true,
    supported,
  ]) as SbxStreamedProcessTransport;
  const running = transport.run(async () => undefined);
  return {
    transport,
    written,
    feed,
    finish: async () => {
      feed(4);
      feed(5);
      feed(11, new TextEncoder().encode('{"kind":"exited","exitCode":0}'));
      queued.push(null);
      exited.resolve(0);
      await running;
    },
  };
}
test("relay diagnostic has no ACK waiter; physical CANCEL is submitted despite an unresolved flush", async () => {
  const f = transportFixture();
  expect(f.transport.tryWriteDiagnostic(Uint8Array.of(1))).toBe(true);
  expect(f.transport.tryWriteDiagnostic(Uint8Array.of(2))).toBe(false);
  const cancellation = f.transport.cancel(
    "11111111-1111-4111-8111-111111111111",
  );
  expect(f.written.map((bytes) => bytes[0])).toEqual([24, 22]);
  f.feed(9, new TextEncoder().encode("11111111-1111-4111-8111-111111111111"));
  expect(await cancellation).toEqual({ certainty: "acknowledged" });
  await f.finish();
});
for (const kind of ["unsupported", "oversized", "empty"] as const)
  test(`relay drops diagnostic ${kind} without changing cancellation`, async () => {
    const f = transportFixture(kind !== "unsupported");
    expect(
      f.transport.tryWriteDiagnostic(
        new Uint8Array(kind === "oversized" ? 513 : kind === "empty" ? 0 : 1),
      ),
    ).toBe(false);
    expect(f.written).toHaveLength(0);
    await f.finish();
  });

test("generic manager has no diagnostic write-tail/validation wait, and refuses busy/retired attachments", async () => {
  const ref = {
    backendKind: "fixture",
    workerId: "worker",
    environmentId: "cell",
    incarnation: "incarnation",
    owner: { kind: "run", runId: "run" },
    profile: { id: "fixture", digest: "digest" },
  } as EnvironmentRef;
  const manager = new StreamedProcessManager({
    backendKind: "fixture",
    validate: () => undefined,
  });
  const runEnd = deferred<void>(),
    writeEnd = deferred<{ certainty: "acknowledged" }>();
  const events: string[] = [];
  const transport = {
    identity: {
      backendProcessId: "123",
      processStartIdentity: "start",
      observedExecutable: "/fixture/target",
    },
    run: () => runEnd.promise,
    write: () => writeEnd.promise,
    closeStdin: async () => ({ certainty: "acknowledged" as const }),
    tryWriteDiagnostic: () => {
      events.push("diagnostic");
      return true;
    },
    cancel: async () => {
      events.push("physical");
      return { certainty: "acknowledged" as const };
    },
    disconnect: async () => {
      runEnd.resolve();
    },
  } satisfies StreamedProcessTransport;
  const process = await manager.spawn(
    ref,
    {
      workspace: "/fixture/workspace",
      home: "/fixture/home",
      state: "/fixture/state",
      control: "/fixture/control",
      cache: "/fixture/cache",
      temp: "/fixture/tmp",
    },
    {
      executable: "/fixture/target",
      args: [],
      cwd: "/fixture/state",
      environment: {},
    },
    {},
    async () => transport,
  );
  const ordinary = process.write(Uint8Array.of(1));
  expect(process.tryWriteDiagnostic?.(Uint8Array.of(2))).toBe(false);
  writeEnd.resolve({ certainty: "acknowledged" });
  await ordinary;
  expect(process.tryWriteDiagnostic?.(Uint8Array.of(2))).toBe(true);
  const cancellation = process.cancel();
  expect(process.tryWriteDiagnostic?.(Uint8Array.of(3))).toBe(false);
  await cancellation;
  expect(events).toEqual(["diagnostic", "physical"]);
  await process.disconnect();
  expect(process.tryWriteDiagnostic?.(Uint8Array.of(4))).toBe(false);
});

test("guest diagnostic function is nonblocking, bounded, atomic, and never sends an ACK ahead of CANCEL", async () => {
  const source = readFileSync(
    new URL(
      "../src/execution-environment/sbx-streamed-process-relay.py",
      import.meta.url,
    ),
    "utf8",
  );
  // Execute ONLY our extracted function with fake OS/process objects, not the
  // relay main/Popen and never vendor code, a guest, SBX or a real target pipe.
  const fixture = `
import ast,json,sys,stat,types
source=sys.stdin.read()
node=next(n for n in ast.parse(source).body if isinstance(n,ast.FunctionDef) and n.name=='try_write_diagnostic')
assert not any(isinstance(n,(ast.While,ast.For,ast.Await)) for n in ast.walk(node))
assert not any(isinstance(n,ast.Call) and isinstance(n.func,ast.Name) and n.func.id in ('send','send_json') for n in ast.walk(node))
results=[]
for case in ('ok','full','closed','wrong_start','wrong_executable','wrong_pipe','unsupported','oversized'):
    calls=[]
    class OS:
        blocking=True
        def fstat(self,fd):
            if case=='closed': raise OSError()
            return types.SimpleNamespace(st_mode=stat.S_IFIFO,st_dev=1,st_ino=9 if case=='wrong_pipe' else 2)
        def fpathconf(self,*args): return 4096
        def get_blocking(self,fd): return self.blocking
        def set_blocking(self,fd,value): self.blocking=value;calls.append(('blocking',value))
        def write(self,fd,data):
            assert not self.blocking
            calls.append(('write',len(data)))
            if case=='full': raise BlockingIOError()
            return len(data)
    os=OS()
    env={'os':os,'stat':stat,'sys':types.SimpleNamespace(platform='darwin' if case=='unsupported' else 'linux'),'process':types.SimpleNamespace(poll=lambda:None,pid=1,stdin=types.SimpleNamespace(fileno=lambda:4)),'io_identity':{'startIdentity':'start','observedExecutableIdentity':'inode'},'io_pipe_identity':(1,2),'start_identity':lambda _: 'wrong' if case=='wrong_start' else 'start','executable_identity':lambda _: 'wrong' if case=='wrong_executable' else 'inode'}
    exec(compile(ast.Module(body=[node],type_ignores=[]),'<owned-relay-function>','exec'),env)
    env['try_write_diagnostic'](b'x'*(513 if case=='oversized' else 180))
    assert os.blocking
    assert sum(c[0]=='write' for c in calls)==(1 if case in ('ok','full') else 0)
    results.append(case)
print(json.dumps(results))
`;
  const child = Bun.spawn(["/usr/bin/python3", "-c", fixture], {
    env: {
      HOME: "/Users/kylec",
      PATH: "/usr/bin:/bin",
      PYTHONDONTWRITEBYTECODE: "1",
      QE_HOME: process.env.QE_HOME ?? "/synthetic/validation/.qe",
    },
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  child.stdin.write(source);
  child.stdin.end();
  const output = await new Response(child.stdout).text(),
    error = await new Response(child.stderr).text();
  expect(error).toBe("");
  expect(await child.exited).toBe(0);
  expect(JSON.parse(output)).toHaveLength(8);
});
