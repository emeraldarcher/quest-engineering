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
export interface ArtifactSourceCandidate {
  ref: ArtifactRefDraft;
  kind: string;
  label: string;
  semantic?: "current" | "rejected_review";
}
export interface DraftValidationIssue {
  id: string;
  message: string;
  view: "details" | "interface" | "node";
  path?: NodePath;
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
  const subjectCandidates = entries(body).flatMap(({ node }) =>
    node.type === "step"
      ? node.produces
          .filter(
            (output) =>
              output.kind === "quest_plan" || output.kind === "change_set",
          )
          .map((output) => ({
            ref: { producer: node.key, output: output.name },
            kind: output.kind,
            producer: node,
          }))
      : [],
  );
  const subject = subjectCandidates.length === 1 ? subjectCandidates[0] : null;
  const checkName =
    subject?.kind === "quest_plan"
      ? "Review Plan"
      : subject?.kind === "change_set"
        ? "Review Implementation"
        : "Check";
  const check = makeStep(checkName, body, classKey);
  check.instruction = subject
    ? `Review the current ${artifactTypeLabel(subject.kind)}.`
    : "Check whether the work is accepted.";
  if (subject) {
    const subjectInput =
      subject.kind === "quest_plan" ? "current_plan" : "current_change_set";
    check.consumes = [
      {
        name: subjectInput,
        kind: subject.kind,
        source: subject.ref,
        required: true,
      },
    ];
    check.produces = [
      {
        name: "verdict",
        kind: "review_verdict",
        review: {
          gate_key:
            subject.kind === "quest_plan"
              ? "plan_acceptance"
              : "implementation_acceptance",
          subject_input: subjectInput,
        },
      },
    ];
  } else {
    check.produces = [{ name: "result", kind: "", review: null }];
  }

  const withCheck: SequenceNode = {
    type: "sequence",
    children: [body, check],
  };
  const otherwise = makeStep("Remediate", withCheck, classKey);
  otherwise.instruction = "Address the requested changes.";
  if (subject) {
    const subjectInput =
      subject.kind === "quest_plan" ? "current_plan" : "current_change_set";
    otherwise.performer = { selector: "same_as", value: subject.producer.key };
    otherwise.consumes = [
      {
        name: subjectInput,
        kind: subject.kind,
        source: subject.ref,
        required: true,
      },
      {
        name: "review_feedback",
        kind: "review_verdict",
        source: { producer: check.key, output: "verdict" },
        required: true,
      },
    ];
    otherwise.produces = [
      {
        name: subject.kind === "quest_plan" ? "plan" : "change_set",
        kind: subject.kind,
        review: null,
      },
    ];
  }

