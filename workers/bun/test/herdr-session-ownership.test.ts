import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  assertHerdrDefaultSocketPathSafe,
  defaultHerdrSessionName,
  HERDR_UNIX_SOCKET_SAFE_PATH_BYTES,
  herdrDefaultSocketPaths,
  loadConfig,
  type WorkerConfig,
} from "../src/config.ts";
import { FakeHarness } from "../src/harnesses/fake/adapter.ts";
import {
  HerdrApiError,
  HerdrSocketClient,
} from "../src/session-host/herdr/client.ts";
import type { HerdrIntegrationEvidence } from "../src/session-host/herdr/compatibility.ts";
import { LocalHerdrConnectionProvider } from "../src/session-host/herdr/connection.ts";
import {
  ownerMarkerPath,
  readOwnershipRecord,
} from "../src/session-host/herdr/ownership.ts";
import { HerdrTerminalBackend } from "../src/session-host/herdr/session-host.ts";
import type { HostedSnapshot } from "../src/session-host/types.ts";
import { QuestEngineeringWorker } from "../src/worker.ts";

const roots: string[] = [];
const runtimes: FakeHerdrRuntime[] = [];
afterEach(async () => {
  for (const runtime of runtimes.splice(0)) runtime.shutdown();
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

test("readiness is side-effect free, then zero-session ensure creates infrastructure once", async () => {
  const fixture = await setup("worker-a");
  const before = await fixture.provider.readiness("pi");
  expect(before).toMatchObject({ ready: false, status: "unavailable" });
  expect(fixture.runtime.starts).toBe(0);
  expect(fixture.runtime.snapshot()).toEqual({
    workspaces: [],
    panes: [],
    agents: [],
  });
  expect(fixture.runtime.executionMutations).toBe(0);
  expect(
    await readOwnershipRecord(
      join(fixture.root, "herdr-session-ownership.json"),
      "absent readiness ownership",
    ),
  ).toBeNull();

  const [first, concurrent] = await Promise.all([
    fixture.provider.ensureInfrastructure(),
    fixture.provider.ensureInfrastructure(),
  ]);
  expect(concurrent).toEqual(first);
  expect(fixture.runtime.starts).toBe(1);
  expect(fixture.runtime.infrastructureBootstraps).toBe(1);
  expect(fixture.runtime.snapshot()).toMatchObject({
    workspaces: [{ workspaceId: "w1" }],
    panes: [{ paneId: "w1:p1" }],
    agents: [],
  });
  expect(fixture.runtime.executionMutations).toBe(0);
  expect((await fixture.provider.readiness("pi")).ready).toBe(true);
  expect((await fixture.provider.readiness("antigravity")).ready).toBe(true);

  const primary = await readOwnershipRecord(
    join(fixture.root, "herdr-session-ownership.json"),
    "test primary ownership",
  );
  const marker = await readOwnershipRecord(
    ownerMarkerPath(fixture.runtime.sessionDirectory),
    "test session marker",
  );
  expect(primary).toMatchObject({
    state: "active",
    workerId: "worker-a",
    sessionName: fixture.sessionName,
    sessionIncarnation: first.sessionIncarnation,
  });
  expect(marker).toMatchObject({
    workerId: primary?.workerId,
    sessionIncarnation: primary?.sessionIncarnation,
  });
  expect(fixture.runtime.workspaceTokens).toMatchObject({
    qe_worker_id: "worker-a",
    qe_session_incarnation: first.sessionIncarnation,
  });
});

test("long valid Worker IDs use collision-resistant bounded live ownership metadata", async () => {
  const workerId = `worker-${"x".repeat(121)}`;
  expect(Buffer.byteLength(workerId)).toBe(128);
  const fixture = await setup(workerId);

  const identity = await fixture.provider.ensureInfrastructure();
  expect(fixture.runtime.workspaceTokens.qe_worker_id).toBe(
    `sha256:${createHash("sha256").update(workerId).digest("hex")}`,
  );
  expect(
    Buffer.byteLength(fixture.runtime.workspaceTokens.qe_worker_id ?? ""),
  ).toBeLessThanOrEqual(80);
  expect(
    (
      await readOwnershipRecord(
        join(fixture.root, "herdr-session-ownership.json"),
        "long Worker ownership",
      )
    )?.workerId,
  ).toBe(workerId);
  expect(identity.sessionIncarnation).toBe("incarnation-1");
});

test("a transient first protocol close reconciles the exact started server without duplication", async () => {
  const fixture = await setup("worker-startup-reconcile");
  fixture.runtime.readinessConnectionFailures = 1;

  const identity = await fixture.provider.ensureInfrastructure();
  expect(identity.sessionIncarnation).toBe("incarnation-1");
  expect(fixture.runtime.starts).toBe(1);
  expect(fixture.runtime.pings).toBeGreaterThanOrEqual(2);
});

test("native startup exit diagnostics distinguish process failure from a generic socket close", async () => {
  const fixture = await setup("worker-native-exit");
  fixture.runtime.nativeExitOnReadiness = true;

  await expect(fixture.provider.ensureInfrastructure()).rejects.toMatchObject({
    code: "backend_unavailable",
    capability: "backend.session_lifecycle",
    message: expect.stringContaining("native server exited with status 1"),
  });
  await expect(fixture.provider.ensureInfrastructure()).rejects.toThrow(
    "native socket path failure",
  );
  expect(fixture.runtime.starts).toBe(2);
});

test("concurrent ensures for the same Worker converge on one physical claim", async () => {
  const fixture = await setup("worker-race");
  const first = fixture.providerForWorker(
    "worker-race",
    () => "incarnation-first",
  );
  const second = fixture.providerForWorker(
    "worker-race",
    () => "incarnation-second",
  );

  const [left, right] = await Promise.all([
    first.ensureInfrastructure(),
    second.ensureInfrastructure(),
  ]);
  expect(left.sessionIncarnation).toBe("incarnation-first");
  expect(right).toEqual(left);
  expect(second.sessionIncarnation()).toBe("incarnation-first");
  expect(fixture.runtime.starts).toBe(1);
});

test("a Worker restart adopts the matching running or stopped physical session", async () => {
  const fixture = await setup("worker-restart");
  const first = await fixture.provider.ensureInfrastructure();
  const restarted = fixture.providerForWorker("worker-restart");
  const adopted = await restarted.ensureInfrastructure();
  expect(adopted.sessionIncarnation).toBe(first.sessionIncarnation);
  expect(fixture.runtime.starts).toBe(1);

  fixture.runtime.stop();
  const afterStop = await restarted.ensureInfrastructure();
  expect(afterStop.sessionIncarnation).toBe(first.sessionIncarnation);
  expect(fixture.runtime.starts).toBe(2);
});

test("a different Worker cannot adopt an owned same-name session", async () => {
  const fixture = await setup("worker-owner");
  await fixture.provider.ensureInfrastructure();

  await expect(
    fixture.providerForWorker("worker-intruder").ensureInfrastructure(),
  ).rejects.toMatchObject({
    code: "backend_incompatible",
    capability: "backend.session_ownership",
  });
  expect(fixture.runtime.starts).toBe(1);
});

test("a missing owner marker is repaired only from matching primary directory identity", async () => {
  const fixture = await setup("worker-marker-repair");
  const original = await fixture.provider.ensureInfrastructure();
  await rm(ownerMarkerPath(fixture.runtime.sessionDirectory));

  const restarted = fixture.providerForWorker("worker-marker-repair");
  const repaired = await restarted.ensureInfrastructure();
  expect(repaired.sessionIncarnation).toBe(original.sessionIncarnation);
  expect(
    await readOwnershipRecord(
      ownerMarkerPath(fixture.runtime.sessionDirectory),
      "repaired marker",
    ),
  ).toMatchObject({
    workerId: "worker-marker-repair",
    sessionIncarnation: original.sessionIncarnation,
  });
});

test("conflicting live ownership metadata fails closed", async () => {
  const fixture = await setup("worker-live-conflict");
  await fixture.provider.ensureInfrastructure();
  fixture.runtime.workspaceTokens.qe_worker_id = "another-worker";

  expect(await fixture.provider.readiness("pi")).toMatchObject({
    ready: false,
    status: "incompatible",
    missingCapabilities: ["backend.session_ownership"],
  });
  await expect(fixture.provider.ensureInfrastructure()).rejects.toMatchObject({
    code: "backend_incompatible",
    capability: "backend.session_ownership",
  });
});

test("disconnect preserves the owned Herdr session for restart recovery", async () => {
  const fixture = await setup("worker-shutdown");
  const identity = await fixture.provider.ensureInfrastructure();
  const host = new HerdrTerminalBackend(fixture.provider, "pi");
  await host.snapshot();
  host.disconnect();

  expect(fixture.runtime.running).toBe(true);
  expect(fixture.runtime.starts).toBe(1);
  expect(
    (await fixture.providerForWorker("worker-shutdown").ensureInfrastructure())
      .sessionIncarnation,
  ).toBe(identity.sessionIncarnation);
});

test("a stale snapshot timeout resolves to a newer successful observation", async () => {
  const newer: HostedSnapshot = {
    workspaces: [],
    panes: [],
    agents: [],
  };
  let rejectOlder: (error: Error) => void = () => undefined;
  const older = new Promise<HostedSnapshot>((_resolve, reject) => {
    rejectOlder = reject;
  });
  let connections = 0;
  const provider = {
    sessionName: "test-herdr",
    sessionIncarnation: () => "incarnation-1",
    connect: async () => ({
      client: new SnapshotClient(connections++ === 0 ? older : newer),
    }),
  } as unknown as LocalHerdrConnectionProvider;
  const host = new HerdrTerminalBackend(provider, "pi");

  const staleObservation = host.snapshot();
  await Promise.resolve();
  expect(await host.snapshot()).toBe(newer);
  rejectOlder(
    new HerdrApiError(
      "timeout",
      "Herdr request timed out: session.snapshot",
      "session.inventory",
    ),
  );

  expect(await staleObservation).toBe(newer);
});

test("deleting the owned Herdr session creates a new physical incarnation", async () => {
  const fixture = await setup("worker-reset");
  const first = await fixture.provider.ensureInfrastructure();
  await fixture.runtime.deleteSession();

  const recreated = await fixture.provider.ensureInfrastructure();
  expect(recreated.sessionIncarnation).not.toBe(first.sessionIncarnation);
  expect(fixture.runtime.starts).toBe(2);
  expect(fixture.runtime.executionMutations).toBe(0);
  expect(fixture.runtime.workspaceTokens.qe_session_incarnation).toBe(
    recreated.sessionIncarnation,
  );
});

test("a server/socket generation change revalidates compatibility without changing ownership", async () => {
  const fixture = await setup("worker-generation");
  const first = await fixture.provider.ensureInfrastructure();
  const pingBefore = fixture.runtime.pings;
  await fixture.runtime.replaceSocket();

  const revalidated = await fixture.provider.ensureInfrastructure();
  expect(revalidated.sessionIncarnation).toBe(first.sessionIncarnation);
  expect(revalidated.serverGeneration).not.toBe(first.serverGeneration);
  expect(fixture.runtime.pings).toBeGreaterThan(pingBefore);
});

test("an existing same-name session without matching durable ownership fails closed", async () => {
  const fixture = await setup("worker-foreign");
  fixture.runtime.createForeignSession();

  await expect(fixture.provider.ensureInfrastructure()).rejects.toMatchObject({
    code: "backend_incompatible",
    capability: "backend.session_ownership",
  });
  expect(fixture.runtime.starts).toBe(0);
  expect(fixture.runtime.workspaceMetadataReports).toBe(0);
});

test("conflicting local and session-directory ownership never uses majority rules", async () => {
  const fixture = await setup("worker-conflict");
  await fixture.provider.ensureInfrastructure();
  const markerPath = ownerMarkerPath(fixture.runtime.sessionDirectory);
  const marker = JSON.parse(await readFile(markerPath, "utf8"));
  marker.workerId = "another-worker";
  await writeFile(markerPath, JSON.stringify(marker));

  await expect(
    fixture.providerForWorker("worker-conflict").ensureInfrastructure(),
  ).rejects.toMatchObject({
    code: "backend_incompatible",
    capability: "backend.session_ownership",
  });
});

test("Worker startup ensures infrastructure before any harness discovery", async () => {
  const parent = join(process.cwd(), ".pi", "tmp");
  await mkdir(parent, { recursive: true });
  const root = await mkdtemp(join(parent, "worker-startup-order-"));
  roots.push(root);
  const events: string[] = [];
  const harness = new FakeHarness();
  const discover = harness.discover.bind(harness);
  harness.discover = async () => {
    events.push("harness-discovery");
    expect(events).toEqual(["infrastructure-ensure", "harness-discovery"]);
    return discover();
  };
  const config = {
    controlPlaneUrl: "ws://127.0.0.1/worker/websocket",
    workerId: "startup-order-worker",
    workerToken: "unused",
    maxConcurrency: 1,
    tags: [],
    herdrSession: defaultHerdrSessionName("startup-order-worker"),
    allowedRoots: [],
    workspaceBindings: [],
    worktreeRoot: join(root, "worktrees"),
    dataRoot: root,
    piThinking: "medium",
    heartbeatMs: 10_000,
    reconnectMs: 1_000,
    resultTimeoutMs: 10_000,
    provider: "pi",
    enabledHarnesses: ["pi", "antigravity"],
    fakeOutputs: {},
    fakeDelayMs: 0,
  } as WorkerConfig;
  const worker = new QuestEngineeringWorker(config, {
    infrastructure: {
      ensureInfrastructure: async () => {
        events.push("infrastructure-ensure");
      },
    },
    harnesses: [harness],
  });
  await worker.prepareForStartup();
  expect(events).toEqual(["infrastructure-ensure", "harness-discovery"]);
  await worker.stop();
});

test("configuration derives the default session and retains explicit overrides", async () => {
  const root = await fixtureRoot();
  const environment: NodeJS.ProcessEnv = {
    QE_CONTROL_PLANE_URL: "ws://127.0.0.1/worker/websocket",
    QE_WORKER_ID: "configured-worker",
    QE_WORKER_TOKEN: "unused",
    QE_WORKER_DATA_ROOT: root,
    QE_WORKTREE_ROOT: join(root, "worktrees"),
    QE_ALLOWED_ROOTS_JSON: "[]",
    QE_WORKER_PROVIDER: "fake",
    QE_ENABLE_TEST_PROVIDER: "1",
  };
  expect(loadConfig(environment).herdrSession).toBe(
    defaultHerdrSessionName("configured-worker"),
  );
  expect(
    loadConfig({ ...environment, QE_HERDR_SESSION: "explicit-session" })
      .herdrSession,
  ).toBe("explicit-session");
});

test("default session names are deterministic, bounded, normalized, and collision-resistant", () => {
  const home = "/Users/kylec";
  const ids = [
    "worker-a",
    "phase4-paid-9311592d-24f4-4626-8817-78dbbef44779",
    `worker-${"x".repeat(121)}`,
    "Worker.Name:region_1",
  ];
  for (const id of ids) {
    const first = defaultHerdrSessionName(id, home);
    expect(defaultHerdrSessionName(id, home)).toBe(first);
    expect(first).toMatch(/^qe-worker-[a-z0-9._-]+-[a-f0-9]{10}$/);
    expect(Buffer.byteLength(first)).toBeLessThanOrEqual(64);
    assertHerdrDefaultSocketPathSafe(first, home);
  }

  const normalizedFirst = defaultHerdrSessionName("foo/bar", home);
  const normalizedSecond = defaultHerdrSessionName("foo-bar", home);
  expect(normalizedFirst).not.toBe(normalizedSecond);
  expect(normalizedFirst).toMatch(/^qe-worker-foo-bar-[a-f0-9]{10}$/);
  expect(normalizedSecond).toMatch(/^qe-worker-foo-bar-[a-f0-9]{10}$/);

  const sharedPrefix = "worker-with-one-very-long-shared-prefix-";
  expect(defaultHerdrSessionName(`${sharedPrefix}a`, home)).not.toBe(
    defaultHerdrSessionName(`${sharedPrefix}b`, home),
  );
});

test("derived names keep both native Herdr sockets below the Unix path contract", async () => {
  const home = "/Users/kylec";
  const failedWorkerId = "phase4-paid-9311592d-24f4-4626-8817-78dbbef44779";
  const derived = defaultHerdrSessionName(failedWorkerId, home);
  const paths = herdrDefaultSocketPaths(derived, home);
  expect(Buffer.byteLength(paths.apiSocket)).toBeLessThanOrEqual(
    HERDR_UNIX_SOCKET_SAFE_PATH_BYTES,
  );
  expect(Buffer.byteLength(paths.clientSocket)).toBeLessThanOrEqual(
    HERDR_UNIX_SOCKET_SAFE_PATH_BYTES,
  );

  const failedName = "qe-worker-phase4-paid-9311592d-24f4-4626-8-88bd5a28f4";
  const failedPaths = herdrDefaultSocketPaths(failedName, home);
  expect(Buffer.byteLength(failedPaths.apiSocket)).toBe(100);
  expect(Buffer.byteLength(failedPaths.clientSocket)).toBe(107);
  expect(() => assertHerdrDefaultSocketPathSafe(failedName, home)).toThrow(
    "107 bytes",
  );

  const root = await fixtureRoot();
  const baseEnvironment: NodeJS.ProcessEnv = {
    HOME: home,
    QE_CONTROL_PLANE_URL: "ws://127.0.0.1/worker/websocket",
    QE_WORKER_ID: failedWorkerId,
    QE_WORKER_TOKEN: "unused",
    QE_ALLOWED_ROOTS_JSON: "[]",
    QE_WORKER_PROVIDER: "fake",
    QE_ENABLE_TEST_PROVIDER: "1",
  };
  expect(() =>
    loadConfig({
      ...baseEnvironment,
      QE_WORKER_DATA_ROOT: root,
      QE_WORKTREE_ROOT: join(root, "worktrees"),
      QE_HERDR_SESSION: failedName,
    }),
  ).toThrow("Herdr client socket path is 107 bytes");

  const longDataRoot = join(root, ...Array.from({ length: 12 }, () => "long"));
  const configuration = loadConfig({
    ...baseEnvironment,
    QE_WORKER_DATA_ROOT: longDataRoot,
    QE_WORKTREE_ROOT: join(longDataRoot, "worktrees"),
  });
  expect(configuration.herdrSession).toBe(derived);
  assertHerdrDefaultSocketPathSafe(configuration.herdrSession, home);
});

async function fixtureRoot(): Promise<string> {
  const parent = join(process.cwd(), ".pi", "tmp");
  await mkdir(parent, { recursive: true });
  const root = await mkdtemp(join(parent, "herdr-ownership-"));
  roots.push(root);
  return root;
}

async function setup(workerId: string) {
  const root = await fixtureRoot();
  const sessionName = defaultHerdrSessionName(workerId);
  const runtime = new FakeHerdrRuntime(root, sessionName);
  runtimes.push(runtime);
  const providerForWorker = (
    id: string,
    randomUUID = () => `incarnation-${runtime.starts + 1}`,
  ) =>
    new LocalHerdrConnectionProvider(sessionName, {
      workerId: id,
      dataRoot: root,
      runCommand: (args) => runtime.run(args),
      createClient: (_socket, onUnavailable) =>
        new FakeHerdrClient(runtime, onUnavailable),
      startServer: () => runtime.start(),
      randomUUID,
      now: () => "2026-09-15T00:00:00.000Z",
    });
  return {
    root,
    sessionName,
    runtime,
    providerForWorker,
    provider: providerForWorker(workerId),
  };
}

class SnapshotClient extends HerdrSocketClient {
  constructor(
    private readonly value: HostedSnapshot | Promise<HostedSnapshot>,
  ) {
    super("unused-test-socket");
  }

  override async snapshot(): Promise<HostedSnapshot> {
    return this.value;
  }
}

class FakeHerdrRuntime {
  starts = 0;
  pings = 0;
  readinessConnectionFailures = 0;
  nativeExitOnReadiness = false;
  workspaceMetadataReports = 0;
  infrastructureBootstraps = 0;
  executionMutations = 0;
  running = false;
  exists = false;
  workspaceExists = false;
  workspaceTokens: Record<string, string> = {};
  readonly sessionDirectory: string;
  readonly socketPath: string;
  private generation = 0;
  private exits: Array<(code: number) => void> = [];

  constructor(
    root: string,
    readonly sessionName: string,
  ) {
    this.sessionDirectory = join(root, "herdr-sessions", sessionName);
    this.socketPath = join(this.sessionDirectory, "herdr.sock");
  }

  start() {
    this.starts += 1;
    this.exists = true;
    this.running = true;
    this.generation += 1;
    mkdirSync(this.sessionDirectory, { recursive: true });
    writeFileSync(this.socketPath, `socket-${this.generation}`);
    let exit!: (code: number) => void;
    const exited = new Promise<number>((resolve) => {
      exit = resolve;
    });
    this.exits.push(exit);
    return {
      exited,
      diagnostics: async () => "native socket path failure",
    };
  }

  stop(exitCode = 0) {
    this.running = false;
    for (const resolve of this.exits.splice(0)) resolve(exitCode);
  }

  shutdown() {
    this.stop();
  }

  async deleteSession() {
    this.stop();
    this.exists = false;
    this.workspaceExists = false;
    this.workspaceTokens = {};
    await rm(this.sessionDirectory, { recursive: true, force: true });
    await Promise.resolve();
  }

  createForeignSession() {
    this.exists = true;
    this.running = true;
    mkdirSync(this.sessionDirectory, { recursive: true });
    writeFileSync(this.socketPath, "foreign-socket");
  }

  async replaceSocket() {
    await rm(this.socketPath, { force: true });
    this.generation += 1;
    await writeFile(this.socketPath, `socket-${this.generation}-replacement`);
  }

  createInfrastructureWorkspace() {
    this.infrastructureBootstraps += 1;
    this.workspaceExists = true;
    return {
      workspaceId: "w1",
      tabId: "w1:t1",
      paneId: "w1:p1",
      terminalId: "terminal-1",
    };
  }

  snapshot(): HostedSnapshot {
    return {
      workspaces: this.workspaceExists
        ? [
            {
              workspaceId: "w1",
              ...(Object.keys(this.workspaceTokens).length > 0
                ? { tokens: { ...this.workspaceTokens } }
                : {}),
            },
          ]
        : [],
      panes: this.workspaceExists
        ? [
            {
              workspaceId: "w1",
              tabId: "w1:t1",
              paneId: "w1:p1",
              terminalId: "terminal-1",
            },
          ]
        : [],
      agents: [],
    };
  }

  async run(args: string[]) {
    if (args.includes("schema"))
      return { exitCode: 0, stdout: JSON.stringify(schema()), stderr: "" };
    if (args.includes("list"))
      return {
        exitCode: 0,
        stdout: JSON.stringify({
          sessions: this.exists
            ? [
                {
                  name: this.sessionName,
                  running: this.running,
                  session_dir: this.sessionDirectory,
                  socket_path: this.socketPath,
                },
              ]
            : [],
        }),
        stderr: "",
      };
    return {
      exitCode: 0,
      stdout: JSON.stringify({
        running: this.running,
        session: this.sessionName,
        socket: this.socketPath,
        version: "0.9.0",
        protocol: 22,
        compatible: true,
        endpoint_compatible: true,
        capabilities: {
          endpoint_protocol_generation: 1,
          agent_explicit_launch: true,
        },
      }),
      stderr: "",
    };
  }
}

class FakeHerdrClient extends HerdrSocketClient {
  constructor(
    private readonly runtime: FakeHerdrRuntime,
    onUnavailable: () => void,
  ) {
    super("unused", 1_000, onUnavailable);
  }
  override async ping() {
    this.runtime.pings += 1;
    if (this.runtime.nativeExitOnReadiness) {
      this.runtime.stop(1);
      throw new HerdrApiError(
        "backend_unavailable",
        "Herdr socket closed before responding.",
        "backend.connection",
      );
    }
    if (this.runtime.readinessConnectionFailures > 0) {
      this.runtime.readinessConnectionFailures -= 1;
      throw new HerdrApiError(
        "backend_unavailable",
        "Herdr socket closed before responding.",
        "backend.connection",
      );
    }
    return {
      version: "0.9.0",
      protocol: 22,
      endpointGeneration: 1,
      agentExplicitLaunch: true,
    };
  }
  override async snapshot() {
    return this.runtime.snapshot();
  }
  override async createWorkspace() {
    return this.runtime.createInfrastructureWorkspace();
  }
  override async integrations(): Promise<HerdrIntegrationEvidence[]> {
    return [
      { target: "pi", available: true, state: "current" },
      { target: "antigravity_cli", available: true, state: "current" },
    ];
  }
  override async reportWorkspaceMetadata(input: {
    workspaceId: string;
    source: string;
    tokens: Record<string, string>;
  }) {
    expect(input.workspaceId).toBe("w1");
    this.runtime.workspaceMetadataReports += 1;
    this.runtime.workspaceTokens = { ...input.tokens };
  }
}

const OPERATIONS: Record<string, string[]> = {
  ping: [],
  "session.snapshot": [],
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
  "agent.start": ["pane_id", "name", "kind", "args", "command", "timeout_ms"],
  "agent.prompt": ["target", "text", "wait"],
  "agent.get": ["target"],
  "agent.send_keys": ["target", "keys"],
  "agent.wait": ["target", "until", "timeout_ms"],
  "integration.list": [],
};

function schema() {
  return {
    protocol: 22,
    schema_version: 1,
    schemas: {
      request: {
        oneOf: Object.entries(OPERATIONS).map(([method, parameters]) => ({
          properties: {
            method: { const: method },
            params: {
              properties: Object.fromEntries(
                parameters.map((parameter) => [parameter, {}]),
              ),
            },
          },
        })),
      },
      success_response: {
        $defs: {
          AgentStatus: {
            enum: ["idle", "working", "blocked", "done", "unknown"],
          },
          SessionSnapshot: {
            properties: { workspaces: {}, panes: {}, agents: {} },
          },
          WorkspaceInfo: { properties: { workspace_id: {}, tokens: {} } },
          PaneInfo: {
            properties: { workspace_id: {}, tab_id: {}, pane_id: {} },
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
            properties: { target: {}, available: {}, state: {} },
          },
        },
      },
    },
  };
}
