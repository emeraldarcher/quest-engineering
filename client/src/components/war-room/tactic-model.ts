import type { JsonValue, Tactic } from "../../api/contracts";
import {
  availableProductKey,
  productKeyBase,
} from "../management/management-key";

export interface ArtifactDraft {
  type: string;
  source: string | null;
}
export interface StepNode {
  type: "step";
  key: string;
  name: string;
  instruction: string;
  performer: { selector: "class" | "same_as"; value: string };
  context:
    | { selector: "fresh"; value: null }
    | { selector: "continue_from"; value: string };
  consumes: ArtifactDraft[];
  produces: ArtifactDraft[];
}
export interface SequenceNode {
  type: "sequence";
  children: TacticNode[];
}
export interface ParallelNode {
  type: "parallel";
  children: TacticNode[];
}
export interface UntilNode {
  type: "until";
  check: TacticNode;
  condition: {
    artifact: ArtifactDraft;
    field: string;
    operator: "equals";
    value: string | number | boolean | null;
  };
  otherwise: TacticNode;
  max_remediations: number;
}
export interface TacticUseNode {
  type: "use";
  instance_key: string;
  tactic_definition_id: string;
}
export type TacticNode =
  | StepNode
  | SequenceNode
  | ParallelNode
  | UntilNode
  | TacticUseNode;
export type NodePath = Array<number | "check" | "otherwise">;
export interface TacticDraft {
  id: string | null;
  key: string;
  name: string;
  description: string;
  body: TacticNode;
}
export interface NodeEntry {
  node: TacticNode;
  path: NodePath;
  depth: number;
  branch: "root" | "child" | "check" | "otherwise";
}

export function draftFromTactic(tactic: Tactic): TacticDraft {
  return {
    id: tactic.id,
    key: tactic.key,
    name: tactic.name,
    description: tactic.description,
    body: cloneNode(tactic.body as unknown as TacticNode),
  };
}

export function emptyDraft(existingKeys: Iterable<string>): TacticDraft {
  return {
    id: null,
    key: availableProductKey("New Tactic", existingKeys, "tactic"),
    name: "",
    description: "",
    body: { type: "sequence", children: [] },
  };
}

export function cloneDraft(draft: TacticDraft): TacticDraft {
  return JSON.parse(JSON.stringify(draft)) as TacticDraft;
}
export function cloneNode(node: TacticNode): TacticNode {
  return JSON.parse(JSON.stringify(node)) as TacticNode;
}
export function draftSignature(draft: TacticDraft): string {
  return JSON.stringify(draft);
}
export function asJson(node: TacticNode): JsonValue {
  return node as unknown as JsonValue;
}

export function generatedTacticKey(
  name: string,
  existingKeys: Iterable<string>,
): string {
  return availableProductKey(name, existingKeys, "tactic");
}

export function localIdentities(body: TacticNode): string[] {
  return entries(body)
    .map(({ node }) =>
      node.type === "step"
        ? node.key
        : node.type === "use"
          ? node.instance_key
          : null,
    )
    .filter((value): value is string => value !== null);
}

export function generatedLocalKey(
  name: string,
  body: TacticNode,
  fallback = "step",
): string {
  return availableProductKey(name, localIdentities(body), fallback);
}

export function makeStep(
  name: string,
  body: TacticNode,
  classKey = "",
): StepNode {
  return {
    type: "step",
    key: generatedLocalKey(name, body),
    name,
    instruction: "",
    performer: { selector: "class", value: classKey },
    context: { selector: "fresh", value: null },
    consumes: [],
    produces: [],
  };
}

export function makeUse(tactic: Tactic, body: TacticNode): TacticUseNode {
  return {
    type: "use",
    instance_key: generatedLocalKey(tactic.name, body, "tactic"),
    tactic_definition_id: tactic.id,
  };
}

export function makeUntil(body: TacticNode, classKey = ""): UntilNode {
  const check = makeStep("Check", body, classKey);
  check.instruction = "Check whether the work is accepted.";
  check.produces = [{ type: "verdict", source: null }];
  const withCheck: SequenceNode = { type: "sequence", children: [check] };
  const otherwise = makeStep("Remediate", withCheck, classKey);
  otherwise.instruction = "Address the requested changes.";
  return {
    type: "until",
    check,
    condition: {
      artifact: { type: "verdict", source: check.key },
      field: "status",
      operator: "equals",
      value: "accepted",
    },
    otherwise,
    max_remediations: 2,
  };
}

