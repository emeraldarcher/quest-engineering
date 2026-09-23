import { afterEach, expect, mock, test } from "bun:test";
import { createFixture } from "../fixtures/fixtures";
import { ApiClient } from "./client";
import { ApiError } from "./contracts";

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

test("decodes safe repository identity and Project diagnostics", async () => {
  globalThis.fetch = mock(async (input: RequestInfo | URL) => {
    const path = String(input);
    if (path.endsWith("/workspace-sources"))
      return new Response(
        JSON.stringify({
          workspace_sources: [
            {
              candidate_id: "candidate-1",
              name: "quest-engineering",
              source_kind: "git_remote",
              source_fingerprint:
                "https://github.com/emeraldarcher/quest-engineering",
              publication_repository_identity:
                "emeraldarcher/quest-engineering",
              max_access: "read_write",
              shell_available: true,
            },
          ],
        }),
      );
    return new Response(
      JSON.stringify({
        workspaces: [
          {
            id: "workspace-1",
            key: "quest-engineering",
            name: "Quest Engineering",
            source_kind: "git_remote",
            source_fingerprint:
              "https://github.com/emeraldarcher/quest-engineering",
            binding: {
              state: "attention_required",
              message: "Project setup requires attention.",
              issue: { code: "workspace_binding_failed" },
            },
            archived_at: null,
          },
        ],
      }),
    );
  }) as unknown as typeof fetch;
  const api = new ApiClient({ httpBaseUrl: "http://example.test/api/v1" });

  const [workspace] = await api.listWorkspaces();
  const [source] = await api.listWorkspaceSources();

  expect(workspace?.binding.issue?.code).toBe("workspace_binding_failed");
  expect(source?.publication_repository_identity).toBe(
    "emeraldarcher/quest-engineering",
  );
});

test("requests archived Class and Loadout catalogs only when asked", async () => {
  const requested: string[] = [];
  globalThis.fetch = mock(async (input: RequestInfo | URL) => {
    const path = String(input);
    requested.push(path);
    return new Response(
      JSON.stringify(
        path.includes("/classes") ? { classes: [] } : { loadouts: [] },
      ),
    );
  }) as unknown as typeof fetch;
  const api = new ApiClient({ httpBaseUrl: "http://example.test/api/v1" });

  await api.listClasses(true);
  await api.listLoadouts(true);

  expect(requested).toEqual([
    "http://example.test/api/v1/classes?include_archived=true",
    "http://example.test/api/v1/loadouts?include_archived=true",
  ]);
});

test("Quest Board and War Room load archived catalogs and semantic Tactic preview explicitly", async () => {
  const requested: string[] = [];
  globalThis.fetch = mock(async (input: RequestInfo | URL) => {
    const path = String(input);
    requested.push(path);
    if (path.endsWith("/tactics/tactic-1/preview"))
      return new Response(
        JSON.stringify({
          preview: { resolved_tactic: { type: "step", key: "implement" } },
        }),
      );
    if (path.includes("/workspaces"))
      return new Response(JSON.stringify({ workspaces: [] }));
    if (path.includes("/squads"))
      return new Response(JSON.stringify({ squads: [] }));
    return new Response(JSON.stringify({ tactics: [] }));
  }) as unknown as typeof fetch;
  const api = new ApiClient({ httpBaseUrl: "http://example.test/api/v1" });

  await api.listWorkspaces(true);
  await api.listSquads(true);
  await api.listTactics(true);
  const preview = await api.previewTacticDefinition("tactic-1");

  expect(requested).toEqual([
    "http://example.test/api/v1/workspaces?include_archived=true",
    "http://example.test/api/v1/squads?include_archived=true",
    "http://example.test/api/v1/tactics?include_archived=true",
    "http://example.test/api/v1/tactics/tactic-1/preview",
  ]);
  expect(preview).toEqual({
    resolved_tactic: { type: "step", key: "implement" },
    artifact_bindings: [],
    provenance: null,
    step_origins: [],
  });
});

test("War Room sends anonymous and persisted-candidate draft previews without persistence", async () => {
  const requests: Array<{ path: string; body: unknown }> = [];
  globalThis.fetch = mock(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push({
        path: String(input),
        body: init?.body ? JSON.parse(String(init.body)) : null,
      });
      return new Response(
        JSON.stringify({
          preview: {
            resolved_tactic: { type: "step", key: "implement" },
            artifact_bindings: [],
            provenance: null,
            step_origins: [],
          },
        }),
      );
    },
  ) as unknown as typeof fetch;
  const api = new ApiClient({ httpBaseUrl: "http://example.test/api/v1" });
  const body = { type: "step", key: "implement" } as const;

  await api.previewTacticDraft(body);
  await api.previewTacticDefinition("tactic-1", body);

  expect(requests).toEqual([
    {
      path: "http://example.test/api/v1/tactics/preview",
      body: { tactic_source: { type: "inline", body } },
    },
    {
      path: "http://example.test/api/v1/tactics/tactic-1/preview",
      body: { body },
    },
  ]);
});

