import { expect, test } from "bun:test";
import { assignWorkSites, memberIdentity, stableHash } from "./visual-identity";

test("Member appearance is stable and scoped to Squad identity", () => {
  expect(memberIdentity("town-crew", "member-1")).toEqual(
    memberIdentity("town-crew", "member-1"),
  );
  expect(memberIdentity("other-crew", "member-1").hash).not.toBe(
    memberIdentity("town-crew", "member-1").hash,
  );
  expect(stableHash("member-1")).toBe(stableHash("member-1"));
});

test("parallel worksite assignment is deterministic, unique, and order independent", () => {
  const values = [
    { occurrenceId: "occurrence-b", memberKey: "member-2" },
    { occurrenceId: "occurrence-a", memberKey: "member-1" },
  ];
  const forward = assignWorkSites(values);
  const reverse = assignWorkSites([...values].reverse());
  expect(forward).toEqual(reverse);
  expect(forward.get("occurrence-a")).not.toEqual(forward.get("occurrence-b"));
});
