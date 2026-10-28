import { expect, spyOn, test } from "bun:test";
import { readFileSync } from "node:fs";
import { inspect } from "node:util";
import ts from "typescript";
import { SbxStreamedProcessTransport } from "../src/execution-environment/sbx-streamed-process.ts";
import {
  StreamedProcessManager,
  type StreamedProcessTransport,
} from "../src/execution-environment/streamed-process.ts";
import type { EnvironmentRef } from "../src/execution-environment/types.ts";
import {
  ClaudePreProbeGate,
  isFreshInitialProbeExecution,
} from "../src/harnesses/claude-code/preprobe-diagnostics.ts";
import type { OperationalRecoveryExecution } from "../src/protocol/types.ts";
import { action } from "./support.ts";

const initial: OperationalRecoveryExecution = {
  authorization_kind: "initial",
  continuation_mode: "fresh",
  epoch_number: 0,
  attempt_in_epoch: 1,
  attempt_allowance: 1,
  retained_lineage_id: null,
  source_attempt_id: null,
  request_id: null,
};
const fresh = {
  freshAcceptance: true,
  continuation: false,
  recovering: false,
  priorSession: false,
};
function candidate(change: Record<string, unknown> = {}) {
  return action({
    operational_recovery: {
      ...initial,
      ...change,
    } as OperationalRecoveryExecution,
  });
}

test("retained-sixth structural regression: ordinary Product initial/fresh is eligible without importing any history row", () => {
  expect(isFreshInitialProbeExecution(candidate(), fresh)).toBe(true);
  for (const attempt_allowance of [null, 1, 3])
    expect(
      isFreshInitialProbeExecution(candidate({ attempt_allowance }), fresh),
    ).toBe(true);
});
for (const [name, change] of [
  [
    "human fresh recovery",
    {
      authorization_kind: "human",
      epoch_number: 1,
      source_attempt_id: "previous",
      request_id: "human-request",
    },
  ],
  [
    "human retained resume",
    {
      authorization_kind: "human",
      epoch_number: 1,
      continuation_mode: "retained",
      source_attempt_id: "previous",
      retained_lineage_id: "retained",
      request_id: "human-request",
    },
  ],
  ["same-epoch retry", { attempt_in_epoch: 2 }],
  ["different epoch", { epoch_number: 1 }],
  ["conflicting retained mode", { continuation_mode: "retained" }],
  ["malformed resume", { continuation_mode: "resume" }],
  ["malformed rebind", { continuation_mode: "rebind" }],
  ["malformed auth", { authorization_kind: "retry" }],
  ["prior lineage", { retained_lineage_id: "previous" }],
  ["source Attempt", { source_attempt_id: "previous" }],
  ["request identity", { request_id: "previous" }],
  ["zero allowance", { attempt_allowance: 0 }],
  ["invalid allowance", { attempt_allowance: Number.NaN }],
  ["unsafe allowance", { attempt_allowance: Number.MAX_SAFE_INTEGER + 1 }],
] as const)
  test(`fresh eligibility rejects ${name}`, () => {
    expect(isFreshInitialProbeExecution(candidate(change), fresh)).toBe(false);
  });
for (const flag of [
  "freshAcceptance",
  "continuation",
  "recovering",
  "priorSession",
] as const)
  test(`fresh eligibility fences ${flag}`, () => {
    expect(
      isFreshInitialProbeExecution(candidate(), {
        ...fresh,
        [flag]: !fresh[flag],
      }),
    ).toBe(false);
  });
test("optional legacy metadata does not prove first-attempt eligibility; context aliases must all be fresh", () => {
  const a = candidate();
  delete a.operational_recovery;
  expect(isFreshInitialProbeExecution(a, fresh)).toBe(false);
  const b = candidate();
  b.execution.context.mode = "continue_from";
  expect(isFreshInitialProbeExecution(b, fresh)).toBe(false);
  const c = candidate();
  c.context_lineage_occurrence_id = "previous";
  expect(isFreshInitialProbeExecution(c, fresh)).toBe(false);
  const d = candidate();
  d.execution.context.source_occurrence_id = "previous";
  expect(isFreshInitialProbeExecution(d, fresh)).toBe(false);
  const e = candidate();
  e.context_requirement.selector = "continue_from";
  expect(isFreshInitialProbeExecution(e, fresh)).toBe(false);
});

