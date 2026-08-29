import type { ApiClient } from "../api/client";
import type { ExecutionOption, Workspace } from "../api/contracts";

export interface StarterChoice {
  option: ExecutionOption;
  workspace: Workspace;
}

export async function createStarterCrew(
  api: ApiClient,
  choice: StarterChoice,
): Promise<void> {
  const { option } = choice;
  const model = option.model;
  const codingTools = option.tools.filter((tool) =>
    ["workspace.filesystem", "workspace.search", "terminal.shell"].includes(
      tool,
    ),
  );
  const reviewTools = option.tools.filter((tool) =>
    ["workspace.filesystem", "workspace.search"].includes(tool),
  );
  const codingAccess = bestAccess(
    choice.option,
    choice.workspace.id,
    "read_write",
  );
  const reviewAccess = bestAccess(
    choice.option,
    choice.workspace.id,
    "read_only",
  );
  const reasoning = option.reasoning.includes("medium")
    ? "medium"
    : option.reasoning[0];
  if (!reasoning || !codingAccess || !reviewAccess)
    throw new Error(
      "The selected execution profile cannot create the starter crew.",
    );

  const builder = await api.createClass({
    key: "builder",
    name: "Builder",
    description: "Builds the requested change.",
    instructions:
      "Implement the requested change carefully and report the declared result.",
  });
  const reviewer = await api.createClass({
    key: "reviewer",
    name: "Reviewer",
    description: "Independently reviews completed work.",
    instructions:
      "Review the supplied work independently and report the declared result.",
  });
  const coding = await api.createLoadout({
    key: "coding",
    name: "Coding",
    description: "Writable engineering capabilities.",
    model,
    reasoning,
    tools: codingTools,
    workspace_access: codingAccess,
  });
  const review = await api.createLoadout({
    key: "review",
    name: "Review",
    description: "Read-only review capabilities.",
    model,
    reasoning,
    tools: reviewTools,
    workspace_access: reviewAccess,
  });
  const squad = await api.createSquad({
    key: "engineering-pair",
    name: "Engineering Pair",
    description: "A builder and independent reviewer.",
    members: [
      {
        member_key: "builder",
        name: "Builder",
        class_id: builder.id,
        loadout_id: coding.id,
      },
      {
        member_key: "reviewer",
        name: "Reviewer",
        class_id: reviewer.id,
        loadout_id: review.id,
      },
    ],
  });
  await api.createTactic({
    key: "implement-and-review",
    name: "Implement & Review",
    description:
      "A small sequential implementation and independent review tactic.",
    body: {
      type: "sequence",
      children: [
        {
          type: "step",
          key: "implement",
          name: "Implement",
          instruction: "Implement the Quest objective.",
          performer: { selector: "class", value: "builder" },
          context: { selector: "fresh", value: null },
          consumes: [],
          produces: [{ type: "change_set", source: null }],
        },
        {
          type: "step",
          key: "review",
          name: "Review",
          instruction: "Review the implementation against the Quest objective.",
          performer: { selector: "class", value: "reviewer" },
          context: { selector: "fresh", value: null },
          consumes: [{ type: "change_set", source: "implement" }],
          produces: [{ type: "verdict", source: null }],
        },
      ],
    },
  });
  void squad;
}

function bestAccess(
  option: ExecutionOption,
  workspaceId: string,
  desired: "read_only" | "read_write",
) {
  const values =
    option.workspaces.find(
      (workspace) => workspace.workspace_id === workspaceId,
    )?.workspace_access ?? [];
  return values.includes(desired) ? desired : undefined;
}
