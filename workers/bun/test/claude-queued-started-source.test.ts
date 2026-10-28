import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import ts from "typescript";
import type { StreamedProcess } from "../src/execution-environment/types.ts";
import { claudeCodeCommand } from "../src/harnesses/claude-code/adapter.ts";
import { sendMessage } from "../src/harnesses/claude-code/protocol.ts";

// Source assertions, NOT execution of extracted vendor code. Missing optional
// local research artifact skips only native-source assertions; the QE wire test
// always runs. No SDK runtime, process launch, environment lease or account DB.
const artifact = new URL(
  "../../../.pi/tmp/claude-mods-reassessment/packages/linux-arm64/claude",
  import.meta.url,
);
const pinnedSha =
  "24caa9e6ff13bf227049a2626f1c816fc895023050f0ec3b12dbf14d897367e0";
// UTF-8 byte offsets/lengths in that exact artifact, not character offsets.
const segments = {
  "0025": [202911669, 122857],
  "0080": [204125418, 652226],
  "0149": [206314929, 236964],
  "0320": [210623439, 885],
  "0384": [210919888, 4677088],
  "0607": [219284037, 191802],
  "0619": [219548119, 77272],
  "0688": [220574923, 143285],
  "1488": [230893314, 125807],
  "1510": [231539207, 11004],
  "1691": [236443249, 56874],
  "1705": [236669218, 631314],
} as const;
type Segment = keyof typeof segments;
let binary: Buffer | undefined;
const parsed = new Map<Segment, ts.SourceFile>();
function moduleSource(segment: Segment) {
  let source = parsed.get(segment);
  if (source) return source;
  if (!binary) {
    binary = readFileSync(artifact);
    expect(createHash("sha256").update(binary).digest("hex")).toBe(pinnedSha);
  }
  const [offset, length] = segments[segment];
  source = ts.createSourceFile(
    `segment-${segment}.js`,
    binary.subarray(offset, offset + length).toString("utf8"),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS,
  );
  // Public TS types omit this parser-only diagnostic property.
  expect(
    (source as ts.SourceFile & { parseDiagnostics: readonly unknown[] })
      .parseDiagnostics,
  ).toHaveLength(0);
  parsed.set(segment, source);
  return source;
}
function declaration(segment: Segment, name: string) {
  const source = moduleSource(segment);
  for (const statement of source.statements) {
    if (
      (ts.isFunctionDeclaration(statement) ||
        ts.isClassDeclaration(statement)) &&
      statement.name?.text === name
    )
      return statement.getText(source);
    if (ts.isVariableStatement(statement))
      for (const node of statement.declarationList.declarations)
        if (ts.isIdentifier(node.name) && node.name.text === name)
          return node.getText(source);
  }
  throw new Error(`Missing pinned source declaration ${segment}/${name}`);
}
function ordered(source: string, needles: string[]) {
  let cursor = -1;
  for (const needle of needles) {
    cursor = source.indexOf(needle, cursor + 1);
    expect(cursor, `source anchor ${needle}`).toBeGreaterThanOrEqual(0);
  }
}
const sourceTest = test.skipIf(!existsSync(artifact));

test("QE false-query wire is one complete 301-byte LF-delimited user frame", async () => {
  const writes: Uint8Array[] = [];
  const process = {
    write: async (bytes: Uint8Array) => {
      writes.push(bytes);
      return {
        certainty: "acknowledged" as const,
        byteLength: bytes.byteLength,
        writeId: "synthetic-write",
      };
    },
  } as unknown as StreamedProcess;
  const session = "11111111-1111-4111-8111-111111111111";
  await sendMessage(
    process,
    session,
    "Quest Engineering fixed zero-inference initialization probe.",
    false,
  );
  expect(writes).toHaveLength(1);
  const bytes = writes[0];
  expect(bytes?.byteLength).toBe(301);
  const wire = new TextDecoder().decode(bytes);
  expect(wire.endsWith("\n")).toBe(true);
  expect(wire.split("\n")).toHaveLength(2);
  const frame = JSON.parse(wire);
  expect(Object.keys(frame)).toEqual([
    "type",
    "message",
    "parent_tool_use_id",
    "session_id",
    "uuid",
    "client_composed",
    "shouldQuery",
    "isSynthetic",
  ]);
  expect(frame.type).toBe("user");
  expect(frame.message).toEqual({
    role: "user",
    content: "Quest Engineering fixed zero-inference initialization probe.",
  });
  expect(frame.parent_tool_use_id).toBeNull();
  expect(frame.session_id).toBe(session);
  expect(frame.uuid).toMatch(
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
  );
  expect(frame.client_composed).toBe(true);
  expect(frame.shouldQuery).toBe(false);
  expect(frame.isSynthetic).toBe(true);
});