  return {
    type: "until",
    check,
    condition: {
      source: {
        producer: check.key,
        output: subject ? "verdict" : "result",
      },
      field: "status",
      operator: "equals",
      value: "accepted",
    },
    otherwise,
    max_remediations: subject?.kind === "quest_plan" ? 2 : 3,
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

export function generatedArtifactName(
  label: string,
  kind: string,
  direction: "input" | "output",
  existingNames: Iterable<string>,
): string {
  const semantic = label.toLocaleLowerCase();
  let base: string;
  if (direction === "output") {
    base =
      kind === "quest_plan"
        ? "plan"
        : kind === "change_set"
          ? "change_set"
          : kind === "review_verdict"
            ? "verdict"
            : portKeyBase(label, kind, direction);
  } else if (semantic.includes("review feedback")) {
    base = "review_feedback";
  } else if (semantic.includes("current") && kind === "quest_plan") {
    base = "current_plan";
  } else if (semantic.includes("current") && kind === "change_set") {
    base = "current_change_set";
  } else if (kind === "review_verdict") {
    base = "review_feedback";
  } else {
    base = portKeyBase(label, kind, direction);
  }
  const existing = new Set(existingNames);
  if (!existing.has(base)) return base;
  let suffix = 2;
  while (existing.has(`${base}_${suffix}`)) suffix += 1;
  return `${base}_${suffix}`;
}

export function suggestedInputLabel(
  kind: string,
  candidate?: ArtifactSourceCandidate,
): string {
  if (candidate?.semantic === "rejected_review" || kind === "review_verdict")
    return "Review Feedback";
  if (kind === "quest_plan") return "Current Quest Plan";
  if (kind === "change_set") return "Current Change Set";
  return kind ? artifactTypeLabel(kind) : "New Input";
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

function renamedReference(
  reference: ArtifactRefDraft | null,
  producer: string,
  oldOutput: string,
  newOutput: string,
): ArtifactRefDraft | null {
  return reference?.producer === producer && reference.output === oldOutput
    ? { ...reference, output: newOutput }
    : reference;
}

export function renameArtifactOutputReferences(
  draft: TacticDraft,
  producer: string,
  oldOutput: string,
  newOutput: string,
): TacticDraft {
  const rewrite = (node: TacticNode): TacticNode => {
    if (node.type === "step")
      return {
        ...node,
        consumes: node.consumes.map((input) => ({
          ...input,
          source: renamedReference(
            input.source,
            producer,
            oldOutput,
            newOutput,
          ),
        })),
      };
    if (node.type === "sequence" || node.type === "parallel")
      return { ...node, children: node.children.map(rewrite) };
    if (node.type === "until")
      return {
        ...node,
        check: rewrite(node.check),
        otherwise: rewrite(node.otherwise),
        condition: {
          ...node.condition,
          source:
            renamedReference(
              node.condition.source,
              producer,
              oldOutput,
              newOutput,
            ) ?? node.condition.source,
        },
      };
    return {
      ...node,
      input_bindings: node.input_bindings.map((binding) => ({
        ...binding,
        source:
          renamedReference(binding.source, producer, oldOutput, newOutput) ??
          binding.source,
      })),
    };
  };
  return {
    ...draft,
    body: rewrite(draft.body),
    interface: {
      ...draft.interface,
      outputs: draft.interface.outputs.map((port) =>
        port.source.type === "binding"
          ? {
              ...port,
              source: {
                type: "binding" as const,
                binding:
                  renamedReference(
                    port.source.binding,
                    producer,
                    oldOutput,
                    newOutput,
                  ) ?? port.source.binding,
              },
            }
          : port,
      ),
    },
  };
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

function samePath(left: NodePath, right: NodePath): boolean {
  return (
    left.length === right.length &&
    left.every((part, index) => part === right[index])
  );
}

export function enclosingUntil(
  root: TacticNode,
  path: NodePath,
): { node: UntilNode; path: NodePath; phase: "check" | "otherwise" } | null {
  let node = root;
  const traversed: NodePath = [];
  for (const part of path) {
    if (node.type === "until" && (part === "check" || part === "otherwise"))
      return { node, path: [...traversed], phase: part };
    if (
      typeof part === "number" &&
      (node.type === "sequence" || node.type === "parallel")
    ) {
      const child = node.children[part];
      if (!child) return null;
      node = child;
      traversed.push(part);
    } else if (
      (part === "check" || part === "otherwise") &&
      node.type === "until"
    ) {
      node = node[part];
      traversed.push(part);
    } else return null;
  }
  return null;
}

export function artifactKindForRef(
  draft: TacticDraft,
  tactics: Tactic[],
  reference: ArtifactRefDraft,
): string | null {
  if (reference.producer === "$inputs")
    return (
      draft.interface.inputs.find((port) => port.key === reference.output)
        ?.kind ?? null
    );
  for (const { node } of entries(draft.body)) {
    if (node.type === "step" && node.key === reference.producer)
      return (
        node.produces.find((output) => output.name === reference.output)
          ?.kind ?? null
      );
    if (node.type === "use" && node.instance_key === reference.producer) {
      const tactic = tactics.find(
        (item) => item.id === node.tactic_definition_id,
      );
      return (
        tactic?.interface.outputs.find(
          (output) => output.key === reference.output,
        )?.kind ?? null
      );
    }
  }
  return null;
}

function reviewSourceLabel(
  step: StepNode,
  output: ArtifactOutputDraft,
): string {
  const gate = output.review?.gate_key;
  if (gate === "plan_acceptance") return "Latest rejected Plan Review";
  if (gate === "implementation_acceptance")
    return "Latest rejected Implementation Review";
  return `${step.name} → Rejected Verdict`;
}

export function artifactSourcesFor(
  draft: TacticDraft,
  tactics: Tactic[],
  consumerPath: NodePath,
  kind = "",
): ArtifactSourceCandidate[] {
  const all = entries(draft.body);
  const selectedIndex = all.findIndex((entry) =>
    samePath(entry.path, consumerPath),
  );
  const upstream = selectedIndex < 0 ? all : all.slice(0, selectedIndex);
  const candidates: ArtifactSourceCandidate[] = [
    ...draft.interface.inputs.map((port) => ({
      ref: { producer: "$inputs", output: port.key },
      kind: port.kind,
      label: `Tactic Input → ${port.label}`,
    })),
    ...upstream.flatMap(({ node }) => {
      if (node.type === "step")
        return node.produces.map((output) => ({
          ref: { producer: node.key, output: output.name },
          kind: output.kind,
          label: `${node.name} → ${artifactContractLabel(node, output, "produces")}`,
        }));
      if (node.type === "use") {
        const tactic = tactics.find(
          (item) => item.id === node.tactic_definition_id,
        );
        return (tactic?.interface.outputs ?? []).map((output) => ({
          ref: { producer: node.instance_key, output: output.key },
          kind: output.kind,
          label: `${tactic?.name ?? "Reusable Tactic"} → ${output.label}`,
        }));
      }
      return [];
    }),
  ];
  const context = enclosingUntil(draft.body, consumerPath);
  const contextual = candidates.map((candidate) => {
    if (!context) return candidate;
    if (context.phase === "otherwise") {
      const checkOutput = steps(context.node.check).flatMap((step) =>
        step.produces
          .filter(
            (output) =>
              step.key === candidate.ref.producer &&
              output.name === candidate.ref.output &&
              output.kind === "review_verdict",
          )
          .map((output) => ({ step, output })),
      )[0];
      if (checkOutput)
        return {
          ...candidate,
          label: reviewSourceLabel(checkOutput.step, checkOutput.output),
          semantic: "rejected_review" as const,
        };
    }
    const carried = steps(context.node.otherwise).some((step) =>
      step.produces.some((output) => output.kind === candidate.kind),
    );
    const consumedByCheck = steps(context.node.check).some((step) =>
      step.consumes.some((input) => input.kind === candidate.kind),
    );
    const producedInsideRegion = entries(context.node).some(({ node }) =>
      node.type === "step"
        ? node.key === candidate.ref.producer
        : node.type === "use" && node.instance_key === candidate.ref.producer,
    );
    if (carried && consumedByCheck && !producedInsideRegion)
      return {
        ...candidate,
        label: `Current ${artifactTypeLabel(candidate.kind)}`,
        semantic: "current" as const,
      };
    return candidate;
  });
  const filtered = contextual.filter(
    (candidate) => (!kind || candidate.kind === kind) && candidate.kind,
  );
  return filtered.filter(
    (candidate, index) =>
      filtered.findIndex(
        (item) =>
          item.ref.producer === candidate.ref.producer &&
          item.ref.output === candidate.ref.output,
      ) === index,
  );
}

function friendlySlotName(name: string): string {
  if (name === "current_plan") return "Current Quest Plan";
  if (name === "current_change_set") return "Current Change Set";
  if (name === "review_feedback") return "Review Feedback";
  if (name === "plan") return "Quest Plan";
  return name
    .replaceAll("_", " ")
    .replaceAll("-", " ")
    .replace(/\b\w/g, (letter) => letter.toLocaleUpperCase());
}

export function draftValidationIssues(
  draft: TacticDraft,
  tactics: Tactic[] = [],
): DraftValidationIssue[] {
  const issues: DraftValidationIssue[] = [];
  const add = (issue: DraftValidationIssue) => {
    if (!issues.some((current) => current.id === issue.id)) issues.push(issue);
  };
  if (!draft.name.trim())
    add({
      id: "tactic:name",
      message: "Give this Tactic a name.",
      view: "details",
    });
  if (!/^[a-z][a-z0-9-]{0,63}$/.test(draft.key))
    add({
      id: "tactic:key",
      message: "The generated Tactic key needs a valid name.",
      view: "details",
    });
  const identities = localIdentities(draft.body);
  if (new Set(identities).size !== identities.length)
    add({
      id: "tactic:identities",
      message: "Step and reused-Tactic keys must be unique.",
      view: "node",
    });

  const allEntries = entries(draft.body);
  const producers = new Map<string, Set<string> | null>();
  const gateKinds = new Map<string, Set<string>>();
  for (const { node } of allEntries) {
    if (node.type === "step") {
      producers.set(
        node.key,
        new Set(node.produces.map((output) => output.name)),
      );
      for (const output of node.produces) {
        if (!output.review) continue;
        const subject = node.consumes.find(
          (input) => input.name === output.review?.subject_input,
        );
        if (!subject?.kind) continue;
        const kinds =
          gateKinds.get(output.review.gate_key) ?? new Set<string>();
        kinds.add(subject.kind);
        gateKinds.set(output.review.gate_key, kinds);
      }
    } else if (node.type === "use") producers.set(node.instance_key, null);
  }
  const validReference = (reference: ArtifactRefDraft): boolean => {
    if (reference.producer === "$inputs")
      return draft.interface.inputs.some(
        (port) => port.key === reference.output,
      );
    const outputs = producers.get(reference.producer);
    if (outputs !== null) return Boolean(outputs?.has(reference.output));
    return Boolean(artifactKindForRef(draft, tactics, reference));
  };

  for (const entry of allEntries) {
    const { node, path } = entry;
    if (node.type === "step") {
      const stepName = node.name || "A Step";
      if (!/^[a-z][a-z0-9-]{0,63}$/.test(node.key))
        add({
          id: `step:${node.key}:key`,
          message: `${stepName} has an invalid stable key.`,
          view: "node",
          path,
        });
      if (!node.name.trim())
        add({
          id: `step:${node.key}:name`,
          message: "Every Step needs a name.",
          view: "node",
          path,
        });
      if (!node.instruction.trim())
        add({
          id: `step:${node.key}:instruction`,
          message: `${stepName} needs an instruction.`,
          view: "node",
          path,
        });
      if (!node.performer.value)
        add({
          id: `step:${node.key}:performer`,
          message: `${stepName} needs a performer.`,
          view: "node",
          path,
        });

      for (const [index, input] of node.consumes.entries()) {
        const inputLabel = input.name
          ? input.kind
            ? artifactContractLabel(node, input, "consumes")
            : friendlySlotName(input.name)
          : `Input ${index + 1}`;
        if (!input.name.trim())
          add({
            id: `step:${node.key}:input:${index}:name`,
            message: `${stepName} has an input that needs a name.`,
            view: "node",
            path,
          });
        if (!input.kind.trim())
          add({
            id: `step:${node.key}:input:${index}:kind`,
            message: `${stepName} → ${inputLabel} needs an artifact type.`,
            view: "node",
            path,
          });
        if (input.source && !validReference(input.source))
          add({
            id: `step:${node.key}:input:${index}:source`,
            message: `${stepName} → ${inputLabel} is connected to an unavailable output.`,
            view: "node",
            path,
          });
        const sourceKind = input.source
          ? artifactKindForRef(draft, tactics, input.source)
          : null;
        if (input.kind && sourceKind && sourceKind !== input.kind)
          add({
            id: `step:${node.key}:input:${index}:kind-mismatch`,
            message: `${stepName} → ${inputLabel} expects ${artifactTypeLabel(input.kind)}, but its source produces ${artifactTypeLabel(sourceKind)}.`,
            view: "node",
            path,
          });
        if (
          input.kind &&
          !input.source &&
          artifactSourcesFor(draft, tactics, path, input.kind).length > 1
        )
          add({
            id: `step:${node.key}:input:${index}:ambiguous`,
            message: `${stepName} → ${inputLabel} has multiple compatible sources. Choose one.`,
            view: "node",
            path,
          });
      }
      if (
        new Set(node.consumes.map((input) => input.name)).size !==
        node.consumes.length
      )
        add({
          id: `step:${node.key}:input:names`,
          message: `${stepName} input names must be unique.`,
          view: "node",
          path,
        });

      for (const [index, output] of node.produces.entries()) {
        const outputLabel = output.name
          ? output.kind
            ? artifactContractLabel(node, output, "produces")
            : friendlySlotName(output.name)
          : `Output ${index + 1}`;
        if (!output.name.trim())
          add({
            id: `step:${node.key}:output:${index}:name`,
            message: `${stepName} has an output that needs a name.`,
            view: "node",
            path,
          });
        if (!output.kind.trim())
          add({
            id: `step:${node.key}:output:${index}:kind`,
            message: `${stepName} → ${outputLabel} needs an artifact type.`,
            view: "node",
            path,
          });
        if (output.kind === "review_verdict") {
          const subject = node.consumes.find(
            (input) => input.name === output.review?.subject_input,
          );
          if (!output.review || !subject)
            add({
              id: `step:${node.key}:output:${index}:review-subject`,
              message: `${stepName} needs an artifact to review.`,
              view: "node",
              path,
            });
          if (!output.review?.gate_key)
            add({
              id: `step:${node.key}:output:${index}:review-gate`,
              message: `${stepName} needs an acceptance gate.`,
              view: "node",
              path,
            });
          if (
            subject?.kind === "quest_plan" &&
            output.review?.gate_key === "implementation_acceptance"
          )
            add({
              id: `step:${node.key}:output:${index}:review-gate-mismatch`,
              message: `${stepName} reviews a Quest Plan, so choose Plan Acceptance.`,
              view: "node",
              path,
            });
          if (
            subject?.kind === "change_set" &&
            output.review?.gate_key === "plan_acceptance"
          )
            add({
              id: `step:${node.key}:output:${index}:review-gate-mismatch`,
              message: `${stepName} reviews a Change Set, so choose Implementation Acceptance.`,
              view: "node",
              path,
            });
        } else if (output.review)
          add({
            id: `step:${node.key}:output:${index}:unexpected-review`,
            message: `${stepName} has review settings on an output that is not a Review Verdict.`,
            view: "node",
            path,
          });
      }
    } else if (node.type === "until") {
      if (!Number.isInteger(node.max_remediations) || node.max_remediations < 1)
        add({
          id: `until:${pathKey(path)}:limit`,
          message:
            "Maximum remediation iterations must be a positive whole number.",
          view: "node",
          path,
        });
      if (!validReference(node.condition.source))
        add({
          id: `until:${pathKey(path)}:condition`,
          message: "Choose what this loop is waiting for.",
          view: "node",
          path,
        });
      const conditionKind = artifactKindForRef(
        draft,
        tactics,
        node.condition.source,
      );
      if (conditionKind === "review_verdict") {
        const reviewStep = steps(node.check).find((step) =>
          step.produces.some(
            (output) =>
              step.key === node.condition.source.producer &&
              output.name === node.condition.source.output &&
              output.kind === "review_verdict",
          ),
        );
        const verdict = reviewStep?.produces.find(
          (output) => output.name === node.condition.source.output,
        );
        if (!verdict?.review)
          add({
            id: `until:${pathKey(path)}:review-contract`,
            message: `${reviewStep?.name ?? "The Review Step"} must define what it reviews before acceptance can be evaluated.`,
            view: "node",
            path: reviewStep
              ? (allEntries.find((item) => item.node === reviewStep)?.path ??
                path)
              : path,
          });
      }
    } else if (
      (node.type === "sequence" || node.type === "parallel") &&
      node.children.length === 0
    )
      add({
        id: `container:${pathKey(path)}:empty`,
        message:
          node.type === "sequence"
            ? "Add at least one item to this sequence."
            : "Add at least one parallel branch.",
        view: "node",
        path,
      });
    else if (node.type === "use") {
      for (const [index, binding] of node.input_bindings.entries()) {
        if (!validReference(binding.source))
          add({
            id: `use:${node.instance_key}:binding:${index}`,
            message:
              "A reused Tactic input is connected to an unavailable output.",
            view: "node",
            path,
          });
      }
    }
  }

  for (const [index, port] of draft.interface.inputs.entries()) {
    if (!port.key.trim() || !port.label.trim() || !port.kind.trim())
      add({
        id: `interface:input:${index}`,
        message: `${port.label || `Tactic input ${index + 1}`} needs a name and artifact type.`,
        view: "interface",
      });
  }
  for (const [index, port] of draft.interface.outputs.entries()) {
    const label = port.label || `Tactic output ${index + 1}`;
    if (!port.key.trim() || !port.label.trim() || !port.kind.trim())
      add({
        id: `interface:output:${index}:contract`,
        message: `${label} needs a name and artifact type.`,
        view: "interface",
      });
    if (port.source.type === "binding") {
      if (!validReference(port.source.binding))
        add({
          id: `interface:output:${index}:source`,
          message: `${label} needs an export source.`,
          view: "interface",
        });
      const sourceKind = artifactKindForRef(
        draft,
        tactics,
        port.source.binding,
      );
      if (port.kind && sourceKind && sourceKind !== port.kind)
        add({
          id: `interface:output:${index}:source-kind`,
          message: `${label} cannot export ${artifactTypeLabel(sourceKind)} as ${artifactTypeLabel(port.kind)}.`,
          view: "interface",
        });
    } else {
      const kinds = gateKinds.get(port.source.gate_key);
      if (!kinds?.has(port.kind))
        add({
          id: `interface:output:${index}:accepted-source`,
          message: `${label} needs an acceptance gate for ${artifactTypeLabel(port.kind)}.`,
          view: "interface",
        });
    }
  }
  const portKeys = [...draft.interface.inputs, ...draft.interface.outputs].map(
    (port) => port.key,
  );
  if (new Set(portKeys).size !== portKeys.length)
    add({
      id: "interface:keys",
      message: "Tactic interface port keys must be unique.",
      view: "interface",
    });
  return issues;
}

export function localDraftIssues(draft: TacticDraft): string[] {
  return draftValidationIssues(draft).map((issue) => issue.message);
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
