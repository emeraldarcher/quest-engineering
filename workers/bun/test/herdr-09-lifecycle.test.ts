import { expect, test } from "bun:test";
import {
  HerdrApiError,
  HerdrSocketClient,
} from "../src/session-host/herdr/client.ts";

const ownershipTokens = {
  qe_owner: "quest-engineering-worker",
  qe_worker_id: "worker-1",
  qe_lineage_id: "lineage-1",
  qe_ownership_token: "ownership-1",
  qe_session_incarnation: "incarnation-1",
};

test("Herdr 0.9 agent_pane_busy adopts or retries only after shell-state settlement", async () => {
  const client = new BusyOnceClient();
  const agent = await client.startAgent({
    paneId: "pane-1",
    name: "qe-antigravity",
    integrationKind: "agy",
    args: ["--model", "test"],
    expectedTokens: ownershipTokens,
    timeoutMs: 5_000,
  });
  expect(agent).toMatchObject({
    name: "qe-antigravity",
    agent: "agy",
    paneId: "pane-1",
    interactiveReady: true,
  });
  expect(client.startCalls).toBe(2);
  expect(client.processInfoCalls).toBeGreaterThanOrEqual(2);
});

test("additive snapshot fields and future lifecycle states decode conservatively", async () => {
  const client = new SnapshotClient({
    snapshot: {
      future_topology: { additive: true },
      workspaces: [{ workspace_id: "w1", future: "field" }],
      panes: [
        {
          workspace_id: "w1",
          tab_id: "w1:t1",
          pane_id: "w1:p1",
          future: "field",
        },
      ],
      agents: [
        {
          workspace_id: "w1",
          pane_id: "w1:p1",
          agent: "pi",
          status: "paused_by_future_herdr",
          future: "field",
        },
      ],
    },
  });
  const snapshot = await client.snapshot();
  expect(snapshot.agents[0]?.status).toBe("unknown");
  expect(snapshot.panes[0]?.paneId).toBe("w1:p1");
});

test("snapshot decodes a schema-valid transitional launch without inventing materialization", async () => {
  const client = new SnapshotClient({
    snapshot: {
      workspaces: [{ workspace_id: "w1" }],
      panes: [{ workspace_id: "w1", tab_id: "w1:t1", pane_id: "w1:p1" }],
      agents: [
        {
          terminal_id: "term-1",
          name: "qe-pending",
          agent_status: "unknown",
          workspace_id: "w1",
          tab_id: "w1:t1",
          pane_id: "w1:p1",
          launch_pending: true,
          tokens: { ...ownershipTokens, qe_provider: "pi" },
        },
      ],
    },
  });

  expect((await client.snapshot()).agents[0]).toMatchObject({
    name: "qe-pending",
    agent: "pi",
    status: "unknown",
    launchPending: true,
  });
});

test("malformed required snapshot data fails the decoding capability", async () => {
  const client = new SnapshotClient({
    snapshot: { workspaces: [], panes: "not-an-array", agents: [] },
  });
  await expect(client.snapshot()).rejects.toMatchObject({
    code: "backend_incompatible",
    capability: "session.snapshot_decoding",
  });
});

test("malformed optional native identity is rejected when present", async () => {
  const client = new SnapshotClient({
    snapshot: {
      workspaces: [],
      panes: [],
      agents: [
        {
          workspace_id: "w1",
          pane_id: "w1:p1",
          agent: "pi",
          status: "idle",
          agent_session: { source: "pi", kind: "id" },
        },
      ],
    },
  });
  await expect(client.snapshot()).rejects.toMatchObject({
    code: "backend_incompatible",
    capability: "agent.native_session",
  });
});

for (const integrationKind of ["pi", "agy"]) {
  test(`shared ${integrationKind} launch reconciles pending acknowledgement without duplicate start`, async () => {
    const client = new LifecycleClient(integrationKind, "pending-then-ready");
    const agent = await client.startAgent({
      paneId: "pane-1",
      name: `qe-${integrationKind}`,
      integrationKind,
      args: [],
      expectedTokens: ownershipTokens,
      timeoutMs: 5_000,
    });

    expect(agent).toMatchObject({
      name: `qe-${integrationKind}`,
      agent: integrationKind,
      paneId: "pane-1",
      interactiveReady: true,
      launchPending: false,
    });
    expect(client.startCalls).toBe(1);
    expect(client.promptCalls).toBe(0);
  });
}

