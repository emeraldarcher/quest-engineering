import { afterEach, expect, mock, test } from "bun:test";
import { ApiClient } from "./client";
import { ApiError } from "./contracts";

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
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
