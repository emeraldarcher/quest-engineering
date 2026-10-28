import { spyOn } from "bun:test";
import { SbxStreamedProcessTransport } from "../../src/execution-environment/sbx-streamed-process.ts";
import { StreamedProcessManager } from "../../src/execution-environment/streamed-process.ts";
import type {
  EnvironmentLease,
  StreamedProcess,
} from "../../src/execution-environment/types.ts";

// Raw text is intentional: JSON.stringify(object) cannot represent duplicates.
export const readyIdentity =
  '"pid":"1000","startIdentity":"start-1","observedExecutable":"/opt/qe/claude/claude","observedExecutableIdentity":"1:2","environmentMarkerSha256":"marker"';
export const rawReadyCases = [
  [
    "current",
    '"protocolVersion":2,"nonblockingDiagnosticWrite":true',
    "supported",
  ],
  ["old", '"protocolVersion":2', "unsupported"],
  [
    "false",
    '"protocolVersion":2,"nonblockingDiagnosticWrite":false',
    "unsupported",
  ],
  [
    "null",
    '"protocolVersion":2,"nonblockingDiagnosticWrite":null',
    "unavailable",
  ],
  [
    "number",
    '"protocolVersion":2,"nonblockingDiagnosticWrite":1',
    "unavailable",
  ],
  [
    "string",
    '"protocolVersion":2,"nonblockingDiagnosticWrite":"true"',
    "unavailable",
  ],
  [
    "object",
    '"protocolVersion":2,"nonblockingDiagnosticWrite":{}',
    "unavailable",
  ],
  [
    "array",
    '"protocolVersion":2,"nonblockingDiagnosticWrite":[]',
    "unavailable",
  ],
  [
    "unknown protocol",
    '"protocolVersion":99,"nonblockingDiagnosticWrite":true',
    "unsupported",
  ],
  [
    "false then true",
    '"protocolVersion":2,"nonblockingDiagnosticWrite":false,"nonblockingDiagnosticWrite":true',
    "rejected",
  ],
  [
    "true then false",
    '"protocolVersion":2,"nonblockingDiagnosticWrite":true,"nonblockingDiagnosticWrite":false',
    "rejected",
  ],
  [
    "same protocol",
    '"protocolVersion":2,"protocolVersion":2,"nonblockingDiagnosticWrite":true',
    "rejected",
  ],
  [
    "conflicting protocol",
    '"protocolVersion":1,"protocolVersion":2,"nonblockingDiagnosticWrite":true',
    "rejected",
  ],
  [
    "same true",
    '"protocolVersion":2,"nonblockingDiagnosticWrite":true,"nonblockingDiagnosticWrite":true',
    "rejected",
  ],
  [
    "same false",
    '"protocolVersion":2,"nonblockingDiagnosticWrite":false,"nonblockingDiagnosticWrite":false',
    "rejected",
  ],
  [
    "escaped key",
    '"protocolVersion":2,"nonblockingDiagnosticWrite":false,"nonblockingDiagnostic\\u0057rite":true',
    "rejected",
  ],
  [
    "key-like value",
    '"protocolVersion":2,"nonblockingDiagnosticWrite":true,"note":"nonblockingDiagnosticWrite protocolVersion"',
    "supported",
  ],
  [
    "nested keys",
    '"protocolVersion":2,"nonblockingDiagnosticWrite":true,"extra":{"protocolVersion":1,"nonblockingDiagnosticWrite":false}',
    "supported",
  ],
  [
    "nested array",
    '"protocolVersion":2,"nonblockingDiagnosticWrite":true,"extra":[{"protocolVersion":1,"nonblockingDiagnosticWrite":false}]',
    "supported",
  ],
  [
    "escaped text",
    `"protocolVersion":2,"nonblockingDiagnosticWrite":true,"note":${JSON.stringify('\\" , "nonblockingDiagnosticWrite":false, \\"protocolVersion"')}`,
    "supported",
  ],
  [
    "malformed",
    '"protocolVersion":2,"nonblockingDiagnosticWrite":true,',
    "rejected",
  ],
  [
    "unterminated string",
    '"protocolVersion":2,"nonblockingDiagnosticWrite":true,"note":"unfinished',
    "rejected",
  ],
  ...[
    "pid",
    "startIdentity",
    "observedExecutable",
    "observedExecutableIdentity",
    "environmentMarkerSha256",
  ].map(
    (key) =>
      [
        `duplicate identity ${key}`,
        `"protocolVersion":2,"nonblockingDiagnosticWrite":true,${JSON.stringify(key)}:"conflict"`,
        "rejected",
      ] as const,
  ),
] as const;

function frame(type: number, payload: Uint8Array): Uint8Array {
  const bytes = new Uint8Array(5 + payload.length);
  bytes[0] = type;
  new DataView(bytes.buffer).setUint32(1, payload.length);
  bytes.set(payload, 5);
  return bytes;
}
const encode = (value: unknown) =>
  new TextEncoder().encode(JSON.stringify(value));

/** No process is spawned: every production open() call is intercepted before
 * Bun.spawn. Real READY reader, transport, manager and adapter still execute. */