test("explicit managed launch sends literal argv, cwd, and env without legacy args", async () => {
  const client = new LifecycleClient("pi", "inline-ready");
  const literalArgs = [
    "space value",
    "quote'\"value",
    "$(never-run)",
    "*.not-expanded",
    "日本語",
    "",
  ];
  await client.startAgent({
    paneId: "pane-1",
    name: "qe-pi",
    integrationKind: "pi",
    args: ["legacy-must-not-be-sent"],
    command: {
      executable: "/opt/qe/launchers/sbx",
      args: literalArgs,
      cwd: "/worker/run cwd",
      environment: { QE_TEST: "literal $VALUE; no shell" },
      io: "pty",
      provenance: {
        kind: "execution_environment",
        ref: {
          backendKind: "sbx",
          environmentId: "environment-1",
          incarnation: "incarnation-1",
          workerId: "worker-1",
          runId: "run-1",
          profile: { id: "profile-1", digest: "sha256:test" },
        },
        profile: { id: "profile-1", digest: "sha256:test" },
      },
    },
    expectedTokens: ownershipTokens,
    timeoutMs: 5_000,
  });

  expect(client.lastStartParams).toMatchObject({
    pane_id: "pane-1",
    name: "qe-pi",
    kind: "pi",
    args: [],
    command: {
      executable: "/opt/qe/launchers/sbx",
      args: literalArgs,
      cwd: "/worker/run cwd",
      env: { QE_TEST: "literal $VALUE; no shell" },
    },
  });
});

test("explicit managed launch rejects relative executable before any Herdr side effect", async () => {
  const client = new LifecycleClient("pi", "inline-ready");
  await expect(
    client.startAgent({
      paneId: "pane-1",
      name: "qe-pi",
      integrationKind: "pi",
      args: [],
      command: {
        executable: "pi",
        args: [],
        cwd: "/worker/run",
        environment: {},
        io: "pty",
        provenance: {
          kind: "execution_environment",
          ref: {
            backendKind: "sbx",
            environmentId: "environment-1",
            incarnation: "incarnation-1",
            workerId: "worker-1",
            runId: "run-1",
            profile: { id: "profile-1", digest: "sha256:test" },
          },
          profile: { id: "profile-1", digest: "sha256:test" },
        },
      },
      expectedTokens: ownershipTokens,
      timeoutMs: 5_000,
    }),
  ).rejects.toMatchObject({
    code: "environment_launch_mismatch",
    capability: "agent.explicit_launch",
  });
  expect(client.startCalls).toBe(0);
});

test("full inline agent.start projection completes without inventory polling", async () => {
  const client = new LifecycleClient("pi", "inline-ready");
  const agent = await client.startAgent({
    paneId: "pane-1",
    name: "qe-pi",
    integrationKind: "pi",
    args: [],
    expectedTokens: ownershipTokens,
    timeoutMs: 5_000,
  });

  expect(agent.interactiveReady).toBe(true);
  expect(client.startCalls).toBe(1);
  expect(client.getCalls).toBe(1);
});

test("exact owned agent is adopted by deterministic name before another start", async () => {
  const client = new LifecycleClient("pi", "existing-ready");
  const agent = await client.startAgent({
    paneId: "new-pane",
    name: "qe-pi",
    integrationKind: "pi",
    args: [],
    expectedTokens: ownershipTokens,
    timeoutMs: 5_000,
  });

  expect(agent.paneId).toBe("old-pane");
  expect(client.startCalls).toBe(0);
  expect(client.promptCalls).toBe(0);
});

test("restart adopts exact snapshot provenance when Herdr omits the persisted agent name", async () => {
  const client = new LifecycleClient("pi", "snapshot-existing");
  const agent = await client.startAgent({
    paneId: "new-pane",
    name: "qe-pi",
    integrationKind: "pi",
    args: [],
    expectedTokens: ownershipTokens,
    timeoutMs: 5_000,
  });

  expect(agent).toMatchObject({
    name: "qe-pi",
    paneId: "old-pane",
    nativeMaterialized: true,
  });
  expect(client.startCalls).toBe(0);
});