export function entries(
  node: TacticNode,
  path: NodePath = [],
  depth = 0,
  branch: NodeEntry["branch"] = "root",
): NodeEntry[] {
  const current: NodeEntry[] = [{ node, path, depth, branch }];
  if (node.type === "sequence" || node.type === "parallel") {
    node.children.forEach((child, index) => {
      current.push(...entries(child, [...path, index], depth + 1, "child"));
    });
  } else if (node.type === "until") {
    current.push(
      ...entries(node.check, [...path, "check"], depth + 1, "check"),
    );
    current.push(
      ...entries(
        node.otherwise,
        [...path, "otherwise"],
        depth + 1,
        "otherwise",
      ),
    );
  }
  return current;
}

export function nodeAt(root: TacticNode, path: NodePath): TacticNode | null {
  let node = root;
  for (const part of path) {
    if (typeof part === "number") {
      if (node.type !== "sequence" && node.type !== "parallel") return null;
      const child = node.children[part];
      if (!child) return null;
      node = child;
    } else {
      if (node.type !== "until") return null;
      node = node[part];
    }
  }
  return node;
}

export function replaceNode(
  root: TacticNode,
  path: NodePath,
  replacement: TacticNode,
): TacticNode {
  if (!path.length) return replacement;
  const [part, ...rest] = path;
  if (
    typeof part === "number" &&
    (root.type === "sequence" || root.type === "parallel")
  ) {
    return {
      ...root,
      children: root.children.map((child, index) =>
        index === part ? replaceNode(child, rest, replacement) : child,
      ),
    };
  }
  if ((part === "check" || part === "otherwise") && root.type === "until")
    return { ...root, [part]: replaceNode(root[part], rest, replacement) };
  return root;
}

export function appendChild(
  root: TacticNode,
  path: NodePath,
  child: TacticNode,
): TacticNode {
  const container = nodeAt(root, path);
  if (
    !container ||
    (container.type !== "sequence" && container.type !== "parallel")
  )
    return root;
  return replaceNode(root, path, {
    ...container,
    children: [...container.children, child],
  });
}

export function insertAfter(
  root: TacticNode,
  path: NodePath,
  child: TacticNode,
): TacticNode {
  if (!path.length) return { type: "sequence", children: [root, child] };
  const parentPath = path.slice(0, -1);
  const index = path.at(-1);
  const parent = nodeAt(root, parentPath);
  if (
    typeof index !== "number" ||
    !parent ||
    (parent.type !== "sequence" && parent.type !== "parallel")
  )
    return root;
  const children = [...parent.children];
  children.splice(index + 1, 0, child);
  return replaceNode(root, parentPath, { ...parent, children });
}

export function removeNode(root: TacticNode, path: NodePath): TacticNode {
  if (!path.length) return { type: "sequence", children: [] };
  const parentPath = path.slice(0, -1);
  const index = path.at(-1);
  const parent = nodeAt(root, parentPath);
  if (
    typeof index !== "number" ||
    !parent ||
    (parent.type !== "sequence" && parent.type !== "parallel")
  )
    return root;
  const children = parent.children.filter(
    (_, childIndex) => childIndex !== index,
  );
  return replaceNode(root, parentPath, { ...parent, children });
}

export function moveNode(
  root: TacticNode,
  path: NodePath,
  direction: -1 | 1,
): { body: TacticNode; path: NodePath } {
  if (!path.length) return { body: root, path };
  const parentPath = path.slice(0, -1);
  const index = path.at(-1);
  const parent = nodeAt(root, parentPath);
  if (
    typeof index !== "number" ||
    !parent ||
    (parent.type !== "sequence" && parent.type !== "parallel")
  )
    return { body: root, path };
  const target = index + direction;
  if (target < 0 || target >= parent.children.length)
    return { body: root, path };
  const children = [...parent.children];
  const current = children[index];
  const replacement = children[target];
  if (!current || !replacement) return { body: root, path };
  children[index] = replacement;
  children[target] = current;
  return {
    body: replaceNode(root, parentPath, { ...parent, children }),
    path: [...parentPath, target],
  };
}

export function moveIntoPrevious(
  root: TacticNode,
  path: NodePath,
): { body: TacticNode; path: NodePath } {
  const index = path.at(-1);
  const parentPath = path.slice(0, -1);
  const parent = nodeAt(root, parentPath);
  if (
    typeof index !== "number" ||
    index < 1 ||
    !parent ||
    (parent.type !== "sequence" && parent.type !== "parallel")
  )
    return { body: root, path };
  const previous = parent.children[index - 1];
  const selected = parent.children[index];
  if (
    !previous ||
    !selected ||
    (previous.type !== "sequence" && previous.type !== "parallel")
  )
    return { body: root, path };
  const without = removeNode(root, path);
  const destination = [...parentPath, index - 1];
  return {
    body: appendChild(without, destination, selected),
    path: [...destination, previous.children.length],
  };
}

