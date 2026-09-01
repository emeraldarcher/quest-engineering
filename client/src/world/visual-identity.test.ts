import { expect, test } from "bun:test";
import {
  assignMemberHomes,
  assignWorkSites,
  memberIdentity,
  stableHash,
} from "./visual-identity";

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
  const sites = [
    { id: "desk-1", x: 10, y: 20 },
    { id: "bench-1", x: 30, y: 20 },
  ];
  const forward = assignWorkSites(values, sites);
  const reverse = assignWorkSites([...values].reverse(), sites);
  expect(forward).toEqual(reverse);
  expect(forward.get("occurrence-a")).not.toEqual(forward.get("occurrence-b"));
});

test("Member homes are authored, deterministic, unique, and order independent", () => {
  const homes = [
    { id: "home-1", x: 10, y: 20 },
    { id: "home-2", x: 30, y: 20 },
  ];
  const forward = assignMemberHomes(
    "town-crew",
    ["member-2", "member-1"],
    homes,
  );
  const reverse = assignMemberHomes(
    "town-crew",
    ["member-1", "member-2"],
    homes,
  );
  expect(forward).toEqual(reverse);
  expect(forward.get("member-1")).not.toEqual(forward.get("member-2"));
});
