import { afterEach, expect, mock, test } from "bun:test";
import { ApiClient } from "./client";

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

test("decodes starter status and submits only the Project prerequisite", async () => {
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  globalThis.fetch = mock(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push({ url: String(input), ...(init ? { init } : {}) });
      if (!init || init.method === "GET")
        return new Response(
          JSON.stringify({
            starter_crew: {
              state: "recoverable_partial",
              conflict: null,
            },
          }),
        );
      return new Response(JSON.stringify({ starter_crew: starterResult() }));
    },
  ) as unknown as typeof fetch;
  const api = new ApiClient({ httpBaseUrl: "http://example.test/api/v1" });

  const status = await api.getStarterCrewStatus();
  const result = await api.createStarterCrew("workspace-1");

  expect(status.state).toBe("recoverable_partial");
  expect(result.squad.key).toBe("engineering-pair");
  expect(result.tactic.key).toBe("implement-and-review");
  expect(JSON.parse(String(requests[1]?.init?.body))).toEqual({
    workspace_id: "workspace-1",
  });
});

function starterResult() {
  const definition = (id: string, key: string, name: string) => ({
    id,
    key,
    name,
    description: `${name} description`,
    instructions: `${name} instructions`,
    archived_at: null,
  });
  const loadout = (id: string, key: string, name: string, access: string) => ({
    id,
    key,
    name,
    description: `${name} description`,
    model: { provider: "fake", model: "starter" },
    reasoning: "medium",
    tools: ["workspace.filesystem"],
    workspace_access: access,
    archived_at: null,
  });
  return {
    status: "ready",
    classes: [
      definition("class-builder", "builder", "Builder"),
      definition("class-reviewer", "reviewer", "Reviewer"),
    ],
    loadouts: [
      loadout("loadout-coding", "coding", "Coding", "read_write"),
      loadout("loadout-review", "review", "Review", "read_only"),
    ],
    squad: {
      id: "squad",
      key: "engineering-pair",
      name: "Engineering Pair",
      description: "Pair.",
      members: [
        {
          member_key: "builder",
          name: "Builder",
          class_id: "class-builder",
          loadout_id: "loadout-coding",
        },
      ],
      archived_at: null,
    },
    tactic: {
      id: "tactic",
      key: "implement-and-review",
      name: "Implement & Review",
      description: "Workflow.",
      body: {},
      archived_at: null,
    },
  };
}
