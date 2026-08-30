import {
  ApiError,
  type ArtifactDetail,
  asArray,
  asBoolean,
  asNumber,
  asRecord,
  asString,
  type ClassDefinition,
  type DeliveryProjection,
  decodeApiError,
  type ExecutionOption,
  type JsonValue,
  type Loadout,
  nullableString,
  type Quest,
  type QuestPreview,
  type Reasoning,
  type RunProjection,
  type RunSummary,
  type Squad,
  type SquadMember,
  type StepState,
  strings,
  type Tactic,
  type TacticSource,
  type Workspace,
  type WorkspaceAccess,
  type WorkspaceSource,
} from "./contracts";

export interface ApiClientConfig {
  httpBaseUrl: string;
}
export interface ClassInput {
  key?: string;
  name?: string;
  description?: string;
  instructions?: string;
}
export interface LoadoutInput {
  key?: string;
  name?: string;
  description?: string;
  model?: { provider: string; model: string };
  reasoning?: Reasoning;
  tools?: string[];
  workspace_access?: WorkspaceAccess;
}
export interface SquadInput {
  key?: string;
  name?: string;
  description?: string;
  members?: SquadMember[];
}
export interface QuestInput {
  title?: string;
  objective?: string;
  workspace_id?: string;
  squad_id?: string;
  tactic_source?: TacticSource;
}
export interface WorkspaceInput {
  key?: string;
  name?: string;
  source_kind?: "git_remote" | "local_git";
  source_fingerprint?: string | null;
}
export interface TacticInput {
  key?: string;
  name?: string;
  description?: string;
  body?: JsonValue;
}

export class ApiClient {
  constructor(private readonly config: ApiClientConfig) {}

  createWorkspace = (input: WorkspaceInput) =>
    this.post("/workspaces", input, (value) =>
      decodeWorkspace(asRecord(value, "workspace").workspace),
    );
  updateWorkspace = (id: string, input: WorkspaceInput) =>
    this.patch(`/workspaces/${id}`, input, (value) =>
      decodeWorkspace(asRecord(value, "workspace").workspace),
    );
  archiveWorkspace = (id: string) =>
    this.post(`/workspaces/${id}/archive`, {}, (value) =>
      decodeWorkspace(asRecord(value, "workspace").workspace),
    );

  listClasses = () =>
    this.get("/classes", (value) => list(value, "classes", decodeClass));
  listLoadouts = () =>
    this.get("/loadouts", (value) => list(value, "loadouts", decodeLoadout));
  listSquads = () =>
    this.get("/squads", (value) => list(value, "squads", decodeSquad));
  listTactics = () =>
    this.get("/tactics", (value) => list(value, "tactics", decodeTactic));
  listQuests = () =>
    this.get("/quests", (value) => list(value, "quests", decodeQuest));
  listWorkspaces = () =>
    this.get("/workspaces", (value) =>
      list(value, "workspaces", decodeWorkspace),
    );
  listWorkspaceSources = () =>
    this.get("/workspace-sources", (value) =>
      list(value, "workspace_sources", decodeWorkspaceSource),
    );
  bindWorkspaceSource = (workspaceId: string, candidateId: string) =>
    this.post(
      `/workspaces/${workspaceId}/bindings`,
      { candidate_id: candidateId },
      (value) => asRecord(value, "binding").binding,
    );
  listExecutionOptions = () =>
    this.get("/execution-options", (value) =>
      list(value, "execution_options", decodeExecutionOption),
    );
  listRuns = () =>
    this.get("/runs", (value) => list(value, "runs", decodeRunSummary));
  getRun = (id: string, signal?: AbortSignal) =>
    this.get(
      `/runs/${encodeURIComponent(id)}`,
      (value) => decodeRun(asRecord(value, "run").run),
      signal,
    );
  retryDelivery = (runId: string) =>
    this.post(
      `/runs/${encodeURIComponent(runId)}/delivery/retry`,
      {},
      (value) => decodeDelivery(asRecord(value, "delivery").delivery),
    );
  cleanupWorktree = (runId: string, acknowledgeUnmerged = false) =>
    this.post(
      `/runs/${encodeURIComponent(runId)}/worktree/cleanup`,
      { acknowledge_unmerged: acknowledgeUnmerged },
      (value) => asRecord(value, "execution environment").execution_environment,
    );
  getRunChanges = (runId: string) =>
    this.get(
      `/runs/${encodeURIComponent(runId)}/changes`,
      (value) => asRecord(value, "changes").changes,
    );
  getArtifact = (runId: string, artifactId: string) =>
    this.get(
      `/runs/${encodeURIComponent(runId)}/artifacts/${encodeURIComponent(artifactId)}`,
      (value) => decodeArtifact(asRecord(value, "artifact").artifact),
    );

