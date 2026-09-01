import { expect, mock, test } from "bun:test";
import type { LoadoutInput } from "../../api/client";
import { ApiError, type Loadout } from "../../api/contracts";
import { createLoadoutWithGeneratedKey } from "./loadout-creation";

const input: Omit<Required<LoadoutInput>, "key"> = {
  name: "Senior Coding",
  description: "A coding setup.",
  model: { provider: "custom-provider", model: "custom-model" },
  reasoning: "high",
  tools: ["acme.special-tool"],
  workspace_access: "read_write",
};
const created: Loadout = {
  id: "loadout-created",
  key: "senior-coding",
  ...input,
  workspace_access: input.workspace_access,
  archived_at: null,
};

test("generates an immutable Product key from the Loadout name", async () => {
  const createLoadout = mock(async (value: Required<LoadoutInput>) => ({
    ...created,
    ...value,
  }));

  await createLoadoutWithGeneratedKey({ createLoadout }, input, []);

  expect(createLoadout.mock.calls[0]?.[0].key).toBe("senior-coding");
});

test("retries deterministic suffixes on a concurrent key collision", async () => {
  const keys: string[] = [];
  const createLoadout = mock(async (value: Required<LoadoutInput>) => {
    keys.push(value.key);
    if (keys.length === 1)
      throw new ApiError(
        "validation_failed",
        "The request is invalid.",
        [{ code: "invalid_value", path: ["key"], details: {} }],
        {},
        422,
      );
    return { ...created, ...value };
  });

  await createLoadoutWithGeneratedKey({ createLoadout }, input, [
    "senior-coding",
  ]);

  expect(keys).toEqual(["senior-coding-2", "senior-coding-3"]);
});