test("Worker receipt is minted only for a new current-epoch Claude acceptance and consumed once", () => {
  const text = readFileSync(
    new URL("../src/worker.ts", import.meta.url),
    "utf8",
  );
  const source = ts.createSourceFile(
    "worker.ts",
    text,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  let reader: ts.ArrowFunction | undefined,
    producer: ts.IfStatement | undefined;
  function visit(node: ts.Node) {
    if (
      ts.isNewExpression(node) &&
      node.expression.getText(source) === "ClaudeCodeHarness"
    ) {
      const fn = node.arguments?.[7];
      if (fn && ts.isArrowFunction(fn)) reader = fn;
    }
    if (
      ts.isIfStatement(node) &&
      node.expression.getText(source).includes("acceptance.created") &&
      node.thenStatement
        .getText(source)
        .includes("this.freshDiagnosticActions.set(")
    )
      producer = node;
    ts.forEachChild(node, visit);
  }
  visit(source);
  expect(reader).toBeDefined();
  expect(producer).toBeDefined();
  const condition = producer?.expression.getText(source) ?? "";
  for (const fence of [
    "acceptance.created",
    'harness_kind === "claude_code"',
    "size < 4096",
    "readyGeneration === generation",
    "isCurrentGeneration(generation)",
  ])
    expect(condition).toContain(fence);
  // Own callback only, with a fake map; no Worker import/constructor/services.
  const claim = new Function("actionId", reader?.body.getText(source) ?? "");
  const owner = { freshDiagnosticActions: new Map([["action-A", "1:9"]]) };
  expect(claim.call(owner, "action-B")).toBeNull();
  expect(claim.call(owner, "action-A")).toBe("1:9");
  expect(claim.call(owner, "action-A")).toBeNull();
  expect(owner.freshDiagnosticActions.size).toBe(0);
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
const ref: EnvironmentRef = {
  backendKind: "fixture",
  workerId: "worker",
  environmentId: "cell",
  incarnation: "incarnation",
  owner: { kind: "run", runId: "run" },
  profile: { id: "profile", digest: "digest" },
};
const paths = {
  workspace: "/fixture/workspace",
  home: "/fixture/home",
  state: "/fixture/state",
  control: "/fixture/control",
  cache: "/fixture/cache",
  temp: "/fixture/tmp",
};
async function managed() {
  let validations = 0,
    writes = 0;
  let validateHook: () => void = () => undefined;
  const manager = new StreamedProcessManager({
    backendKind: "fixture",
    validate: () => {
      validations++;
      validateHook();
    },
  });
  const end = deferred<void>();
  const transport: StreamedProcessTransport = {
    identity: {
      backendProcessId: "1",
      processStartIdentity: "start",
      observedExecutable: "/fixture/target",
      observedExecutableIdentity: "1:2",
    },
    negotiatedCapabilities: () =>
      Object.freeze({ nonblockingDiagnosticWrite: "supported" }),
    run: () => end.promise,
    write: async () => {
      writes++;
      return { certainty: "acknowledged" };
    },
    closeStdin: async () => ({ certainty: "acknowledged" }),
    cancel: async () => ({ certainty: "acknowledged" }),
    disconnect: async () => {
      end.resolve();
    },
  };
  const process = await manager.spawn(
    ref,
    paths,
    {
      executable: "/fixture/target",
      args: [],
      cwd: paths.state,
      environment: {},
    },
    {},
    async () => transport,
  );
  return {
    process,
    transport,
    writes: () => writes,
    validations: () => validations,
    setValidate: (fn: () => void) => {
      validateHook = fn;
    },
  };
}
test("negotiation reads are frozen, current-attachment-only and never acquire a lease or write", async () => {
  const a = await managed(),
    b = await managed();
  b.transport.negotiatedCapabilities = () =>
    Object.freeze({ nonblockingDiagnosticWrite: "unsupported" });
  const reads = a.validations();
  const past = a.process.negotiatedCapabilities?.();
  expect(past).toEqual({ nonblockingDiagnosticWrite: "supported" });
  expect(Object.isFrozen(past)).toBe(true);
  expect(b.process.negotiatedCapabilities?.()).toEqual({
    nonblockingDiagnosticWrite: "unsupported",
  });
  expect(a.validations()).toBe(reads);
  expect(a.writes()).toBe(0);
  a.transport.identity.backendProcessId = "replacement";
  expect(a.process.negotiatedCapabilities?.()).toEqual({
    nonblockingDiagnosticWrite: "unavailable",
  });
  expect(b.process.negotiatedCapabilities?.()).toEqual({
    nonblockingDiagnosticWrite: "unsupported",
  });
  await a.process.disconnect();
  await b.process.disconnect();
  expect(a.process.negotiatedCapabilities?.()).toEqual({
    nonblockingDiagnosticWrite: "unavailable",
  });
});
for (const change of [
  "handle",
  "cancel",
  "closed_stdin",
  "missing_method",
  "malformed",
] as const)
  test(`negotiation unavailable for ${change}`, async () => {
    const f = await managed();
    if (change === "handle")
      f.process.handle.environment.incarnation = "replacement";
    if (change === "cancel") await f.process.cancel();
    if (change === "closed_stdin") await f.process.closeStdin();
    if (change === "missing_method") delete f.transport.negotiatedCapabilities;
    if (change === "malformed")
      f.transport.negotiatedCapabilities = (() => ({
        nonblockingDiagnosticWrite: "truthy",
      })) as never;
    expect(f.process.negotiatedCapabilities?.()).toEqual({
      nonblockingDiagnosticWrite: "unavailable",
    });
    await f.process.disconnect();
  });
test("epoch loss during the existing async write validation sends zero physical bytes", async () => {
  const f = await managed();
  let epoch = 1;
  const gate = new ClaudePreProbeGate(
    f.process,
    () => epoch === 1,
    () => undefined,
  );
  gate.check();
  f.setValidate(() => {
    epoch = 2;
  });
  await expect(
    f.process.write(Uint8Array.of(1), () => gate.check()),
  ).rejects.toMatchObject({ code: "diagnostic_capability_unavailable" });
  expect(f.writes()).toBe(0);
  await f.process.cancel();
  await f.process.disconnect();
});
for (const replacement of ["2:9", "1:10"])
  test(`pre-probe guard separately fences local/registration epoch ${replacement}`, async () => {
    const f = await managed();
    let epoch = "1:9";
    const checks: string[] = [];
    const gate = new ClaudePreProbeGate(
      f.process,
      () => epoch === "1:9",
      (status) => checks.push(status),
    );
    gate.check();
    epoch = replacement;
    await expect(
      f.process.write(Uint8Array.of(1), () => gate.check()),
    ).rejects.toMatchObject({ code: "diagnostic_capability_unavailable" });
    expect(f.writes()).toBe(0);
    expect(checks).toEqual(["supported", "unavailable"]);
    await f.process.disconnect();
  });

test("pre-probe guard operands cannot be serialized, cloned, inspected or transferred", async () => {
  const f = await managed();
  f.process.handle.backendProcessId = "private-pid-canary";
  // Own process stub, not a relay or a real target.
  const process = {
    ...f.process,
    negotiatedCapabilities: () =>
      Object.freeze({ nonblockingDiagnosticWrite: "supported" as const }),
  };
  const gate = new ClaudePreProbeGate(
    process,
    () => true,
    () => undefined,
  );
  gate.check();
  expect(
    inspect(gate, { showHidden: true, customInspect: false }),
  ).not.toContain("private-pid-canary");
  expect(Bun.inspect(gate, { depth: 30 })).not.toContain("private-pid-canary");
  expect(() => JSON.stringify(gate)).toThrow();
  expect(() => structuredClone(gate)).toThrow();
  expect(() => String(gate)).toThrow();
  process.handle.processGeneration = "replacement";
  expect(() => gate.check()).toThrow();
  gate.invalidate();
  expect(() => gate.check()).toThrow();
  await f.process.disconnect();
});

function frame(type: number, value: unknown): Uint8Array {
  const payload = new TextEncoder().encode(
    typeof value === "string" ? value : JSON.stringify(value),
  );
  const bytes = new Uint8Array(payload.length + 5);
  bytes[0] = type;
  new DataView(bytes.buffer).setUint32(1, payload.length);
  bytes.set(payload, 5);
  return bytes;
}
async function openFake(
  ready: Record<string, unknown> | "eof" | "malformed" | "exit" | "never",
) {
  const end = deferred<number>();
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  let kills = 0,
    writes = 0;
  const child = {
    stdin: {
      write: () => {
        writes++;
        return 1;
      },
      flush: () => 0,
      end: () => 0,
    },
    stdout: new ReadableStream<Uint8Array>({
      start(c) {
        controller = c;
        if (ready === "eof") c.close();
        else if (ready === "malformed") c.enqueue(frame(1, "invalid JSON"));
        else if (ready === "exit")
          c.enqueue(frame(11, { kind: "exited", exitCode: 0 }));
        else if (ready !== "never")
          c.enqueue(
            frame(1, {
              pid: "1",
              startIdentity: "start",
              observedExecutable: "/fixture/target",
              observedExecutableIdentity: "1:2",
              environmentMarkerSha256: "marker",
              ...ready,
            }),
          );
      },
    }),
    stderr: new ReadableStream({
      start(c) {
        c.close();
      },
    }),
    exited: end.promise,
    kill: () => {
      kills++;
      end.resolve(0);
    },
  };
  const spawn = spyOn(Bun, "spawn").mockReturnValue(child as never);
  const opened = SbxStreamedProcessTransport.open({
    client: {
      executable: "/not/invoked",
      streamLauncherArgs: () => [],
    } as never,
    sandboxName: "not-invoked",
    processGeneration: "generation",
    command: {
      executable: "/fixture/target",
      args: [],
      cwd: paths.state,
      environment: {},
    },
    relaySource: "not executed",
    markerPath: "/fixture/marker",
    expectedMarkerSha256: "marker",
    acknowledgementTimeoutMs: 30_000,
  });
  return {
    opened,
    restore: () => spawn.mockRestore(),
    kills: () => kills,
    writes: () => writes,
    lateReady: () => controller.enqueue(frame(1, { protocolVersion: 99 })),
    malformedFrame: () => {
      const header = new Uint8Array(5);
      header[0] = 2;
      new DataView(header.buffer).setUint32(1, 1024 * 1024 + 65);
      controller.enqueue(header);
    },
    finish: () => {
      controller.enqueue(frame(4, ""));
      controller.enqueue(frame(5, ""));
      controller.enqueue(frame(11, { kind: "exited", exitCode: 0 }));
      controller.close();
      end.resolve(0);
    },
  };
}
for (const [name, ready, expected] of [
  [
    "new relay",
    { protocolVersion: 2, nonblockingDiagnosticWrite: true },
    "supported",
  ],
  [
    "false feature",
    { protocolVersion: 2, nonblockingDiagnosticWrite: false },
    "unsupported",
  ],
  ["absent feature / old relay", { protocolVersion: 2 }, "unsupported"],
  ["legacy READY", {}, "unsupported"],
  [
    "version alone",
    { protocolVersion: 2, nonblockingDiagnosticWrite: "true" },
    "unavailable",
  ],
  [
    "wrong version",
    { protocolVersion: 1, nonblockingDiagnosticWrite: true },
    "unsupported",
  ],
  [
    "malformed version",
    { protocolVersion: "2", nonblockingDiagnosticWrite: true },
    "unavailable",
  ],
] as const)
  test(`live READY parsing with fake transport: ${name}`, async () => {
    const f = await openFake(ready);
    try {
      const transport = await f.opened;
      expect(
        transport.negotiatedCapabilities().nonblockingDiagnosticWrite,
      ).toBe("unavailable");
      const running = transport.run(async () => undefined);
      const value = transport.negotiatedCapabilities();
      expect(value).toEqual({ nonblockingDiagnosticWrite: expected });
      expect(Object.keys(value)).toEqual(["nonblockingDiagnosticWrite"]);
      expect(Object.isFrozen(value)).toBe(true);
      expect(f.writes()).toBe(0);
      f.finish();
      await running;
      expect(
        transport.negotiatedCapabilities().nonblockingDiagnosticWrite,
      ).toBe("unavailable");
    } finally {
      f.restore();
    }
  });
for (const failure of ["lateReady", "malformedFrame"] as const)
  test(`observed ${failure} revokes live capability before async error publication`, async () => {
    const f = await openFake({
      protocolVersion: 2,
      nonblockingDiagnosticWrite: true,
    });
    const published = deferred<void>(),
      release = deferred<void>();
    let running: Promise<void> | undefined;
    try {
      const transport = await f.opened;
      running = transport.run(async (event) => {
        if (event.kind === "transport_error") {
          published.resolve();
          await release.promise;
        }
      });
      const historical = transport.negotiatedCapabilities();
      expect(historical.nonblockingDiagnosticWrite).toBe("supported");
      f[failure]();
      await published.promise;
      expect(
        transport.negotiatedCapabilities().nonblockingDiagnosticWrite,
      ).toBe("unavailable");
      expect(transport.tryWriteDiagnostic(Uint8Array.of(1))).toBe(false);
      expect(f.writes()).toBe(0);
      expect(historical.nonblockingDiagnosticWrite).toBe("supported");
    } finally {
      release.resolve();
      f.finish();
      await running;
      f.restore();
    }
  });

for (const ready of ["eof", "malformed", "exit"] as const)
  test(`READY ${ready} cannot return a usable process or write a probe`, async () => {
    const f = await openFake(ready);
    try {
      await expect(f.opened).rejects.toThrow();
      expect(f.kills()).toBe(1);
      expect(f.writes()).toBe(0);
    } finally {
      f.restore();
    }
  });
test("no READY uses the existing startup deadline; no polling or extra wait", async () => {
  let fire!: () => void;
  const timer = spyOn(globalThis, "setTimeout").mockImplementation(((
    callback: () => void,
  ) => {
    fire = callback;
    return { unref() {} };
  }) as never);
  const clear = spyOn(globalThis, "clearTimeout").mockImplementation(
    () => undefined,
  );
  const f = await openFake("never");
  const result = f.opened.then(
    () => null,
    (error) => error,
  );
  try {
    for (let i = 0; i < 8; i++) await Promise.resolve();
    fire();
    expect(await result).toBeInstanceOf(Error);
    expect(f.kills()).toBe(1);
    expect(f.writes()).toBe(0);
  } finally {
    f.restore();
    timer.mockRestore();
    clear.mockRestore();
  }
});