  createClass = (input: Required<ClassInput>) =>
    this.post("/classes", input, (value) =>
      decodeClass(asRecord(value, "class").class),
    );
  updateClass = (id: string, input: ClassInput) =>
    this.patch(`/classes/${id}`, input, (value) =>
      decodeClass(asRecord(value, "class").class),
    );
  archiveClass = (id: string) =>
    this.post(`/classes/${id}/archive`, {}, (value) =>
      decodeClass(asRecord(value, "class").class),
    );
  createLoadout = (input: Required<LoadoutInput>) =>
    this.post("/loadouts", input, (value) =>
      decodeLoadout(asRecord(value, "loadout").loadout),
    );
  updateLoadout = (id: string, input: LoadoutInput) =>
    this.patch(`/loadouts/${id}`, input, (value) =>
      decodeLoadout(asRecord(value, "loadout").loadout),
    );
  archiveLoadout = (id: string) =>
    this.post(`/loadouts/${id}/archive`, {}, (value) =>
      decodeLoadout(asRecord(value, "loadout").loadout),
    );
  createSquad = (input: Required<SquadInput>) =>
    this.post("/squads", input, (value) =>
      decodeSquad(asRecord(value, "squad").squad),
    );
  updateSquad = (id: string, input: SquadInput) =>
    this.patch(`/squads/${id}`, input, (value) =>
      decodeSquad(asRecord(value, "squad").squad),
    );
  archiveSquad = (id: string) =>
    this.post(`/squads/${id}/archive`, {}, (value) =>
      decodeSquad(asRecord(value, "squad").squad),
    );
  createTactic = (input: Required<TacticInput>) =>
    this.post("/tactics", input, (value) =>
      decodeTactic(asRecord(value, "tactic").tactic),
    );
  createQuest = (input: Required<QuestInput>) =>
    this.post("/quests", input, (value) =>
      decodeQuest(asRecord(value, "quest").quest),
    );
  updateQuest = (id: string, input: QuestInput) =>
    this.patch(`/quests/${id}`, input, (value) =>
      decodeQuest(asRecord(value, "quest").quest),
    );
  archiveQuest = (id: string) =>
    this.post(`/quests/${id}/archive`, {}, (value) =>
      decodeQuest(asRecord(value, "quest").quest),
    );
  previewQuest = (id: string) =>
    this.post(
      `/quests/${id}/preview`,
      {},
      (value) => asRecord(value, "preview").preview as QuestPreview,
    );
  launchQuest = (id: string) =>
    this.post(`/quests/${id}/launch`, {}, (value) => {
      const response = asRecord(value, "launch");
      return {
        runId: asString(
          asRecord(response.launch, "launch").run_id,
          "launch run id",
        ),
        run: decodeRunSummary(response.run),
      };
    });

