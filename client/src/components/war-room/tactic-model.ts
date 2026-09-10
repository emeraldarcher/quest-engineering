import type { JsonValue, Tactic } from "../../api/contracts";
import {
  availableProductKey,
  productKeyBase,
} from "../management/management-key";

export interface ArtifactRefDraft {
  producer: string;
  output: string;
}
export interface ArtifactInputDraft {
  name: string;
  kind: string;
  source: ArtifactRefDraft | null;
  required: boolean;
}
export interface ArtifactOutputDraft {
  name: string;
  kind: string;
  review: { gate_key: string; subject_input: string } | null;
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
  consumes: ArtifactInputDraft[];
  produces: ArtifactOutputDraft[];
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
    source: ArtifactRefDraft;
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
  input_bindings: Array<{ input: string; source: ArtifactRefDraft }>;
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
  interface: Tactic["interface"];
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
    interface: JSON.parse(
      JSON.stringify(tactic.interface),
    ) as Tactic["interface"],
  };
}

export function emptyDraft(existingKeys: Iterable<string>): TacticDraft {
  return {
    id: null,
    key: availableProductKey("New Tactic", existingKeys, "tactic"),
    name: "",
    description: "",
    body: { type: "sequence", children: [] },
    interface: { inputs: [], outputs: [] },
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

export function portKeyBase(
  label: string,
  kind: string,
  direction: "input" | "output",
  acceptedSubject = false,
): string {
  if (kind === "quest_plan")
    return direction === "output" && acceptedSubject ? "accepted_plan" : "plan";
  if (kind === "change_set")
    return direction === "output" && acceptedSubject
      ? "accepted_change_set"
      : "change_set";
  if (kind === "review_verdict") return "verdict";
  const normalized = label
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  const prefixed = /^[a-z]/.test(normalized)
    ? normalized
    : `${direction}_${normalized}`;
  return (prefixed || direction).slice(0, 64).replace(/_+$/, "");
}

export function generatedPortKey(
  label: string,
  kind: string,
  direction: "input" | "output",
  existingKeys: Iterable<string>,
  acceptedSubject = false,
): string {
  const existing = new Set(existingKeys);
  const base = portKeyBase(label, kind, direction, acceptedSubject);
  if (!existing.has(base)) return base;
  let suffix = 2;
  while (suffix < 10_000) {
    const ending = `_${suffix}`;
    const candidate = `${base.slice(0, 64 - ending.length).replace(/_+$/, "")}${ending}`;
    if (!existing.has(candidate)) return candidate;
    suffix += 1;
  }
  throw new Error("Unable to derive an available Tactic port key.");
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
    input_bindings: [],
  };
}

export function makeUntil(body: TacticNode, classKey = ""): UntilNode {
  const check = makeStep("Check", body, classKey);
  check.instruction = "Check whether the work is accepted.";
  check.produces = [{ name: "result", kind: "check_result", review: null }];
  const withCheck: SequenceNode = { type: "sequence", children: [check] };
  const otherwise = makeStep("Remediate", withCheck, classKey);
  otherwise.instruction = "Address the requested changes.";
  return {
    type: "until",
    check,
    condition: {
      source: { producer: check.key, output: "result" },
      field: "status",
      operator: "equals",
      value: "accepted",
    },
    otherwise,
    max_remediations: 3,
  };
}

export type RemediationKind =
  | "plan_revision"
  | "implementation_repair"
  | "generic";

export function remediationKind(node: UntilNode): RemediationKind {
  const check = steps(node.check);
  const otherwise = steps(node.otherwise);
  const conditionOutput = check
    .find((step) => step.key === node.condition.source.producer)
    ?.produces.find((output) => output.name === node.condition.source.output);
  const gate = conditionOutput?.review?.gate_key;
  const planShaped =
    gate === "plan_acceptance" ||
    (check.some((step) =>
      step.consumes.some((item) => item.kind === "quest_plan"),
    ) &&
      otherwise.some((step) =>
        step.produces.some((item) => item.kind === "quest_plan"),
      ));
  if (planShaped) return "plan_revision";

  const reviewShaped = conditionOutput?.kind === "review_verdict";
  const changeSetShaped =
    check.some((step) =>
      step.consumes.some((item) => item.kind === "change_set"),
    ) ||
    otherwise.some((step) =>
      step.produces.some((item) => item.kind === "change_set"),
    );
  const names = [...check, ...otherwise].map((step) =>
    step.name.toLocaleLowerCase(),
  );
  if (
    reviewShaped &&
    (changeSetShaped || names.some((name) => name.includes("repair")))
  )
    return "implementation_repair";
  return "generic";
}

export function isPlanRevisionUntil(node: UntilNode): boolean {
  return remediationKind(node) === "plan_revision";
}

export function isReviewRemediationUntil(node: UntilNode): boolean {
  return remediationKind(node) === "implementation_repair";
}

export const BUILT_IN_ARTIFACT_KINDS = [
  "quest_plan",
  "change_set",
  "review_verdict",
] as const;

export function artifactTypeLabel(type: string): string {
  const labels: Record<string, string> = {
    quest_plan: "Quest Plan",
    change_set: "Change Set",
    review_verdict: "Review Verdict",
  };
  const known = labels[type];
  if (known) return known;
  const words = type.replaceAll("_", " ").replaceAll("-", " ").trim();
  return words
    ? words.replace(/\b\w/g, (letter) => letter.toLocaleUpperCase())
    : "Artifact";
}

export function artifactContractLabel(
  step: Pick<StepNode, "name">,
  artifact: ArtifactInputDraft | ArtifactOutputDraft,
  direction: "consumes" | "produces",
): string {
  const name = step.name.toLocaleLowerCase();
  if (artifact.kind === "quest_plan" && direction === "consumes") {
    if (name.includes("implement")) return "Accepted Quest Plan";
    return "Current Quest Plan";
  }
  if (artifact.kind === "quest_plan" && direction === "produces")
    return name.includes("revis") ? "Updated Quest Plan" : "Quest Plan";
  if (artifact.kind === "review_verdict" && direction === "consumes")
    return "Latest rejected Review Verdict";
  if (artifact.kind === "review_verdict") return "Review Verdict";
  if (artifact.kind === "change_set" && direction === "consumes")
    return "Current Change Set";
  return artifactTypeLabel(artifact.kind);
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
  return removeNodeWithSelection(root, path).body;
}

export function removeNodeWithSelection(
  root: TacticNode,
  path: NodePath,
): { body: TacticNode; path: NodePath; removed: boolean } {
  if (!path.length)
    return {
      body: { type: "sequence", children: [] },
      path: [],
      removed: true,
    };

  const parentPath = path.slice(0, -1);
  const part = path.at(-1);
  const parent = nodeAt(root, parentPath);
  if (!parent) return { body: root, path, removed: false };

  if ((part === "check" || part === "otherwise") && parent.type === "until") {
    return {
      body: replaceNode(root, parentPath, {
        ...parent,
        [part]: { type: "sequence", children: [] },
      }),
      path: parentPath,
      removed: true,
    };
  }

  if (
    typeof part !== "number" ||
    (parent.type !== "sequence" && parent.type !== "parallel")
  )
    return { body: root, path, removed: false };

  const children = parent.children.filter((_, index) => index !== part);
  const body = replaceNode(root, parentPath, { ...parent, children });
  if (!children.length) return { body, path: parentPath, removed: true };
  return {
    body,
    path: [...parentPath, Math.min(part, children.length - 1)],
    removed: true,
  };
}

export function subtreeSize(node: TacticNode): number {
  return entries(node).length;
}

export function referencedOutputsForRemoval(
  draft: TacticDraft,
  path: NodePath,
): string[] {
  const selected = nodeAt(draft.body, path);
  if (!selected) return [];
  const removedNodes = entries(selected).map(({ node }) => node);
  const producers = new Set(
    removedNodes.flatMap((node) =>
      node.type === "step"
        ? [node.key]
        : node.type === "use"
          ? [node.instance_key]
          : [],
    ),
  );
  const removedGates = new Set(
    removedNodes.flatMap((node) =>
      node.type === "step"
        ? node.produces.flatMap((output) =>
            output.review ? [output.review.gate_key] : [],
          )
        : [],
    ),
  );
  const references: string[] = [];
  for (const { node } of entries(draft.body)) {
    if (removedNodes.includes(node)) continue;
    if (node.type === "step") {
      for (const input of node.consumes) {
        if (input.source && producers.has(input.source.producer))
          references.push(`${node.name} → ${artifactTypeLabel(input.kind)}`);
      }
    } else if (node.type === "use") {
      for (const binding of node.input_bindings) {
        if (producers.has(binding.source.producer))
          references.push(`${displayNodeName(node, [])} → ${binding.input}`);
      }
    } else if (
      node.type === "until" &&
      producers.has(node.condition.source.producer)
    ) {
      references.push("Repeat until condition");
    }
  }
  for (const output of draft.interface.outputs) {
    if (
      (output.source.type === "binding" &&
        producers.has(output.source.binding.producer)) ||
      (output.source.type === "accepted_subject" &&
        removedGates.has(output.source.gate_key))
    )
      references.push(`Tactic output → ${output.label}`);
  }
  return [...new Set(references)];
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
      for (const artifact of [...entry.node.consumes, ...entry.node.produces]) {
        if (!artifact.name.trim())
          issues.push(
            `${entry.node.name || "A Step"} has an unnamed artifact slot.`,
          );
        if (!artifact.kind.trim())
          issues.push(
            `${entry.node.name || "A Step"} has an artifact without a type.`,
          );
      }
    } else if (entry.node.type === "until") {
      if (
        !Number.isInteger(entry.node.max_remediations) ||
        entry.node.max_remediations < 1
      )
        issues.push(
          "Maximum remediation iterations must be a positive whole number.",
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
  for (const port of draft.interface.inputs) {
    if (!port.key.trim() || !port.label.trim() || !port.kind.trim())
      issues.push("Every Tactic input needs a key, name, and artifact type.");
  }
  for (const port of draft.interface.outputs) {
    if (!port.key.trim() || !port.label.trim() || !port.kind.trim())
      issues.push("Every Tactic output needs a key, name, and artifact type.");
    if (
      port.source.type === "binding" &&
      (!port.source.binding.producer || !port.source.binding.output)
    )
      issues.push(
        `${port.label || "A Tactic output"} needs a specific internal output.`,
      );
  }

  const producers = new Map<string, Set<string> | null>();
  const gates = new Set<string>();
  for (const { node } of entries(draft.body)) {
    if (node.type === "step") {
      producers.set(
        node.key,
        new Set(node.produces.map((output) => output.name)),
      );
      for (const output of node.produces) {
        if (output.review) gates.add(output.review.gate_key);
      }
    } else if (node.type === "use") {
      producers.set(node.instance_key, null);
    }
  }
  const validReference = (reference: ArtifactRefDraft): boolean => {
    if (reference.producer === "$inputs")
      return draft.interface.inputs.some(
        (port) => port.key === reference.output,
      );
    const outputs = producers.get(reference.producer);
    return outputs === null || Boolean(outputs?.has(reference.output));
  };
  for (const { node } of entries(draft.body)) {
    if (node.type === "step") {
      for (const input of node.consumes) {
        if (input.source && !validReference(input.source))
          issues.push(
            `${node.name} has an input connected to a removed output.`,
          );
      }
    } else if (node.type === "use") {
      for (const binding of node.input_bindings) {
        if (!validReference(binding.source))
          issues.push(
            "A reused Tactic input is connected to a removed output.",
          );
      }
    } else if (
      node.type === "until" &&
      !validReference(node.condition.source)
    ) {
      issues.push("A Repeat until condition uses a removed output.");
    }
  }
  for (const port of draft.interface.outputs) {
    if (port.source.type === "binding" && !validReference(port.source.binding))
      issues.push(
        `${port.label || "A Tactic output"} exports a removed output.`,
      );
    if (
      port.source.type === "accepted_subject" &&
      !gates.has(port.source.gate_key)
    )
      issues.push(
        `${port.label || "A Tactic output"} uses an unavailable acceptance gate.`,
      );
  }

  const portKeys = [...draft.interface.inputs, ...draft.interface.outputs].map(
    (port) => port.key,
  );
  if (new Set(portKeys).size !== portKeys.length)
    issues.push("Tactic interface port keys must be unique.");
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