test("omitted acknowledgement retries only after inventory and shell prove absence", async () => {
  const client = new LifecycleClient("pi", "omitted-then-absent");
  const agent = await client.startAgent({
    paneId: "pane-1",
    name: "qe-pi",
    integrationKind: "pi",
    args: [],
    expectedTokens: ownershipTokens,
    timeoutMs: 6_000,
  });

  expect(agent.agent).toBe("pi");
  expect(client.startCalls).toBe(2);
  expect(client.promptCalls).toBe(0);
});

test("repeated malformed acknowledgement with proven absence is incompatible, not uncertain", async () => {
  const client = new LifecycleClient("pi", "always-omitted");
  await expect(
    client.startAgent({
      paneId: "pane-1",
      name: "qe-pi",
      integrationKind: "pi",
      args: [],
      expectedTokens: ownershipTokens,
      timeoutMs: 6_000,
    }),
  ).rejects.toMatchObject({
    code: "backend_incompatible",
    capability: "agent.interactive_launch",
  });
  expect(client.startCalls).toBe(2);
  expect(client.promptCalls).toBe(0);
});

test("transport loss after creation adopts the exact owned agent", async () => {
  const client = new LifecycleClient("agy", "transport-after-create");
  const agent = await client.startAgent({
    paneId: "pane-1",
    name: "qe-agy",
    integrationKind: "agy",
    args: [],
    expectedTokens: ownershipTokens,
    timeoutMs: 5_000,
  });

  expect(agent.agent).toBe("agy");
  expect(client.startCalls).toBe(1);
  expect(client.promptCalls).toBe(0);
});

test("same-name foreign ownership is rejected before launch", async () => {
  const client = new LifecycleClient("pi", "foreign-existing");
  await expect(
    client.startAgent({
      paneId: "pane-1",
      name: "qe-pi",
      integrationKind: "pi",
      args: [],
      expectedTokens: ownershipTokens,
      timeoutMs: 5_000,
    }),
  ).rejects.toMatchObject({ code: "agent_launch_conflict" });
  expect(client.startCalls).toBe(0);
});

test("ambiguous post-ack inventory fails uncertain without duplicate start or prompt", async () => {
  const client = new LifecycleClient("pi", "inventory-unavailable");
  await expect(
    client.startAgent({
      paneId: "pane-1",
      name: "qe-pi",
      integrationKind: "pi",
      args: [],
      expectedTokens: ownershipTokens,
      timeoutMs: 5_000,
    }),
  ).rejects.toMatchObject({ code: "agent_launch_uncertain" });
  expect(client.startCalls).toBe(1);
  expect(client.promptCalls).toBe(0);
});

type LifecycleScenario =
  | "pending-then-ready"
  | "inline-ready"
  | "existing-ready"
  | "snapshot-existing"
  | "omitted-then-absent"
  | "always-omitted"
  | "transport-after-create"
  | "foreign-existing"
  | "inventory-unavailable";

class LifecycleClient extends HerdrSocketClient {
  startCalls = 0;
  getCalls = 0;
  promptCalls = 0;
  lastStartParams: Record<string, unknown> | null = null;

  constructor(
    private readonly integrationKind: string,
    private readonly scenario: LifecycleScenario,
  ) {
    super("unused-test-socket");
  }

  override async request(
    method: string,
    params: Record<string, unknown> = {},
  ): Promise<Record<string, unknown>> {
    if (method === "agent.prompt") {
      this.promptCalls += 1;
      throw new Error("startAgent must not prompt");
    }
    if (method === "session.snapshot") return this.snapshotResponse();
    if (method === "pane.process_info")
      return {
        process_info: {
          shell_pid: 42,
          foreground_process_group_id: 42,
        },
      };
    if (method === "agent.get") return this.getAgentResponse();
    if (method === "agent.start") {
      this.lastStartParams = structuredClone(params);
      return this.startAgentResponse();
    }
    throw new Error(`Unexpected method: ${method}`);
  }

  private snapshotResponse(): Record<string, unknown> {
    if (this.scenario === "snapshot-existing")
      return {
        snapshot: {
          workspaces: [{ workspace_id: "workspace-1" }],
          panes: [
            {
              workspace_id: "workspace-1",
              tab_id: "tab-1",
              pane_id: "old-pane",
            },
          ],
          agents: [{ ...this.agent("old-pane"), name: undefined }],
        },
      };
    return { snapshot: { workspaces: [], panes: [], agents: [] } };
  }