test("QE does not request SDK startup-initialize or spare-claim mode", () => {
  const command = claudeCodeCommand(
    { configRoot: "/synthetic/config", cwd: "/synthetic/empty-cwd" },
    "11111111-1111-4111-8111-111111111111",
    false,
    "/synthetic/mailbox",
    "synthetic-bridge-token",
  );
  const encoded = JSON.stringify(command);
  expect(encoded).not.toContain("--await-initialize");
  expect(encoded).not.toContain("--await-claim");
});

sourceTest(
  "native user schema admits every QE root field and false-query boolean",
  () => {
    const schema = declaration("0080", "Jw");
    for (const key of [
      "type:",
      "message:",
      "parent_tool_use_id:",
      "client_composed:",
      "shouldQuery:",
      "isSynthetic:",
    ])
      expect(schema).toContain(key);
    expect(schema).toContain("shouldQuery:M().optional()");
    expect(schema).toContain("parent_tool_use_id:o().nullable()");
    const extended = declaration("0080", "tr");
    expect(extended).toContain("uuid:");
    expect(extended).toContain("session_id:");
  },
);

sourceTest(
  "queued follows admission and actual enqueue, before explicit kick",
  () => {
    const intake = declaration("1705", "Lm");
    ordered(intake, [
      "async deliver(",
      "e.admit(n)",
      "this.messageQueue.enqueue(E)",
      'this.io.onCommandLifecycle?.(h.uuid,"queued")',
      "this.kick()",
    ]);
    expect(intake).toContain("h.uuid!==void 0");
  },
);

sourceTest(
  "native intake copies false-query and resolves default initialization before accept",
  () => {
    const intake = declaration("1705", "IF");
    ordered(intake, [
      "Lo.resolve()",
      'if(x.type!=="user")',
      "Y(!0)",
      "shouldQuery:x.shouldQuery",
      "Mn.acceptUserFrame(",
    ]);
    expect(intake).toContain("skipSlashCommands:!0");
    expect(intake).toContain("So=()=>Gc.run().catch(uh)");
  },
);

sourceTest("queue eligibility does not exclude shouldQuery false", () => {
  const predicate = declaration("0384", "Pm");
  expect(predicate).not.toContain("shouldQuery");
  expect(predicate).toContain("passive");
});

sourceTest("dequeue is before first-command joins, commit, and started", () => {
  ordered(declaration("1705", "zm"), [
    "X.waitForHead(",
    "let ge=ae.take()",
    "n.firstCommand()",
    "n.turnMountJoin",
    "n.sdkMcpServersJoin",
    "n.deferredMcpServersJoin",
    "n.wireTurn()",
    "ae.commit(ge)",
    "ae.start(Tt)",
    "this.turnRunner.arm(Tt)",
    "n.afterArm",
    "this.turnGate?.beforeTurn",
    "this.turnRunner.run(",
  ]);
});

sourceTest(
  "started producer is the ledger start, not successful init or engine dispatch",
  () => {
    expect(declaration("1705", "Vm")).toContain(
      "this.deliveryLedger.startBatch(e.uuids)",
    );
    expect(declaration("1705", "wm")).toContain(
      'this.io.onCommandLifecycle?.(r,"started")',
    );
  },
);

sourceTest(
  "entry joins include local SDK-MCP update, skills and plugin waits",
  () => {
    const joins = declaration("1705", "pp");
    ordered(joins, [
      "*beforeDrain()",
      "this.deferredCommandsJoin",
      "this.parkedPermissionRetirement()",
      "this.updateSdkMcp()",
      "this.takeClaimSessionStartHooks()",
      "if(this.skillsSync)",
      "this.pluginStartupPending()",
      "this.takeNewPluginsSessionStart()",
    ]);
    ordered(joins, [
      "*firstCommand()",
      "this.pendingPluginRefresh()",
      "this.mcpPrewaitPromise",
      "this.firstCommandMountJoin(",
    ]);
  },
);