  private async get<T>(
    path: string,
    decode: (value: unknown) => T,
    signal?: AbortSignal,
  ): Promise<T> {
    return this.request(
      path,
      signal ? { method: "GET", signal } : { method: "GET" },
      decode,
    );
  }
  private async post<T>(
    path: string,
    body: unknown,
    decode: (value: unknown) => T,
  ): Promise<T> {
    return this.request(
      path,
      {
        method: "POST",
        body: JSON.stringify(body),
        headers: { "content-type": "application/json" },
      },
      decode,
    );
  }
  private async patch<T>(
    path: string,
    body: unknown,
    decode: (value: unknown) => T,
  ): Promise<T> {
    return this.request(
      path,
      {
        method: "PATCH",
        body: JSON.stringify(body),
        headers: { "content-type": "application/json" },
      },
      decode,
    );
  }
  private async request<T>(
    path: string,
    init: RequestInit,
    decode: (value: unknown) => T,
  ): Promise<T> {
    let response: Response;
    try {
      response = await fetch(`${this.config.httpBaseUrl}${path}`, init);
    } catch {
      throw new ApiError(
        "network_unavailable",
        "Quest Engineering is unavailable.",
      );
    }
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw new ApiError(
        "invalid_response",
        "Quest Engineering returned an invalid response.",
        [],
        {},
        response.status,
      );
    }
    if (!response.ok) throw decodeApiError(body, response.status);
    try {
      return decode(body);
    } catch (cause) {
      const reason = cause instanceof Error ? cause.message : String(cause);
      console.error(`Invalid Quest Engineering response for ${path}:`, cause);
      throw new ApiError(
        "invalid_response",
        `Quest Engineering returned an invalid response for ${path}.`,
        [],
        { path, reason },
        response.status,
      );
    }
  }
}

