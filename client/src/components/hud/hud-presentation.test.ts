import { expect, test } from "bun:test";
import type { Quest } from "../../api/contracts";
import { createFixture } from "../../fixtures/fixtures";
import { townHudCounts } from "./hud-presentation";

function quests(name: string): Quest[] {
  const fixture = createFixture(name);
  if (!fixture) throw new Error(`Missing fixture '${name}'`);
  return fixture.product.quests;
}

test("HUD counters use exact canonical Quest lifecycle semantics", () => {
  expect(townHudCounts(quests("town-hud-mixed"))).toEqual({
    activeQuests: 6,
    workingQuests: 2,
    attentionQuests: 1,
    reviewQuests: 2,
    preparingReviewQuests: 1,
  });
});

test("complete and archived Quests do not contribute to active HUD counts", () => {
  expect(townHudCounts(quests("town-hud-idle"))).toEqual({
    activeQuests: 0,
    workingQuests: 0,
    attentionQuests: 0,
    reviewQuests: 0,
    preparingReviewQuests: 0,
  });
});

test("preparing review is active but is not awaiting review", () => {
  expect(townHudCounts(quests("town-hud-preparing-review"))).toEqual({
    activeQuests: 2,
    workingQuests: 0,
    attentionQuests: 0,
    reviewQuests: 0,
    preparingReviewQuests: 1,
  });
});

test("working is a Quest count and ignores unrelated configuration attention", () => {
  const fixture = createFixture("town-hud-working");
  if (!fixture) throw new Error("Missing working fixture");
  const project = fixture.product.workspaces[0];
  if (!project) throw new Error("Missing Project fixture");
  fixture.product.workspaces[0] = {
    ...project,
    binding: {
      state: "attention_required",
      message: "Project setup requires attention.",
    },
  };
  expect(townHudCounts(fixture.product.quests)).toMatchObject({
    workingQuests: 3,
    attentionQuests: 0,
  });
});
