import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { HerdrSocketClient } from "../src/session-host/herdr/client.ts";
import {
  evaluateHerdrCompatibility,
  HERDR_TESTED_PROTOCOL,
  type HerdrCompatibilityEvidence,
} from "../src/session-host/herdr/compatibility.ts";
import { LocalHerdrConnectionProvider } from "../src/session-host/herdr/connection.ts";
import {
  canonicalSessionDirectory,
  claimOwnerMarker,
  type HerdrSessionOwnershipRecord,
  writeOwnershipRecord,
} from "../src/session-host/herdr/ownership.ts";

const OPERATIONS = [
  "ping",
  "session.snapshot",
  "workspace.report_metadata",
  "workspace.create",
  "tab.create",
  "tab.rename",
  "pane.report_metadata",
  "pane.process_info",
  "agent.start",
  "agent.prompt",
  "agent.get",
  "agent.send_keys",
  "agent.wait",
  "integration.list",
];

const STATES = ["idle", "working", "blocked", "done", "unknown"];
const PARAMETERS: Record<string, string[]> = {
  "workspace.report_metadata": ["workspace_id", "source", "tokens"],
  "workspace.create": ["cwd", "label", "focus", "env"],
  "tab.create": ["workspace_id", "cwd", "label", "focus", "env"],
  "tab.rename": ["tab_id", "label"],
  "pane.report_metadata": [
    "pane_id",
    "source",
    "title",
    "display_agent",
    "tokens",
  ],
  "pane.process_info": ["pane_id"],
  "agent.start": ["pane_id", "name", "kind", "args", "timeout_ms"],
  "agent.prompt": ["target", "text", "wait"],
  "agent.get": ["target"],
  "agent.send_keys": ["target", "keys"],
  "agent.wait": ["target", "until", "timeout_ms"],
};
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

test("protocol 22 is ready because its endpoint and capability contract pass", () => {
  const readiness = evaluateHerdrCompatibility("pi", evidence(22));
  expect(readiness).toMatchObject({
    status: "ready",
    ready: true,
    missingCapabilities: [],
    provenance: {
      protocol: 22,
      testedProtocol: HERDR_TESTED_PROTOCOL,
      endpointGeneration: 1,
    },
  });
  expect(readiness.diagnostics).toEqual([]);
});

test("protocol 999 remains ready when the verified contract is complete", () => {
  const readiness = evaluateHerdrCompatibility("pi", evidence(999));
  expect(readiness.ready).toBe(true);
  expect(readiness.status).toBe("ready");
  expect(readiness.diagnostics).toContainEqual({
    code: "newer_than_tested_but_compatible",
    message:
      "Herdr protocol 999 is newer than QE's tested protocol 22; the required capability contract passed.",
  });
});

test("protocol 999 missing a Pi-only capability disables Pi but not Antigravity", () => {
  const value = evidence(999, {
    operations: OPERATIONS.filter((operation) => operation !== "agent.wait"),
  });
  const pi = evaluateHerdrCompatibility("pi", value);
  const antigravity = evaluateHerdrCompatibility("antigravity", value);

  expect(pi.ready).toBe(false);
  expect(pi.missingCapabilities).toContain("agent.state_observation");
  expect(pi.diagnostics).toContainEqual(
    expect.objectContaining({
      code: "missing_capability",
      capability: "agent.state_observation",
      message: expect.stringContaining("agent.wait"),
    }),
  );
  expect(antigravity.ready).toBe(true);
});

test("protocol 999 with an incompatible operation contract names the semantic capability", () => {
  const value = evidence(999, {
    missingParameter: ["agent.prompt", "wait"],
  });
  const readiness = evaluateHerdrCompatibility("pi", value);
  expect(readiness.ready).toBe(false);
  expect(readiness.missingCapabilities).toContain("agent.prompt");
  expect(readiness.diagnostics).toContainEqual(
    expect.objectContaining({
      capability: "agent.prompt",
      message: expect.stringContaining("agent.prompt.wait"),
    }),
  );
});

test("protocol 999 missing a shared prompt capability fails both harnesses", () => {
  const value = evidence(999, {
    operations: OPERATIONS.filter((operation) => operation !== "agent.prompt"),
  });
  for (const harness of ["pi", "antigravity"]) {
    const readiness = evaluateHerdrCompatibility(harness, value);
    expect(readiness.ready).toBe(false);
    expect(readiness.missingCapabilities).toContain("agent.prompt");
    expect(readiness.diagnostics).toContainEqual(
      expect.objectContaining({
        capability: "agent.prompt",
        message: expect.stringContaining("agent.prompt"),
      }),
    );
  }
});