export function preprobeRelay(
  lease: EnvironmentLease,
  fields: string,
  init: (session: string) => Record<string, unknown>,
  identity = readyIdentity,
) {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  let end!: (code: number) => void;
  let finished = false;
  let rejectCancel = false;
  let dropInit = false;
  let probeUuid: string | null = null;
  const counts = {
    opens: 0,
    probes: 0,
    bytes: 0,
    diagnostics: 0,
    cancels: 0,
    kills: 0,
    queries: 0,
    observations: 0,
    diagnosticMatchesProbe: false,
    cancellationOrder: [] as number[],
  };
  let baseline: () => void = () => undefined;
  let writer: () => void | Promise<void> = () => undefined;
  let errorPublication: (() => Promise<void>) | null = null;
  let onCancellation: () => void = () => undefined;
  const finish = () => {
    if (finished) return;
    finished = true;
    controller.enqueue(frame(4, new Uint8Array()));
    controller.enqueue(frame(5, new Uint8Array()));
    controller.enqueue(
      frame(11, encode({ kind: "signaled", signal: "SIGTERM" })),
    );
    controller.close();
    end(0);
  };
  const child = {
    stdin: {
      write(bytes: Uint8Array) {
        const opcode = bytes[0];
        const payload = bytes.slice(5);
        if (opcode === 20) {
          const id = payload.slice(0, 36);
          const data = payload.slice(36);
          const message = JSON.parse(new TextDecoder().decode(data));
          if (message.type === "user") {
            counts.probes++;
            counts.bytes += data.length;
            if (message.shouldQuery !== false) counts.queries++;
            probeUuid = message.uuid;
            if (!dropInit)
              controller.enqueue(
                frame(
                  2,
                  new TextEncoder().encode(
                    `${JSON.stringify(init(message.session_id))}\n`,
                  ),
                ),
              );
          } else {
            controller.enqueue(
              frame(
                2,
                new TextEncoder().encode(
                  `${JSON.stringify({ type: "control_response", response: { subtype: "success", request_id: message.request_id, response: { applied: { model: "claude-opus-4-6", effort: "high" } } } })}\n`,
                ),
              ),
            );
          }
          controller.enqueue(frame(6, id));
        } else if (opcode === 23) {
          counts.observations++;
          const request = JSON.parse(new TextDecoder().decode(payload));
          baseline();
          if (!finished)
            controller.enqueue(
              frame(
                14,
                encode({
                  protocolVersion: 2,
                  requestId: request.requestId,
                  observation: { status: "unavailable", reason: "unsupported" },
                }),
              ),
            );
        } else if (opcode === 22) {
          counts.cancels++;
          counts.cancellationOrder.push(22);
          onCancellation();
          controller.enqueue(frame(rejectCancel ? 10 : 9, payload));
          if (!rejectCancel) finish();
        } else if (opcode === 24) {
          counts.diagnostics++;
          counts.cancellationOrder.push(24);
          const request = JSON.parse(new TextDecoder().decode(payload));
          counts.diagnosticMatchesProbe =
            probeUuid !== null && request.request?.message_uuid === probeUuid;
        }
        return bytes.length;
      },
      flush: () => 0,
      end: () => 0,
    },
    stdout: new ReadableStream<Uint8Array>({
      start(c) {
        controller = c;
        c.enqueue(
          frame(1, new TextEncoder().encode(`{${identity},${fields}}`)),
        );
      },
      cancel() {
        finished = true;
        end(0);
      },
    }),
    stderr: new ReadableStream<Uint8Array>({
      start(c) {
        c.close();
      },
    }),
    exited: new Promise<number>((resolve) => {
      end = resolve;
    }),
    kill() {
      counts.kills++;
      if (!finished) finish();
      else end(0);
    },
  };
  const spawn = spyOn(Bun, "spawn").mockImplementation(() => {
    counts.opens++;
    return child as never;
  });
  const manager = new StreamedProcessManager({
    backendKind: lease.ref.backendKind,
    validate: (_ref, operation) => {
      if (operation === "write_streamed") return writer();
    },
  });
  let process: StreamedProcess | undefined;
  lease.spawnStreamed = async (command, options) => {
    process = await manager.spawn(
      lease.ref,
      lease.paths,
      command,
      options ?? {},
      async (context) => {
        const transport = await SbxStreamedProcessTransport.open({
          client: {
            executable: "/never-executed",
            streamLauncherArgs: () => [],
          } as never,
          sandboxName: "never-executed",
          processGeneration: context.processGeneration,
          command,
          relaySource: "never executed",
          markerPath: "/fixture/marker",
          expectedMarkerSha256: "marker",
          acknowledgementTimeoutMs: 100,
        });
        if (errorPublication) {
          // Scheduling hook only: retain the production frame reader/state and
          // delay delivery to the real manager, never replace capability reads.
          const run = transport.run.bind(transport);
          transport.run = (onEvent) =>
            run(async (event) => {
              if (event.kind === "transport_error") await errorPublication?.();
              await onEvent(event);
            });
        }
        return transport;
      },
    );
    return process;
  };
  return {
    counts,
    process: () => process,
    onBaseline: (fn: () => void) => {
      baseline = fn;
    },
    onWriter: (fn: () => void | Promise<void>) => {
      writer = fn;
    },
    delayErrorPublication: (fn: () => Promise<void>) => {
      errorPublication = fn;
    },
    onCancellation: (fn: () => void) => {
      onCancellation = fn;
    },
    emitLateReady: () =>
      controller.enqueue(frame(1, encode({ protocolVersion: 99 }))),
    emitMalformedFrame: () => {
      const header = new Uint8Array(5);
      header[0] = 2;
      new DataView(header.buffer).setUint32(1, 1024 * 1024 + 65);
      controller.enqueue(header);
    },
    finish,
    suppressInit: () => {
      dropInit = true;
    },
    rejectCancellation: () => {
      rejectCancel = true;
    },
    emitOutput: (value: Record<string, unknown>) => {
      if (!finished)
        controller.enqueue(
          frame(2, new TextEncoder().encode(`${JSON.stringify(value)}\n`)),
        );
    },
    async close() {
      await manager.shutdown();
      spawn.mockRestore();
    },
  };
}
