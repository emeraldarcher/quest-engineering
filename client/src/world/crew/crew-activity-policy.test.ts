import { expect, test } from "bun:test";
import { crewActivityPolicy } from "./crew-activity-policy";

const policy = (stepName: string, className = "Custom") =>
  crewActivityPolicy({
    stepKey: stepName.toLocaleLowerCase(),
    stepName,
    classKey: className.toLocaleLowerCase(),
    className,
  });

test("semantic activity presentation is centralized and truthful", () => {
  expect(policy("Implement login", "Builder")).toEqual({
    category: "crafting",
    workAnimationTag: "hamering",
  });
  expect(policy("Review login", "Reviewer").category).toBe("research");
  expect(policy("Mine ore")).toEqual({
    category: "mining",
    workAnimationTag: "mining",
  });
  expect(policy("Chop wood").workAnimationTag).toBe("axe");
  expect(policy("Dig trench").category).toBe("digging");
  expect(policy("Coordinate release").category).toBe("general");
});