sourceTest(
  "Mod session-start is a separate queue-head gate with queue notification wakeup",
  () => {
    expect(declaration("0607", "K4")).toContain("pK.get()?U6.get():void 0");
    const gate = declaration("1705", "uu");
    expect(gate).toContain("this.messageQueue.peek(Gm)===void 0");
    expect(declaration("1705", "Gm")).toContain("Pm(e)&&vAe(e.uuid)");
    expect(gate).toContain("await TC(this.messageQueue,n),n=K4()");
    expect(declaration("1705", "TC")).toContain("subscribe(");
    const start = declaration("1488", "Sn");
    expect(start).toContain("{loaded:e,surface:n,isInteractive:r}");
    expect(start).toContain("await Promise.resolve(e).catch(");
    expect(start).toContain("RZ().session.start(");
  },
);

sourceTest(
  "false-query skips the SDK-specific first-query join, not every startup join",
  () => {
    const join = declaration("1705", "mp");
    expect(join).toContain("e.shouldQuery===!1");
    expect(join).toContain("!this.sdkUrl");
    expect(declaration("1705", "pp")).not.toContain("shouldQuery");
  },
);

sourceTest(
  "normal false-query emits init before zero-turn success and before model enqueue",
  () => {
    const engine = declaration("1705", "Pv");
    ordered(engine, [
      "if(!xa)",
      "await us(bo,os,$n.fastMode)",
      "yield Fe",
      "if(!Ur)",
      "num_turns:0",
      "return",
      "be.enqueue(",
    ]);
    expect(engine).toContain("Ur=Te&&Le?.shouldQuery!==!1");
    expect(engine).toContain("Le?.shouldQuery===!1?void 0:await rdt(");
  },
);

sourceTest(
  "host cancel distinguishes queued removal from pending cancellation without dequeuing",
  () => {
    const cancel = declaration("1705", "Bp");
    ordered(cancel, [
      "n.isFoldInFlight(e)",
      "n.dequeueAllMatching(",
      'case"host":n.markCancelPending(e)',
      'g.onCommandLifecycle?.(S.uuid,"cancelled")',
    ]);
    expect(cancel).toContain("return h.length>0||E");
  },
);

sourceTest("pending cancellation is consumed again at pre-start commit", () => {
  ordered(declaration("1705", "Vm"), [
    "commit(e)",
    "this.messageQueue.consumeCancelPending(n.uuid)",
    'this.io.onCommandLifecycle?.(s.uuid,"cancelled")',
  ]);
});

sourceTest(
  "SIGTERM shutdown does not promise a native cancelled lifecycle frame",
  () => {
    expect(declaration("1705", "IF")).toContain(
      "jY(),_hn(),Qr.abort(),Qn(143)",
    );
    expect(declaration("1705", "zm")).toContain(
      "this.deliveryLedger.freezeTerminals()",
    );
    expect(declaration("1705", "wm")).toContain(
      'this.frozen&&(r==="completed"||r==="cancelled")',
    );
  },
);

sourceTest(
  "native hook budget is not an end-to-end ten-second wall-clock proof",
  () => {
    expect(declaration("0149", "Rhe")).toContain("1e4");
    expect(declaration("0149", "zt")).toContain("a.pause()");
    expect(declaration("0149", "sx")).toContain("e.budgetMs??n");
  },
);

sourceTest("native MCP default budgets are not QE readiness budgets", () => {
  expect(declaration("0320", "TMe")).toContain(":5000");
  expect(declaration("0320", "Xie")).toContain("2000");
});

sourceTest(
  "startup initialize and spare claim are conditional launch modes",
  () => {
    const launch = declaration("0688", "cxr");
    expect(launch).toContain("if(o.awaitInitialize)");
    expect(launch).toContain("if(o.awaitClaim)");
    expect(declaration("0080", "fJ")).toContain("initialize is optional");
    expect(declaration("0080", "fJ")).toContain(
      "first user message initializes with defaults",
    );
  },
);

sourceTest(
  "discarded and refused select inbound shutdown versus rejection",
  () => {
    expect(declaration("1705", "_T")).toContain('XOr()?"discarded":"refused"');
    expect(declaration("1510", "XOr")).toContain("Di().inbound.shuttingDown");
    ordered(declaration("1705", "_F"), ["await zDt()", "XS("]);
    expect(declaration("1705", "XS")).toContain(
      'r.onCommandLifecycle?.(s.uuid,"discarded")',
    );
  },
);

sourceTest(
  "normal terminal state chooses cancelled only for aborted/cancel reason",
  () => {
    expect(declaration("0619", "$Bn")).toContain(
      's||dDn(e)?"cancelled":"completed"',
    );
    expect(declaration("1705", "wm")).toContain('r.includes(w)?"completed":g');
  },
);