  private async getAgentResponse(): Promise<Record<string, unknown>> {
    this.getCalls += 1;
    if (this.scenario === "existing-ready")
      return { agent: this.agent("old-pane") };
    if (this.scenario === "foreign-existing")
      return {
        agent: this.agent("pane-1", {
          ...ownershipTokens,
          qe_ownership_token: "foreign",
        }),
      };
    if (this.startCalls === 0)
      throw new HerdrApiError("agent_not_found", "not projected");
    if (this.scenario === "inventory-unavailable")
      throw new HerdrApiError("backend_unavailable", "socket disconnected");
    if (
      this.scenario === "omitted-then-absent" ||
      this.scenario === "always-omitted"
    )
      throw new HerdrApiError("agent_not_found", "authoritatively absent");
    if (this.scenario === "pending-then-ready" && this.getCalls === 2)
      return { agent: this.pendingAgent() };
    return { agent: this.agent("pane-1") };
  }

  private async startAgentResponse(): Promise<Record<string, unknown>> {
    this.startCalls += 1;
    if (this.scenario === "transport-after-create")
      throw new HerdrApiError("backend_unavailable", "response was lost");
    if (
      (this.scenario === "omitted-then-absent" && this.startCalls === 1) ||
      this.scenario === "always-omitted"
    )
      return { type: "agent_started", argv: [this.integrationKind] };
    if (
      this.scenario === "pending-then-ready" ||
      this.scenario === "inventory-unavailable"
    )
      return { agent: this.pendingAgent() };
    return { agent: this.agent("pane-1") };
  }

  private pendingAgent(): Record<string, unknown> {
    return {
      terminal_id: "terminal-1",
      name: `qe-${this.integrationKind}`,
      agent_status: "unknown",
      workspace_id: "workspace-1",
      tab_id: "tab-1",
      pane_id: "pane-1",
      launch_pending: true,
      revision: 1,
      tokens: ownershipTokens,
    };
  }

  private agent(
    paneId: string,
    tokens: Record<string, string> = ownershipTokens,
  ): Record<string, unknown> {
    return {
      terminal_id: "terminal-1",
      name: `qe-${this.integrationKind}`,
      agent: this.integrationKind,
      agent_status: "idle",
      workspace_id: "workspace-1",
      tab_id: "tab-1",
      pane_id: paneId,
      interactive_ready: true,
      revision: 2,
      tokens,
    };
  }
}

class SnapshotClient extends HerdrSocketClient {
  constructor(private readonly response: Record<string, unknown>) {
    super("unused-test-socket");
  }
  override async request(): Promise<Record<string, unknown>> {
    return this.response;
  }
}

class BusyOnceClient extends HerdrSocketClient {
  startCalls = 0;
  processInfoCalls = 0;

  constructor() {
    super("unused-test-socket");
  }

  override async request(
    method: string,
    _params: Record<string, unknown> = {},
    _timeoutMs = 30_000,
  ): Promise<Record<string, unknown>> {
    if (method === "pane.process_info") {
      this.processInfoCalls += 1;
      return {
        process_info: {
          shell_pid: 42,
          foreground_process_group_id: 42,
        },
      };
    }
    if (method === "session.snapshot")
      return { snapshot: { workspaces: [], panes: [], agents: [] } };
    if (method === "agent.start") {
      this.startCalls += 1;
      if (this.startCalls === 1)
        throw new HerdrApiError(
          "agent_pane_busy",
          "agent target pane is not an available shell",
        );
      return { agent: this.agent() };
    }
    if (method === "agent.get")
      throw new HerdrApiError("agent_not_found", "not projected");
    throw new Error(`Unexpected method: ${method}`);
  }

  private agent() {
    return {
      name: "qe-antigravity",
      agent: "agy",
      status: "idle",
      pane_id: "pane-1",
      workspace_id: "workspace-1",
      tab_id: "tab-1",
      terminal_id: "terminal-1",
      interactive_ready: true,
      tokens: ownershipTokens,
    };
  }
}
