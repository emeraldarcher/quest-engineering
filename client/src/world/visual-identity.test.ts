import { expect, test } from "bun:test";
import { memberIdentity, stableHash } from "./visual-identity";

test("Member appearance is stable and scoped to Squad identity", () => {
  expect(memberIdentity("town-crew", "member-1")).toEqual(
    memberIdentity("town-crew", "member-1"),
  );
  expect(memberIdentity("other-crew", "member-1").hash).not.toBe(
    memberIdentity("town-crew", "member-1").hash,
  );
  expect(stableHash("member-1")).toBe(stableHash("member-1"));
});