test("Product cancellation is local-only and preserves its exact request identity", async () => {
  const web = new ApiClient({ httpBaseUrl: "http://example.test/api/v1" });
  await expect(
    web.cancelExecutionAttempt("run", "occurrence", "attempt", "request"),
  ).rejects.toMatchObject({ code: "local_session_attachment_unavailable" });

  const fixture = createFixture("work-yard-running");
  if (!fixture || !fixture.selectedRunId)
    throw new Error("Expected a running fixture.");
  const run = fixture.runs[fixture.selectedRunId];
  if (!run) throw new Error("Expected a selected fixture Run.");

  let requestPath = "";
  let request: RequestInit | undefined;
  globalThis.fetch = mock(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      requestPath = String(input);
      request = init;
      return new Response(
        JSON.stringify({
          cancellation: {
            action_id: "action-1",
            worker_id: "worker-1",
            occurrence_id: "occurrence-1",
            attempt_id: "attempt-1",
            request_id: "cancel-request-1",
            origin: "product_operator",
            reason: "preflight complete",
            requested_generation: 3,
            requested_at: "2026-09-17T12:00:00Z",
            state: "cancellation_requested",
            delivery: "sent",
            idempotent_replay: false,
          },
          run,
        }),
      );
    },
  ) as unknown as typeof fetch;

  const desktop = new ApiClient({
    httpBaseUrl: "http://example.test/api/v1",
    localTauriClient: true,
  });
  const result = await desktop.cancelExecutionAttempt(
    "run-1",
    "occurrence-1",
    "attempt-1",
    "cancel-request-1",
    "preflight complete",
  );

  expect(result.cancellation).toMatchObject({
    action_id: "action-1",
    request_id: "cancel-request-1",
    state: "cancellation_requested",
    delivery: "sent",
  });
  expect(requestPath).toEndWith("/runs/run-1/attempts/attempt-1/cancel");
  expect(request?.method).toBe("POST");
  expect(
    (request?.headers as Record<string, string>)[
      "x-quest-engineering-local-client"
    ],
  ).toBe("tauri");
  expect(JSON.parse(String(request?.body))).toEqual({
    occurrence_id: "occurrence-1",
    request_id: "cancel-request-1",
    reason: "preflight complete",
  });
});

test("local session descriptors are unavailable to web clients and marked for Tauri", async () => {
  const web = new ApiClient({ httpBaseUrl: "http://example.test/api/v1" });
  await expect(
    web.getSessionAttachment("run", "attempt", "session"),
  ).rejects.toMatchObject({ code: "local_session_attachment_unavailable" });

  let request: RequestInit | undefined;
  globalThis.fetch = mock(
    async (_input: RequestInfo | URL, init?: RequestInit) => {
      request = init;
      return new Response(
        JSON.stringify({
          attachment: {
            descriptor_token: "short-lived-token",
            expires_at: "2099-01-01T00:00:00Z",
            mode: "local_native_terminal",
            worker_id: "local-worker",
            worker_generation: 2,
            session_id: "session",
            state: "waiting_for_human",
            takeover_allowed: true,
            terminal: {
              attachment_mode: "local_native_terminal",
              backend_kind: "herdr",
              terminal_session_id: "quest-engineering-worker",
              terminal_target_id: "qe-agent",
              terminal_id: "terminal-1",
              supports_observation: true,
              supports_takeover: true,
            },
          },
        }),
      );
    },
  ) as unknown as typeof fetch;
  const desktop = new ApiClient({
    httpBaseUrl: "http://example.test/api/v1",
    localTauriClient: true,
  });
  const descriptor = await desktop.getSessionAttachment(
    "run",
    "attempt",
    "session",
  );

  expect(descriptor.session_id).toBe("session");
  expect(descriptor.takeover_allowed).toBe(true);
  expect(
    (request?.headers as Record<string, string>)[
      "x-quest-engineering-local-client"
    ],
  ).toBe("tauri");

  let openedBody: unknown;
  globalThis.fetch = mock(
    async (_input: RequestInfo | URL, init?: RequestInit) => {
      openedBody = JSON.parse(String(init?.body));
      return new Response(
        JSON.stringify({
          session_id: "session",
          result: "human_control_started",
        }),
      );
    },
  ) as unknown as typeof fetch;
  await desktop.recordSessionOpened("short-lived-token", "takeover");
  expect(openedBody).toEqual({
    descriptor_token: "short-lived-token",
    mode: "takeover",
  });
});

test("maps Product validation envelope into a typed client error", async () => {
  globalThis.fetch = mock(
    async () =>
      new Response(
        JSON.stringify({
          error: {
            code: "validation_failed",
            message: "The request is invalid.",
            details: [{ code: "invalid_value", path: ["name"], details: {} }],
            meta: {},
          },
        }),
        { status: 422 },
      ),
  ) as unknown as typeof fetch;
  const api = new ApiClient({ httpBaseUrl: "http://example.test/api/v1" });
  await expect(
    api.createClass({
      key: "builder",
      name: "",
      description: "",
      instructions: "Build",
    }),
  ).rejects.toEqual(expect.any(ApiError));
  await api
    .createClass({
      key: "builder",
      name: "",
      description: "",
      instructions: "Build",
    })
    .catch((error: unknown) => {
      expect(error).toBeInstanceOf(ApiError);
      expect((error as ApiError).code).toBe("validation_failed");
      expect((error as ApiError).details[0]?.path).toEqual(["name"]);
    });
});