test("protocol 999 missing required response metadata fails the affected capability", () => {
  const incomplete = evidence(999);
  const schemas = incomplete.schema.schemas as {
    success_response: {
      $defs: { AgentInfo: { properties: Record<string, unknown> } };
    };
  };
  delete schemas.success_response.$defs.AgentInfo.properties.interactive_ready;

  for (const harness of ["pi", "antigravity"]) {
    const readiness = evaluateHerdrCompatibility(harness, incomplete);
    expect(readiness.ready).toBe(false);
    expect(readiness.missingCapabilities).toContain("agent.interactive_launch");
    expect(readiness.diagnostics).toContainEqual(
      expect.objectContaining({ capability: "agent.interactive_launch" }),
    );
  }
});

test("launch readiness requires metadata that distinguishes pending materialization", () => {
  const incomplete = evidence(22);
  const schemas = incomplete.schema.schemas as {
    success_response: {
      $defs: { AgentInfo: { properties: Record<string, unknown> } };
    };
  };
  delete schemas.success_response.$defs.AgentInfo.properties.launch_pending;

  for (const harness of ["pi", "antigravity"]) {
    const readiness = evaluateHerdrCompatibility(harness, incomplete);
    expect(readiness.ready).toBe(false);
    expect(readiness.missingCapabilities).toContain("agent.interactive_launch");
  }
});

test("old endpoint fails for its generation contract rather than its protocol number", () => {
  const old = evidence(20, { endpointGeneration: 0 });
  const readiness = evaluateHerdrCompatibility("pi", old);
  expect(readiness.ready).toBe(false);
  expect(readiness.diagnostics).toContainEqual(
    expect.objectContaining({
      code: "endpoint_generation_unsupported",
      capability: "backend.endpoint_generation_1",
    }),
  );

  // Numeric age is not itself an incompatibility rule.
  expect(evaluateHerdrCompatibility("pi", evidence(1)).ready).toBe(true);
});

test("an older endpoint missing required lifecycle behavior fails that contract", () => {
  const readiness = evaluateHerdrCompatibility(
    "antigravity",
    evidence(20, { states: STATES.filter((state) => state !== "blocked") }),
  );
  expect(readiness.ready).toBe(false);
  expect(readiness.missingCapabilities).toContain("lifecycle.canonical_states");
  expect(readiness.diagnostics).toContainEqual(
    expect.objectContaining({
      capability: "lifecycle.canonical_states",
      message: expect.stringContaining("blocked"),
    }),
  );
});

