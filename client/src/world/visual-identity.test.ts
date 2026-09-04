import { expect, test } from "bun:test";
import { memberIdentity, squadIdentity, stableHash } from "./visual-identity";

test("Member appearance is stable and scoped to Squad identity", () => {
  expect(memberIdentity("town-crew", "member-1")).toEqual(
    memberIdentity("town-crew", "member-1"),
  );
  expect(memberIdentity("other-crew", "member-1").hash).not.toBe(
    memberIdentity("town-crew", "member-1").hash,
  );
  expect(stableHash("member-1")).toBe(stableHash("member-1"));
});

test("Squad accent is stable independently of Run and Project", () => {
  expect(squadIdentity("engineering-pair")).toEqual(
    squadIdentity("engineering-pair"),
  );
  expect(squadIdentity("engineering-pair").accentColor).toBeNumber();
});