function list<T>(
  value: unknown,
  key: string,
  decode: (item: unknown) => T,
): T[] {
  return asArray(asRecord(value, key)[key], key).map(decode);
}
function decodeClass(value: unknown): ClassDefinition {
  const x = asRecord(value, "class");
  return {
    id: asString(x.id, "class"),
    key: asString(x.key, "class"),
    name: asString(x.name, "class"),
    description: asString(x.description, "class"),
    instructions: asString(x.instructions, "class"),
    archived_at: nullableString(x.archived_at, "class"),
  };
}
function decodeLoadout(value: unknown): Loadout {
  const x = asRecord(value, "loadout");
  const model = asRecord(x.model, "loadout model");
  return {
    id: asString(x.id, "loadout"),
    key: asString(x.key, "loadout"),
    name: asString(x.name, "loadout"),
    description: asString(x.description, "loadout"),
    model: {
      provider: asString(model.provider, "provider"),
      model: asString(model.model, "model"),
    },
    reasoning: reasoning(x.reasoning),
    tools: strings(x.tools, "tools"),
    workspace_access: access(x.workspace_access),
    archived_at: nullableString(x.archived_at, "loadout"),
  };
}
function decodeMember(value: unknown): SquadMember {
  const x = asRecord(value, "member");
  return {
    member_key: asString(x.member_key, "member"),
    name: asString(x.name, "member"),
    class_id: asString(x.class_id, "member"),
    loadout_id: asString(x.loadout_id, "member"),
  };
}
function decodeSquad(value: unknown): Squad {
  const x = asRecord(value, "squad");
  return {
    id: asString(x.id, "squad"),
    key: asString(x.key, "squad"),
    name: asString(x.name, "squad"),
    description: asString(x.description, "squad"),
    members: asArray(x.members, "members").map(decodeMember),
    archived_at: nullableString(x.archived_at, "squad"),
  };
}
function decodeTactic(value: unknown): Tactic {
  const x = asRecord(value, "tactic");
  return {
    id: asString(x.id, "tactic"),
    key: asString(x.key, "tactic"),
    name: asString(x.name, "tactic"),
    description: asString(x.description, "tactic"),
    body: x.body as JsonValue,
    archived_at: nullableString(x.archived_at, "tactic"),
  };
}
function decodeSource(value: unknown): TacticSource {
  const x = asRecord(value, "tactic source");
  const type = asString(x.type, "tactic source");
  if (type === "definition")
    return {
      type,
      tactic_definition_id: asString(x.tactic_definition_id, "tactic source"),
    };
  if (type === "inline") return { type, body: x.body as JsonValue };
  throw new Error("Invalid tactic source.");
}
function decodeQuest(value: unknown): Quest {
  const x = asRecord(value, "quest");
  return {
    id: asString(x.id, "quest"),
    title: asString(x.title, "quest"),
    objective: asString(x.objective, "quest"),
    workspace_id: asString(x.workspace_id, "quest"),
    squad_id: asString(x.squad_id, "quest"),
    tactic_source: decodeSource(x.tactic_source),
    completion: (() => {
      const completion = asRecord(
        x.completion ?? { completed_at: null, completed_by_run_id: null },
        "quest completion",
      );
      return {
        completed_at: nullableString(
          completion.completed_at,
          "quest completion",
        ),
        completed_by_run_id: nullableString(
          completion.completed_by_run_id,
          "quest completion",
        ),
      };
    })(),
    lifecycle: (() => {
      const lifecycle = asRecord(
        x.lifecycle ?? {
          state: "ready",
          label: "Ready",
          current_run_id: null,
          primary_action: "launch",
        },
        "quest lifecycle",
      );
      return {
        state: asString(
          lifecycle.state,
          "quest lifecycle",
        ) as Quest["lifecycle"]["state"],
        label: asString(lifecycle.label, "quest lifecycle"),
        current_run_id: nullableString(
          lifecycle.current_run_id,
          "quest lifecycle",
        ),
        primary_action:
          lifecycle.primary_action === null
            ? null
            : (asString(
                lifecycle.primary_action,
                "quest lifecycle",
              ) as Quest["lifecycle"]["primary_action"]),
        ...(lifecycle.delivery
          ? { delivery: decodeDelivery(lifecycle.delivery) }
          : {}),
      };
    })(),
    archived_at: nullableString(x.archived_at, "quest"),
  };
}
function decodeWorkspace(value: unknown): Workspace {
  const x = asRecord(value, "workspace");
  const sourceKind = asString(x.source_kind, "workspace");
  if (sourceKind !== "git_remote" && sourceKind !== "local_git")
    throw new Error("Invalid Workspace source kind.");
  return {
    id: asString(x.id, "workspace"),
    key: asString(x.key, "workspace"),
    name: asString(x.name, "workspace"),
    source_kind: sourceKind,
    source_fingerprint: nullableString(x.source_fingerprint, "workspace"),
    binding: (() => {
      const binding = asRecord(
        x.binding ?? {
          state: "unbound",
          message: "Add this Project to a Worker.",
        },
        "Project binding",
      );
      return {
        state: asString(
          binding.state,
          "Project binding",
        ) as Workspace["binding"]["state"],
        message: asString(binding.message, "Project binding"),
      };
    })(),
    archived_at: nullableString(x.archived_at, "workspace"),
  };
}
function decodeWorkspaceSource(value: unknown): WorkspaceSource {
  const x = asRecord(value, "Workspace source");
  const sourceKind = asString(x.source_kind, "Workspace source");
  if (sourceKind !== "git_remote" && sourceKind !== "local_git")
    throw new Error("Invalid Workspace source kind.");
  return {
    candidate_id: asString(x.candidate_id, "Workspace source"),
    name: asString(x.name, "Workspace source"),
    source_kind: sourceKind,
    source_fingerprint: nullableString(
      x.source_fingerprint,
      "Workspace source",
    ),
    max_access: access(x.max_access),
    shell_available: asBoolean(x.shell_available, "Workspace source"),
  };
}
function decodeExecutionOption(value: unknown): ExecutionOption {
  const x = asRecord(value, "execution option");
  const model = asRecord(x.model, "execution option model");
  return {
    model: {
      provider: asString(model.provider, "provider"),
      model: asString(model.model, "model"),
    },
    reasoning: strings(x.reasoning, "reasoning").map(reasoning),
    tools: strings(x.tools, "tools"),
    workspaces: asArray(x.workspaces, "option workspaces").map((item) => {
      const w = asRecord(item, "option workspace");
      return {
        workspace_id: asString(w.workspace_id, "option workspace"),
        workspace_access: strings(w.workspace_access, "access").map(access),
      };
    }),
    available: asBoolean(x.available, "availability"),
  };
}
function decodeDelivery(value: unknown): DeliveryProjection {
  const x = asRecord(value, "delivery");
  const changes =
    x.changes == null ? null : asRecord(x.changes, "delivery changes");
  const review =
    x.review == null ? null : asRecord(x.review, "delivery review");
  const revisions = asRecord(
    x.revisions ?? { base: null, head: null },
    "delivery revisions",
  );
  const issue = x.issue == null ? null : asRecord(x.issue, "delivery issue");
  return {
    state: asString(x.state, "delivery") as DeliveryProjection["state"],
    changes: changes
      ? {
          files_changed: asNumber(changes.files_changed, "delivery changes"),
          additions: asNumber(changes.additions, "delivery changes"),
          deletions: asNumber(changes.deletions, "delivery changes"),
        }
      : null,
    review: review
      ? {
          provider: asString(review.provider, "delivery review") as "github",
          state: asString(review.state, "delivery review"),
          number: asNumber(review.number, "delivery review"),
          url: asString(review.url, "delivery review"),
        }
      : null,
    revisions: {
      base: nullableString(revisions.base, "delivery revision"),
      head: nullableString(revisions.head, "delivery revision"),
    },
    issue: issue
      ? {
          code: asString(issue.code, "delivery issue"),
          message: asString(issue.message, "delivery issue"),
        }
      : null,
    can_retry: asBoolean(x.can_retry, "delivery"),
  };
}
function decodeRunSummary(value: unknown): RunSummary {
  const x = asRecord(value, "run summary");
  return {
    id: asString(x.id, "run"),
    status: asString(x.status, "run"),
    quest_title: asString(x.quest_title, "run"),
    launched_at: asString(x.launched_at, "run"),
    step_counts: x.step_counts as Record<StepState, number>,
    delivery: x.delivery == null ? null : decodeDelivery(x.delivery),
  };
}
function decodeRun(value: unknown): RunProjection {
  const x = asRecord(value, "run");
  const quest = asRecord(x.quest, "run quest");
  const squad = asRecord(x.squad, "run squad");
  const environment = asRecord(
    x.execution_environment,
    "run execution environment",
  );
  const environmentWorkspace = asRecord(
    environment.workspace,
    "run environment Workspace",
  );
  const counts = asRecord(x.step_counts, "step counts");
  return {
    id: asString(x.id, "run"),
    status: runStatus(x.status),
    launched_at: asString(x.launched_at, "run"),
    revision: asNumber(x.revision, "run"),
    quest: {
      id: asString(quest.id, "quest"),
      title: asString(quest.title, "quest"),
      objective: asString(quest.objective, "quest"),
    },
    delivery: x.delivery == null ? null : decodeDelivery(x.delivery),
    execution_environment: {
      workspace: {
        id: asString(environmentWorkspace.id, "environment Workspace"),
        key: asString(environmentWorkspace.key, "environment Workspace"),
        name: asString(environmentWorkspace.name, "environment Workspace"),
      },
      state: asString(
        environment.state,
        "environment state",
      ) as RunProjection["execution_environment"]["state"],
      message: asString(environment.message, "environment message"),
      base_revision: nullableString(environment.base_revision, "base revision"),
      branch: nullableString(environment.branch, "branch"),
      source_dirty_changes_excluded:
        environment.source_dirty_changes_excluded === null
          ? null
          : asBoolean(
              environment.source_dirty_changes_excluded,
              "dirty source exclusion",
            ),
      issue:
        environment.issue === null
          ? null
          : (() => {
              const issue = asRecord(environment.issue, "environment issue");
              return {
                code: asString(issue.code, "issue"),
                message: asString(issue.message, "issue"),
              };
            })(),
    },
    squad: {
      id: asString(squad.id, "squad"),
      key: asString(squad.key, "squad"),
      name: asString(squad.name, "squad"),
      members: asArray(squad.members, "run members").map(decodeSnapshotMember),
    },
    steps: asArray(x.steps, "run steps").map(decodeRunStep),
    artifacts: asArray(x.artifacts, "artifacts").map(decodeArtifactSummary),
    step_counts: {
      pending: asNumber(counts.pending, "count"),
      waiting: asNumber(counts.waiting, "count"),
      scheduled: asNumber(counts.scheduled, "count"),
      running: asNumber(counts.running, "count"),
      completed: asNumber(counts.completed, "count"),
      failed: asNumber(counts.failed, "count"),
      uncertain: asNumber(counts.uncertain, "count"),
    },
    issues: asArray(x.issues, "issues").map((item) => {
      const issue = asRecord(item, "issue");
      return {
        code: asString(issue.code, "issue"),
        message: asString(issue.message, "issue"),
      };
    }),
  };
}
function decodeSnapshotMember(value: unknown) {
  const x = asRecord(value, "snapshot member");
  const classValue = asRecord(x.class, "member class");
  const loadout = asRecord(x.loadout, "member loadout");
  return {
    member_key: asString(x.member_key, "member"),
    name: asString(x.name, "member"),
    class: {
      id: asString(classValue.id, "class"),
      key: asString(classValue.key, "class"),
      name: asString(classValue.name, "class"),
    },
    loadout: {
      id: asString(loadout.id, "loadout"),
      key: asString(loadout.key, "loadout"),
      name: asString(loadout.name, "loadout"),
    },
  };
}
function decodeRunStep(value: unknown) {
  const x = asRecord(value, "run step");
  const performer = asRecord(x.performer, "performer");
  const context = asRecord(x.context, "context");
  const nullable = (item: unknown, name: string) =>
    item === null ? null : asString(item, name);
  return {
    occurrence_id: asString(x.occurrence_id, "step"),
    semantic_step_key: asString(x.semantic_step_key, "step"),
    name: nullable(x.name, "step"),
    instruction: nullable(x.instruction, "step"),
    state: stepState(x.state),
    phase: nullable(x.phase, "step"),
    remediation_cycle:
      x.remediation_cycle === null
        ? null
        : asNumber(x.remediation_cycle, "step"),
    control_path: strings(x.control_path, "step"),
    member: x.member === null ? null : decodeSnapshotMember(x.member),
    performer: {
      selector: nullable(performer.selector, "performer"),
      class_key: nullable(performer.class_key, "performer"),
      source_occurrence_id: nullable(
        performer.source_occurrence_id,
        "performer",
      ),
      source_semantic_step_key: nullable(
        performer.source_semantic_step_key,
        "performer",
      ),
    },
    context: {
      mode: nullable(context.mode, "context"),
      source_occurrence_id: nullable(context.source_occurrence_id, "context"),
      source_semantic_step_key: nullable(
        context.source_semantic_step_key,
        "context",
      ),
    },
    inputs: asArray(x.inputs, "inputs").map(decodeArtifactRef),
    outputs: asArray(x.outputs, "outputs").map(decodeArtifactRef),
    issue:
      x.issue === null
        ? null
        : (() => {
            const issue = asRecord(x.issue, "issue");
            return {
              code: asString(issue.code, "issue"),
              message: asString(issue.message, "issue"),
            };
          })(),
  };
}
function decodeArtifactRef(value: unknown) {
  const x = asRecord(value, "artifact reference");
  return {
    type: asString(x.type, "artifact reference"),
    artifact_id: asString(x.artifact_id, "artifact reference"),
  };
}
function decodeArtifactSummary(value: unknown) {
  const x = asRecord(value, "artifact");
  return {
    id: asString(x.id, "artifact"),
    type: asString(x.type, "artifact"),
    producer_occurrence_id: asString(x.producer_occurrence_id, "artifact"),
    preview: x.preview as JsonValue,
  };
}
function decodeArtifact(value: unknown): ArtifactDetail {
  const valueRecord = asRecord(value, "artifact");
  return {
    ...decodeArtifactSummary(valueRecord),
    value: valueRecord.value as JsonValue,
  };
}
function stepState(value: unknown): StepState {
  const state = asString(value, "step state");
  if (
    [
      "pending",
      "waiting",
      "scheduled",
      "running",
      "completed",
      "failed",
      "uncertain",
    ].includes(state)
  )
    return state as StepState;
  throw new Error("Invalid step state.");
}
function runStatus(value: unknown): RunProjection["status"] {
  return stepState(value);
}
function reasoning(value: unknown): Reasoning {
  const x = asString(value, "reasoning");
  if (x === "low" || x === "medium" || x === "high") return x;
  throw new Error("Invalid reasoning.");
}
function access(value: unknown): WorkspaceAccess {
  const x = asString(value, "workspace access");
  if (x === "none" || x === "read_only" || x === "read_write") return x;
  throw new Error("Invalid workspace access.");
}