test("readiness fences a stale observation failure after newer success and revalidates new server generations", async () => {
  const parent = join(process.cwd(), ".pi", "tmp");
  await mkdir(parent, { recursive: true });
  const root = await mkdtemp(join(parent, "herdr-generation-"));
  roots.push(root);
  const socket = join(root, "herdr.sock");
  await writeFile(socket, "generation-one");
  let pingCalls = 0;
  const invalidations: Array<() => void> = [];
  const status = {
    running: true,
    session: "test-herdr",
    socket,
    version: "test-herdr",
    protocol: 999,
    compatible: true,
    endpoint_compatible: true,
    capabilities: { endpoint_protocol_generation: 1 },
  };
  const directory = await canonicalSessionDirectory(root);
  const timestamp = new Date().toISOString();
  const ownership: HerdrSessionOwnershipRecord = {
    version: 1,
    state: "active",
    workerId: "test-worker",
    sessionName: "test-herdr",
    sessionIncarnation: "test-incarnation",
    sessionDirectory: directory.path,
    sessionDirectoryIdentity: directory.identity,
    ownershipWorkspaceId: null,
    serverGeneration: null,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  await writeOwnershipRecord(
    join(root, "herdr-session-ownership.json"),
    ownership,
  );
  await claimOwnerMarker(root, ownership);
  const provider = new LocalHerdrConnectionProvider("test-herdr", {
    workerId: "test-worker",
    dataRoot: root,
    runCommand: async (args) => ({
      exitCode: 0,
      stdout: JSON.stringify(
        args.includes("schema")
          ? schema(OPERATIONS, STATES)
          : args.includes("list")
            ? {
                sessions: [
                  {
                    name: "test-herdr",
                    running: true,
                    session_dir: root,
                    socket_path: socket,
                  },
                ],
              }
            : status,
      ),
      stderr: "",
    }),
    createClient: (_socket, onUnavailable) => {
      invalidations.push(onUnavailable);
      return new ReadinessProbeClient(() => {
        pingCalls += 1;
      });
    },
  });

  expect((await provider.readiness("pi")).ready).toBe(true);
  expect((await provider.readiness("antigravity")).ready).toBe(true);
  expect(pingCalls).toBe(1);

  invalidations[0]?.();
  expect((await provider.readiness("pi")).ready).toBe(true);
  expect(pingCalls).toBe(2);

  // A delayed timeout/error callback from the older probe cannot erase the
  // newer successful compatibility observation.
  invalidations[0]?.();
  expect((await provider.readiness("pi")).ready).toBe(true);
  expect(pingCalls).toBe(2);

  await rm(socket);
  await Bun.sleep(2);
  await writeFile(socket, "generation-two");
  expect((await provider.readiness("pi")).ready).toBe(true);
  expect(pingCalls).toBe(3);
});

test("malformed harness integration metadata disables only that harness", () => {
  const value = evidence(999, {
    integrations: [
      { target: "pi", malformed: true },
      {
        target: "antigravity_cli",
        available: true,
        state: "current",
      },
    ],
  });
  const pi = evaluateHerdrCompatibility("pi", value);
  const antigravity = evaluateHerdrCompatibility("antigravity", value);
  expect(pi).toMatchObject({
    ready: false,
    missingCapabilities: ["integration.pi.current"],
  });
  expect(pi.diagnostics).toContainEqual(
    expect.objectContaining({
      code: "malformed_contract",
      capability: "integration.pi.current",
    }),
  );
  expect(antigravity.ready).toBe(true);
});

function evidence(
  protocol: number,
  overrides: {
    endpointGeneration?: number;
    operations?: string[];
    states?: string[];
    integrations?: HerdrCompatibilityEvidence["integrations"];
    missingParameter?: [string, string];
  } = {},
): HerdrCompatibilityEvidence {
  const endpointGeneration = overrides.endpointGeneration ?? 1;
  return {
    status: {
      running: true,
      version: "test-herdr",
      protocol,
      compatible: true,
      endpoint_compatible: true,
      capabilities: {
        endpoint_protocol_generation: endpointGeneration,
      },
    },
    schema: schema(
      overrides.operations ?? OPERATIONS,
      overrides.states ?? STATES,
      overrides.missingParameter,
    ),
    ping: {
      version: "test-herdr",
      protocol,
      endpointGeneration,
    },
    snapshot: { workspaces: [], panes: [], agents: [] },
    integrations: overrides.integrations ?? [
      { target: "pi", available: true, state: "current" },
      {
        target: "antigravity_cli",
        available: true,
        state: "current",
      },
    ],
    serverGeneration: `generation-${protocol}`,
  };
}

class ReadinessProbeClient extends HerdrSocketClient {
  constructor(private readonly onPing: () => void = () => undefined) {
    super("unused-test-socket");
  }
  override async ping() {
    this.onPing();
    return {
      version: "test-herdr",
      protocol: 999,
      endpointGeneration: 1,
    };
  }
  override async snapshot() {
    return { workspaces: [], panes: [], agents: [] };
  }
  override async integrations() {
    return [
      { target: "pi", available: true, state: "current" },
      {
        target: "antigravity_cli",
        available: true,
        state: "current",
      },
    ];
  }
}

function schema(
  operations: string[],
  states: string[],
  missingParameter?: [string, string],
) {
  return {
    protocol: 999,
    schema_version: 1,
    schemas: {
      request: {
        oneOf: operations.map((operation) => ({
          properties: {
            method: { const: operation },
            params: {
              properties: Object.fromEntries(
                (PARAMETERS[operation] ?? [])
                  .filter(
                    (parameter) =>
                      operation !== missingParameter?.[0] ||
                      parameter !== missingParameter[1],
                  )
                  .map((parameter) => [
                    parameter,
                    { type: "unknown-for-fixture" },
                  ]),
              ),
            },
          },
        })),
      },
      success_response: {
        $defs: {
          AgentStatus: { enum: states },
          SessionSnapshot: {
            properties: {
              workspaces: {},
              panes: {},
              agents: {},
            },
          },
          WorkspaceInfo: {
            properties: {
              workspace_id: {},
              tokens: {},
            },
          },
          PaneInfo: {
            properties: {
              workspace_id: {},
              tab_id: {},
              pane_id: {},
            },
          },
          AgentInfo: {
            properties: {
              agent: {},
              agent_status: {},
              interactive_ready: {},
              launch_pending: {},
              name: {},
              pane_id: {},
              workspace_id: {},
            },
          },
          PaneProcessInfo: {
            properties: {
              shell_pid: {},
              foreground_process_group_id: {},
            },
          },
          IntegrationInfo: {
            properties: {
              target: {},
              available: {},
              state: {},
            },
          },
        },
      },
    },
  };
}