export function moveOut(
  root: TacticNode,
  path: NodePath,
): { body: TacticNode; path: NodePath } {
  if (path.length < 2) return { body: root, path };
  const index = path.at(-1);
  const parentIndex = path.at(-2);
  const parentPath = path.slice(0, -1);
  const grandparentPath = path.slice(0, -2);
  const parent = nodeAt(root, parentPath);
  const grandparent = nodeAt(root, grandparentPath);
  const selected = nodeAt(root, path);
  if (
    typeof index !== "number" ||
    typeof parentIndex !== "number" ||
    !selected ||
    !parent ||
    !grandparent ||
    (parent.type !== "sequence" && parent.type !== "parallel") ||
    (grandparent.type !== "sequence" && grandparent.type !== "parallel")
  )
    return { body: root, path };
  const without = removeNode(root, path);
  return {
    body: insertAfter(without, [...grandparentPath, parentIndex], selected),
    path: [...grandparentPath, parentIndex + 1],
  };
}

export function pathKey(path: NodePath): string {
  return path.length ? path.join(".") : "root";
}

export function steps(body: TacticNode): StepNode[] {
  return entries(body)
    .map(({ node }) => node)
    .filter((node): node is StepNode => node.type === "step");
}
export function uses(body: TacticNode): TacticUseNode[] {
  return entries(body)
    .map(({ node }) => node)
    .filter((node): node is TacticUseNode => node.type === "use");
}

export function localDraftIssues(draft: TacticDraft): string[] {
  const issues: string[] = [];
  if (!draft.name.trim()) issues.push("Give this Tactic a name.");
  if (!/^[a-z][a-z0-9-]{0,63}$/.test(draft.key))
    issues.push("The Tactic key is not valid.");
  const identities = localIdentities(draft.body);
  if (new Set(identities).size !== identities.length)
    issues.push("Step and reused-Tactic keys must be unique.");
  for (const entry of entries(draft.body)) {
    if (entry.node.type === "step") {
      if (!/^[a-z][a-z0-9-]{0,63}$/.test(entry.node.key))
        issues.push(`${entry.node.name || "A Step"} has an invalid key.`);
      if (!entry.node.name.trim()) issues.push("Every Step needs a name.");
      if (!entry.node.instruction.trim())
        issues.push(`${entry.node.name || "A Step"} needs an instruction.`);
      if (!entry.node.performer.value)
        issues.push(
          `${entry.node.name || "A Step"} needs a performer requirement.`,
        );
      for (const artifact of [...entry.node.consumes, ...entry.node.produces])
        if (!artifact.type.trim())
          issues.push(
            `${entry.node.name || "A Step"} has an unnamed artifact.`,
          );
    } else if (
      (entry.node.type === "sequence" || entry.node.type === "parallel") &&
      entry.node.children.length === 0
    ) {
      issues.push(
        entry.node.type === "sequence"
          ? "Add at least one item to this sequence."
          : "Add at least one parallel branch.",
      );
    }
  }
  return [...new Set(issues)];
}

export function usageFor(
  tacticId: string,
  tactics: Tactic[],
  quests: Array<{
    tactic_source: { type: string; tactic_definition_id?: string };
  }>,
): { quests: number; tactics: number } {
  return {
    quests: quests.filter(
      (quest) =>
        quest.tactic_source.type === "definition" &&
        quest.tactic_source.tactic_definition_id === tacticId,
    ).length,
    tactics: tactics.filter(
      (tactic) =>
        tactic.id !== tacticId &&
        uses(tactic.body as unknown as TacticNode).some(
          (use) => use.tactic_definition_id === tacticId,
        ),
    ).length,
  };
}

export function displayNodeName(node: TacticNode, tactics: Tactic[]): string {
  if (node.type === "step")
    return node.name || productKeyBase(node.key, "Step");
  if (node.type === "sequence") return "Sequence";
  if (node.type === "parallel") return "Parallel work";
  if (node.type === "until") return "Repeat until accepted";
  return (
    tactics.find((tactic) => tactic.id === node.tactic_definition_id)?.name ??
    "Reusable Tactic"
  );
}
