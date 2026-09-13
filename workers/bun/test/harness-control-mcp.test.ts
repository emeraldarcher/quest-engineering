import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { DispatchRegistry } from "../src/dispatch/registry.ts";
import {
  controlDescriptorPath,
  HarnessControlAuthority,
} from "../src/harnesses/control/authority.ts";
import { HARNESS_CONTROL_PATH_ENV } from "../src/harnesses/control/descriptor.ts";
import {
  QE_COMPLETE_STEP_TOOL,
  QE_MCP_STARTUP_EVIDENCE_ENV,
} from "../src/harnesses/control/mcp-server.ts";
import { collectStepResult } from "../src/harnesses/control/result-envelope.ts";
import { HarnessControlServer } from "../src/harnesses/control/server.ts";
import type { ExecuteAction } from "../src/protocol/types.ts";
import { action } from "./support.ts";

const mcpEntrypoint = resolve(
  import.meta.dir,
  "..",
  "src",
  "harnesses",
  "control",
  "mcp-server.ts",
);
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

async function fixture() {
  const parent = join(process.cwd(), ".pi", "tmp");
  await mkdir(parent, { recursive: true });
  const root = await mkdtemp(join(parent, "harness-mcp-"));
  const registry = new DispatchRegistry(
    join(root, "dispatches.sqlite"),
    root,
    "fake",
  );
  const authority = new HarnessControlAuthority(registry);
  const server = new HarnessControlServer(authority);
  await server.start();
  cleanups.push(async () => {
    await server.stop();
    registry.close();
    await rm(root, { recursive: true, force: true });
  });
  return { root, registry, authority };
}

async function bind(
  value: Awaited<ReturnType<typeof fixture>>,
  input: ExecuteAction,
) {
  const dispatch = value.registry.accept(input).dispatch;
  if (!dispatch.lineageId) throw new Error("fixture has no lineage");
  value.registry.occupy(dispatch.lineageId, input.action_id);
  const lineage = value.registry.getLineage(dispatch.lineageId);
  await value.authority.bind(dispatch, lineage);
  return { dispatch, lineage, descriptor: controlDescriptorPath(lineage) };
}

async function connect(descriptor: string, startupEvidence?: string) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [mcpEntrypoint],
    env: {
      ...stringEnvironment(process.env),
      [HARNESS_CONTROL_PATH_ENV]: descriptor,
      ...(startupEvidence
        ? { [QE_MCP_STARTUP_EVIDENCE_ENV]: startupEvidence }
        : {}),
    },
    stderr: "pipe",
  });
  const client = new Client({ name: "qe-mcp-test", version: "1.0.0" });
  await client.connect(transport);
  cleanups.push(() => client.close());
  return client;
}

test("generic MCP shim exposes semantic outputs without trusted identity arguments", async () => {
  const value = await fixture();
  const bound = await bind(value, action());
  const client = await connect(bound.descriptor);
  const tools = await client.listTools();
  expect(tools.tools.map((tool) => tool.name)).toEqual([QE_COMPLETE_STEP_TOOL]);
  const schema = tools.tools[0]?.inputSchema as {
    properties?: Record<string, unknown>;
  };
  expect(Object.keys(schema.properties ?? {})).toEqual(["outputs"]);
  expect(JSON.stringify(schema)).not.toMatch(
    /run_id|attempt_id|occurrence_id|lineage_id|nonce|generation/i,
  );

  const result = await client.callTool({
    name: QE_COMPLETE_STEP_TOOL,
    arguments: { outputs: { change_set: { files: 1 } } },
  });
  expect(result.isError).not.toBe(true);
  expect(result.structuredContent).toEqual({
    accepted: true,
    completed: true,
  });
  expect((await collectStepResult(bound.dispatch)).envelope.outputs).toEqual({
    change_set: { files: 1 },
  });
});

test("same static MCP command isolates concurrent session A and B environments", async () => {
  const value = await fixture();
  const first = await bind(
    value,
    action({
      action_id: "action-a",
      occurrence_id: "occurrence-a",
      attempt_id: "attempt-a",
    }),
  );
  const second = await bind(
    value,
    action({
      action_id: "action-b",
      occurrence_id: "occurrence-b",
      attempt_id: "attempt-b",
    }),
  );
  const evidenceA = join(value.root, "mcp-session-a.json");
  const evidenceB = join(value.root, "mcp-session-b.json");
  const [clientA, clientB] = await Promise.all([
    connect(first.descriptor, evidenceA),
    connect(second.descriptor, evidenceB),
  ]);
  expect(await Bun.file(evidenceA).json()).toMatchObject({
    descriptorPathHash: descriptorHash(first.descriptor),
    bridgeAcceptedContext: true,
  });
  expect(await Bun.file(evidenceB).json()).toMatchObject({
    descriptorPathHash: descriptorHash(second.descriptor),
    bridgeAcceptedContext: true,
  });

  await Promise.all([
    clientA.callTool({
      name: QE_COMPLETE_STEP_TOOL,
      arguments: { outputs: { change_set: "session-a" } },
    }),
    clientB.callTool({
      name: QE_COMPLETE_STEP_TOOL,
      arguments: { outputs: { change_set: "session-b" } },
    }),
  ]);

  expect((await collectStepResult(first.dispatch)).envelope.outputs).toEqual({
    change_set: "session-a",
  });
  expect((await collectStepResult(second.dispatch)).envelope.outputs).toEqual({
    change_set: "session-b",
  });
});

test("MCP child fails closed with absent or stale session context", async () => {
  const absent = Bun.spawn([process.execPath, mcpEntrypoint], {
    env: withoutControlEnvironment(process.env),
    stdout: "pipe",
    stderr: "pipe",
  });
  const absentStderr = new Response(absent.stderr).text();
  expect(await absent.exited).toBe(1);
  expect(await absentStderr).toContain(
    `${HARNESS_CONTROL_PATH_ENV} is missing`,
  );

  const value = await fixture();
  const bound = await bind(value, action());
  const stale = join(value.root, "stale-control.json");
  await writeFile(stale, await Bun.file(bound.descriptor).text());
  value.authority.invalidate(bound.lineage.lineageId);
  const staleChild = Bun.spawn([process.execPath, mcpEntrypoint], {
    env: {
      ...stringEnvironment(process.env),
      [HARNESS_CONTROL_PATH_ENV]: stale,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const staleStderr = new Response(staleChild.stderr).text();
  expect(await staleChild.exited).toBe(1);
  expect(await staleStderr).toContain("unknown_control_context");
});

function descriptorHash(path: string): string {
  return createHash("sha256").update(path).digest("hex");
}

function stringEnvironment(env: NodeJS.ProcessEnv): Record<string, string> {
  return Object.fromEntries(
    Object.entries(env).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
}

function withoutControlEnvironment(
  env: NodeJS.ProcessEnv,
): Record<string, string> {
  const value = stringEnvironment(env);
  delete value[HARNESS_CONTROL_PATH_ENV];
  return value;
}
