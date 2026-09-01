import { expect, mock, test } from "bun:test";
import { ApiError, type ClassDefinition } from "../../api/contracts";
import { createClassWithGeneratedKey } from "./class-creation";

const created: ClassDefinition = {
  id: "class-senior-reviewer",
  key: "senior-reviewer",
  name: "Senior Reviewer",
  description: "Reviews risky changes.",
  instructions: "Review independently.",
  archived_at: null,
};

test("generates a Product key from the Class name", async () => {
  const createClass = mock(async (input) => ({ ...created, ...input }));

  const result = await createClassWithGeneratedKey(
    { createClass },
    {
      name: "Senior Reviewer",
      description: created.description,
      instructions: created.instructions,
    },
    [],
  );

  expect(result.key).toBe("senior-reviewer");
  expect(createClass.mock.calls[0]?.[0].key).toBe("senior-reviewer");
});

test("uses deterministic suffixes for loaded and concurrent key collisions", async () => {
  const keys: string[] = [];
  const createClass = mock(async (input) => {
    keys.push(input.key);
    if (keys.length === 1)
      throw new ApiError(
        "validation_failed",
        "The request is invalid.",
        [{ code: "invalid_value", path: ["key"], details: {} }],
        {},
        422,
      );
    return { ...created, ...input };
  });

  await createClassWithGeneratedKey(
    { createClass },
    {
      name: "Senior Reviewer",
      description: created.description,
      instructions: created.instructions,
    },
    ["senior-reviewer"],
  );

  expect(keys).toEqual(["senior-reviewer-2", "senior-reviewer-3"]);
});
