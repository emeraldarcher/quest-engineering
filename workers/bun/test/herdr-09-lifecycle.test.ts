import { expect, test } from "bun:test";
import {
  HerdrApiError,
  HerdrSocketClient,
} from "../src/session-host/herdr/client.ts";

test("Herdr 0.9 agent_pane_busy adopts or retries only after shell-state settlement", async () => {
  const client = new BusyOnceClient();
  const agent = await client.startAgent({
    paneId: "pane-1",
    name: "qe-antigravity",
    integrationKind: "agy",
    args: ["--model", "test"],
    timeoutMs: 5_000,
  });
  expect(agent).toMatchObject({
    name: "qe-antigravity",
    agent: "agy",
    paneId: "pane-1",
    interactiveReady: true,
  });
  expect(client.startCalls).toBe(2);
  expect(client.processInfoCalls).toBe(2);
});

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
    };
  }
}
