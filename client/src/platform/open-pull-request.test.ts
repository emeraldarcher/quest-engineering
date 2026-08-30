import { expect, test } from "bun:test";
import { canonicalPullRequestUrl } from "./open-pull-request";

test("accepts only the exact canonical GitHub Pull Request identity", () => {
  expect(
    canonicalPullRequestUrl("https://github.com/owner/repo/pull/42", 42)
      .pathname,
  ).toBe("/owner/repo/pull/42");
  for (const value of [
    "http://github.com/owner/repo/pull/42",
    "https://github.com/owner/repo/pull/43",
    "https://user:token@github.com/owner/repo/pull/42",
    "https://evil.example/owner/repo/pull/42",
    "https://github.com/owner/repo/pull/42?diff=split",
  ])
    expect(() => canonicalPullRequestUrl(value, 42)).toThrow();
});
