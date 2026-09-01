import { afterEach, expect, mock, test } from "bun:test";
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
