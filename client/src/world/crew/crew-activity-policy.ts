import type { CrewActivityCategory } from "../authored/map-schema";

export type CrewWorkAnimationTag =
  | "doing"
  | "hamering"
  | "mining"
  | "axe"
  | "dig";

export interface CrewActivityPresentationPolicy {
  category: CrewActivityCategory;
  workAnimationTag: CrewWorkAnimationTag;
}

const includes = (value: string, pattern: RegExp) => pattern.test(value);

/** Presentation-only interpretation; it never enters Product or Runtime data. */
export function crewActivityPolicy(input: {
  stepKey: string;
  stepName: string;
  stepInstruction?: string | null;
  classKey: string;
  className: string;
}): CrewActivityPresentationPolicy {
  const step =
    `${input.stepKey} ${input.stepName} ${input.stepInstruction ?? ""}`.toLocaleLowerCase();
  const memberClass =
    `${input.classKey} ${input.className}`.toLocaleLowerCase();
  const all = `${step} ${memberClass}`;
  if (includes(all, /\b(mine|mining|ore|quarry)\b/))
    return { category: "mining", workAnimationTag: "mining" };
  if (includes(all, /\b(wood|woodcut|chop|axe|lumber)\w*\b/))
    return { category: "woodcutting", workAnimationTag: "axe" };
  if (includes(all, /\b(dig|digging|excavat)\w*\b/))
    return { category: "digging", workAnimationTag: "dig" };
  if (
    includes(
      step,
      /\b(plan|research|review|inspect|analy[sz]|verify|test|audit)\w*\b/,
    ) ||
    includes(memberClass, /\b(reviewer|researcher|planner|analyst)\w*\b/)
  )
    return { category: "research", workAnimationTag: "doing" };
  if (
    includes(
      step,
      /\b(implement|build|repair|craft|code|develop|construct|fix)\w*\b/,
    ) ||
    includes(memberClass, /\b(builder|engineer|developer|crafter)\w*\b/)
  )
    return { category: "crafting", workAnimationTag: "hamering" };
  return { category: "general", workAnimationTag: "doing" };
}
