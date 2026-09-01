import { expect, mock, test } from "bun:test";
import { ApiError } from "../../api/contracts";
import { createSquadWithGeneratedKey } from "./squad-creation";

const input = { name: "Engineering Pair", description: "", members: [] };

test("generates an immutable Squad key from Name", async () => {
  const createSquad = mock(async (payload: Record<string, unknown>) => ({
    ...payload,
    id: "squad",
    archived_at: null,
  }));
  const result = await createSquadWithGeneratedKey(
    { createSquad } as never,
    input,
    [],
  );
  expect(result.key).toBe("engineering-pair");
});

test("retries deterministic Squad-key suffixes on collision", async () => {
  const createSquad = mock(async (payload: Record<string, unknown>) => {
    if (payload.key === "engineering-pair-2")
      throw new ApiError("validation_failed", "Collision", [
        { code: "taken", path: ["key"], details: {} },
      ]);
    return { ...payload, id: "squad", archived_at: null };
  });
  const result = await createSquadWithGeneratedKey(
    { createSquad } as never,
    input,
    ["engineering-pair"],
  );
  expect(result.key).toBe("engineering-pair-3");
});
