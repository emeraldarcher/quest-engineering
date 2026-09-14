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
  type HarnessSessionState,
  type JsonValue,
  type Loadout,
  type LocalSessionAttachmentDescriptor,
  nullableString,
  type Quest,
  type QuestPreview,
  type Reasoning,
  type ReasoningCapability,
  type RunProjection,
  type RunSummary,
  type Squad,
  type SquadMember,
  type StarterCrewResult,
  type StarterCrewStatus,
  type StepState,
  strings,
  type Tactic,
  type TacticInterfaceContract,
  type TacticPreview,
  type TacticSource,
  type ToolEnforcement,
  type ToolPolicy,
  type Workspace,
  type WorkspaceAccess,
  type WorkspaceSource,
} from "./contracts";

export interface ApiClientConfig {
  httpBaseUrl: string;
  localTauriClient?: boolean;
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
  harness?: string;
  model?: { provider: string; model: string };
  reasoning?: Reasoning | null;
  tool_policy?: ToolPolicy;
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
  interface?: TacticInterfaceContract;
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

  listClasses = (includeArchived = false) =>
    this.get(
      `/classes${includeArchived ? "?include_archived=true" : ""}`,
      (value) => list(value, "classes", decodeClass),
    );
  listLoadouts = (includeArchived = false) =>
    this.get(
      `/loadouts${includeArchived ? "?include_archived=true" : ""}`,
      (value) => list(value, "loadouts", decodeLoadout),
    );
  listSquads = (includeArchived = false) =>
    this.get(
      `/squads${includeArchived ? "?include_archived=true" : ""}`,
      (value) => list(value, "squads", decodeSquad),
    );
  listTactics = (includeArchived = false) =>
    this.get(
      `/tactics${includeArchived ? "?include_archived=true" : ""}`,
      (value) => list(value, "tactics", decodeTactic),
    );
  listQuests = () =>
    this.get("/quests", (value) => list(value, "quests", decodeQuest));
  listWorkspaces = (includeArchived = false) =>
    this.get(
      `/workspaces${includeArchived ? "?include_archived=true" : ""}`,
      (value) => list(value, "workspaces", decodeWorkspace),
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
  getStarterCrewStatus = () =>
    this.get("/starter-crew", (value) =>
      decodeStarterCrewStatus(asRecord(value, "starter crew").starter_crew),
    );
  createStarterCrew = (workspaceId: string) =>
    this.post("/starter-crew", { workspace_id: workspaceId }, (value) =>
      decodeStarterCrewResult(asRecord(value, "starter crew").starter_crew),
    );
  listRuns = () =>
    this.get("/runs", (value) => list(value, "runs", decodeRunSummary));
  getRun = (id: string, signal?: AbortSignal) =>
    this.get(
      `/runs/${encodeURIComponent(id)}`,
      (value) => decodeRun(asRecord(value, "run").run),
      signal,
    );
  retryExecution = (runId: string, occurrenceId: string) =>
    this.post(
      `/runs/${encodeURIComponent(runId)}/execution/retry`,
      { occurrence_id: occurrenceId },
      (value) => decodeRun(asRecord(value, "run").run),
    );
  recoverExecutionFresh = (
    runId: string,
    occurrenceId: string,
    requestId: string,
  ) =>
    this.post(
      `/runs/${encodeURIComponent(runId)}/execution/recover-fresh`,
      { occurrence_id: occurrenceId, request_id: requestId },
      (value) => decodeRun(asRecord(value, "run").run),
    );
  markExecutionFailed = (runId: string, occurrenceId: string) =>
    this.post(
      `/runs/${encodeURIComponent(runId)}/execution/mark-failed`,
      { occurrence_id: occurrenceId },
      (value) => decodeRun(asRecord(value, "run").run),
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
  getSessionAttachment = (
    runId: string,
    attemptId: string,
    sessionId: string,
  ) =>
    this.post(
      `/runs/${encodeURIComponent(runId)}/attempts/${encodeURIComponent(attemptId)}/sessions/${encodeURIComponent(sessionId)}/attachment`,
      {},
      (value) =>
        decodeSessionAttachment(
          asRecord(value, "session attachment").attachment,
        ),
      undefined,
      true,
    );
  recordSessionOpened = (
    descriptorToken: string,
    mode: "observe" | "takeover" | "recovery",
  ) =>
    this.post(
      "/session-attachments/opened",
      { descriptor_token: descriptorToken, mode },
      (value) =>
        asString(
          asRecord(value, "opened session").session_id,
          "opened session",
        ),
      undefined,
      true,
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
  updateTactic = (id: string, input: TacticInput) =>
    this.patch(`/tactics/${id}`, input, (value) =>
      decodeTactic(asRecord(value, "tactic").tactic),
    );
  archiveTactic = (id: string) =>
    this.post(`/tactics/${id}/archive`, {}, (value) =>
      decodeTactic(asRecord(value, "tactic").tactic),
    );
  previewTacticDraft = (body: JsonValue, signal?: AbortSignal) =>
    this.post(
      "/tactics/preview",
      { tactic_source: { type: "inline", body } },
      (value) => decodeTacticPreview(asRecord(value, "preview").preview),
      signal,
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
  previewTacticDefinition = (
    id: string,
    body?: JsonValue,
    signal?: AbortSignal,
    tacticInterface?: TacticInterfaceContract,
  ) =>
    this.post(
      `/tactics/${id}/preview`,
      body === undefined
        ? {}
        : { body, ...(tacticInterface ? { interface: tacticInterface } : {}) },
      (value) => decodeTacticPreview(asRecord(value, "preview").preview),
      signal,
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
    signal?: AbortSignal,
    localOnly = false,
  ): Promise<T> {
    if (localOnly && !this.config.localTauriClient)
      throw new ApiError(
        "local_session_attachment_unavailable",
        "Live sessions can only be opened from the local desktop app.",
      );
    return this.request(
      path,
      {
        method: "POST",
        body: JSON.stringify(body),
        headers: {
          "content-type": "application/json",
          ...(localOnly ? { "x-quest-engineering-local-client": "tauri" } : {}),
        },
        ...(signal ? { signal } : {}),
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
    harness: asString(x.harness, "loadout harness"),
    model: {
      provider: asString(model.provider, "provider"),
      model: asString(model.model, "model"),
    },
    reasoning: nullableReasoning(x.reasoning),
    tool_policy: toolPolicy(x.tool_policy),
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
    interface: x.interface as Tactic["interface"],
    archived_at: nullableString(x.archived_at, "tactic"),
  };
}
function decodeTacticPreview(value: unknown): TacticPreview {
  const x = asRecord(value, "tactic preview");
  return {
    resolved_tactic: x.resolved_tactic as JsonValue,
    artifact_bindings: asArray(
      x.artifact_bindings ?? [],
      "artifact bindings",
    ) as NonNullable<TacticPreview["artifact_bindings"]>,
    provenance: (x.provenance ?? null) as JsonValue,
    step_origins: asArray(x.step_origins ?? [], "step origins") as JsonValue[],
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
        ...(lifecycle.issue
          ? {
              issue: (() => {
                const issue = asRecord(
                  lifecycle.issue,
                  "quest lifecycle issue",
                );
                return {
                  code: asString(issue.code, "quest lifecycle issue"),
                  message: asString(issue.message, "quest lifecycle issue"),
                };
              })(),
            }
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
        ...(binding.issue
          ? {
              issue: {
                code: asString(
                  asRecord(binding.issue, "Project issue").code,
                  "Project issue",
                ),
              },
            }
          : {}),
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
    publication_repository_identity: nullableString(
      x.publication_repository_identity,
      "Workspace source",
    ),
    max_access: access(x.max_access),
    shell_available: asBoolean(x.shell_available, "Workspace source"),
  };
}
function decodeStarterCrewStatus(value: unknown): StarterCrewStatus {
  const x = asRecord(value, "starter crew status");
  const conflict =
    x.conflict === null ? null : asRecord(x.conflict, "starter conflict");
  return {
    state: asString(
      x.state,
      "starter crew status",
    ) as StarterCrewStatus["state"],
    conflict: conflict
      ? {
          entity_type: asString(
            conflict.entity_type,
            "starter conflict",
          ) as NonNullable<StarterCrewStatus["conflict"]>["entity_type"],
          key: asString(conflict.key, "starter conflict"),
        }
      : null,
  };
}
function decodeStarterCrewResult(value: unknown): StarterCrewResult {
  const x = asRecord(value, "starter crew result");
  return {
    status: asString(x.status, "starter crew result") as "ready",
    classes: asArray(x.classes, "starter classes").map(decodeClass),
    loadouts: asArray(x.loadouts, "starter loadouts").map(decodeLoadout),
    squad: decodeSquad(x.squad),
    tactic: decodeTactic(x.tactic),
  };
}
function decodeExecutionOption(value: unknown): ExecutionOption {
  const x = asRecord(value, "execution option");
  const model = asRecord(x.model, "execution option model");
  return {
    harness: asString(x.harness, "execution option harness"),
    model: {
      provider: asString(model.provider, "provider"),
      model: asString(model.model, "model"),
      display_name: asString(model.display_name, "model display name"),
    },
    reasoning_capability: reasoningCapability(x.reasoning_capability),
    tool_policy: executionToolPolicy(x.tool_policy),
    tool_enforcement: toolEnforcement(x.tool_enforcement),
    current_tool_profile: {
      tools: strings(
        asRecord(x.current_tool_profile, "current tool profile").tools,
        "current tool profile tools",
      ),
    },
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
function decodeSessionAttachment(
  value: unknown,
): LocalSessionAttachmentDescriptor {
  const x = asRecord(value, "session attachment");
  const terminal = asRecord(x.terminal, "session terminal");
  if (x.mode !== "local_native_terminal" || terminal.backend_kind !== "herdr")
    throw new Error("Unsupported local session attachment transport.");
  return {
    descriptor_token: asString(x.descriptor_token, "session attachment"),
    expires_at: asString(x.expires_at, "session attachment"),
    mode: "local_native_terminal",
    worker_id: asString(x.worker_id, "session attachment"),
    worker_generation: asNumber(x.worker_generation, "session attachment"),
    session_id: asString(x.session_id, "session attachment"),
    state: asString(
      x.state,
      "session attachment",
    ) as LocalSessionAttachmentDescriptor["state"],
    takeover_allowed: asBoolean(x.takeover_allowed, "session attachment"),
    recovery_allowed: x.recovery_allowed === true,
    terminal: {
      attachment_mode: "local_native_terminal",
      backend_kind: "herdr",
      terminal_session_id: asString(
        terminal.terminal_session_id,
        "session terminal",
      ),
      terminal_target_id: asString(
        terminal.terminal_target_id,
        "session terminal",
      ),
      terminal_id: nullableString(terminal.terminal_id, "session terminal"),
      supports_observation: asBoolean(
        terminal.supports_observation,
        "session terminal",
      ),
      supports_takeover: asBoolean(
        terminal.supports_takeover,
        "session terminal",
      ),
    },
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
    live_session_attention: asArray(
      x.live_session_attention ?? [],
      "live session attention",
    ).map((value) => {
      const attention = asRecord(value, "live session attention");
      return {
        session_id: asString(attention.session_id, "live session attention"),
        category: asString(attention.category, "live session attention"),
        attention_id: asString(
          attention.attention_id,
          "live session attention",
        ),
      };
    }),
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
  const launch = asRecord(x.launch, "run launch");
  const reviewGate = asRecord(x.review_gate, "run review gate");
  return {
    id: asString(x.id, "run"),
    status: runStatus(x.status),
    launched_at: asString(x.launched_at, "run"),
    revision: asNumber(x.revision, "run"),
    launch: { id: asString(launch.id, "run launch") },
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
    planning:
      x.planning === undefined
        ? { accepted_plan: null, history: [] }
        : decodePlanning(x.planning),
    operational_recovery:
      x.operational_recovery === undefined
        ? []
        : asArray(x.operational_recovery, "operational recovery").map(
            decodeOperationalRecoveryEpoch,
          ),
    semantic_remediation:
      x.semantic_remediation === undefined
        ? []
        : asArray(x.semantic_remediation, "semantic remediation").map(
            decodeSemanticRemediation,
          ),
    review_gate: {
      required: asBoolean(reviewGate.required, "run review gate"),
      status: asString(
        reviewGate.status,
        "run review gate",
      ) as RunProjection["review_gate"]["status"],
      occurrence_id: nullableString(
        reviewGate.occurrence_id,
        "run review gate occurrence",
      ),
      attempt_id: nullableString(
        reviewGate.attempt_id,
        "run review gate attempt",
      ),
      artifact_id: nullableString(
        reviewGate.artifact_id,
        "run review gate artifact",
      ),
    },
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
function decodeOperationalRecoveryEpoch(value: unknown) {
  const epoch = asRecord(value, "operational recovery epoch");
  return {
    id: asString(epoch.id, "operational recovery epoch"),
    occurrence_id: asString(epoch.occurrence_id, "operational recovery epoch"),
    epoch_number: asNumber(epoch.epoch_number, "operational recovery epoch"),
    authorization_kind: asString(
      epoch.authorization_kind,
      "operational recovery epoch",
    ) as "initial" | "human",
    attempt_allowance:
      epoch.attempt_allowance === null
        ? null
        : asNumber(epoch.attempt_allowance, "operational recovery epoch"),
    policy_source: asString(
      epoch.policy_source,
      "operational recovery epoch",
    ) as "configured" | "legacy_unknown",
    continuation_mode: asString(
      epoch.continuation_mode,
      "operational recovery epoch",
    ) as "fresh" | "retained",
    authorized_at: asString(epoch.authorized_at, "operational recovery epoch"),
    attempts_scheduled: asNumber(
      epoch.attempts_scheduled,
      "operational recovery epoch",
    ),
  };
}

function decodePlanning(
  value: unknown,
): NonNullable<RunProjection["planning"]> {
  const planning = asRecord(value, "planning");
  return {
    accepted_plan:
      planning.accepted_plan === null
        ? null
        : decodeArtifactSummary(planning.accepted_plan),
    history: asArray(planning.history, "plan history").map((value) => {
      const item = asRecord(value, "plan history");
      const status =
        item.status === null ? null : asString(item.status, "plan status");
      if (status !== null && status !== "accepted" && status !== "rejected")
        throw new Error("Invalid plan status.");
      return {
        artifact_id: asString(item.artifact_id, "plan history"),
        version: asNumber(item.version, "plan history"),
        status,
        verdict_artifact_id: nullableString(
          item.verdict_artifact_id,
          "plan verdict artifact",
        ),
        findings: (item.findings ?? null) as JsonValue,
        supersedes_artifact_id: nullableString(
          item.supersedes_artifact_id,
          "superseded plan artifact",
        ),
      };
    }),
  };
}

function decodeSemanticRemediation(value: unknown) {
  const remediation = asRecord(value, "semantic remediation");
  return {
    region_occurrence_id: asString(
      remediation.region_occurrence_id,
      "semantic remediation",
    ),
    semantic_region_id: asString(
      remediation.semantic_region_id,
      "semantic remediation",
    ),
    remediations_completed: asNumber(
      remediation.remediations_completed,
      "semantic remediation",
    ),
    maximum_remediations: asNumber(
      remediation.maximum_remediations,
      "semantic remediation",
    ),
    status: asString(remediation.status, "semantic remediation"),
    review_shaped: asBoolean(remediation.review_shaped, "semantic remediation"),
    acceptance_gate_key:
      remediation.acceptance_gate_key == null
        ? null
        : asString(remediation.acceptance_gate_key, "acceptance gate"),
    acceptance_subject_kind:
      remediation.acceptance_subject_kind == null
        ? null
        : asString(remediation.acceptance_subject_kind, "acceptance subject"),
    remediation_kind:
      remediation.remediation_kind == null
        ? "generic"
        : (asString(remediation.remediation_kind, "remediation kind") as
            | "plan_revision"
            | "implementation_repair"
            | "generic"),
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
    attempt: x.attempt === null ? null : decodeRunAttempt(x.attempt),
    attempts: asArray(x.attempts, "step attempts").map(decodeRunAttempt),
    session: x.session == null ? null : decodeHarnessSession(x.session),
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
    recovery:
      x.recovery == null
        ? null
        : (() => {
            const recovery = asRecord(x.recovery, "execution recovery");
            return {
              can_retry: asBoolean(recovery.can_retry, "execution recovery"),
              can_mark_failed: asBoolean(
                recovery.can_mark_failed,
                "execution recovery",
              ),
              can_human_retry: recovery.can_human_retry === true,
              can_retry_fresh: recovery.can_retry_fresh === true,
              retained_session_available:
                recovery.retained_session_available === true,
              ...(typeof recovery.classification === "string"
                ? { classification: recovery.classification }
                : {}),
              epoch_exhausted: recovery.epoch_exhausted === true,
              message: asString(recovery.message, "execution recovery"),
            };
          })(),
  };
}
function decodeRunAttempt(value: unknown) {
  const attempt = asRecord(value, "step attempt");
  const resolution =
    attempt.resolution === null
      ? null
      : (asString(attempt.resolution, "step attempt") as
          | "retried"
          | "marked_failed");
  return {
    id: asString(attempt.id, "step attempt"),
    number: asNumber(attempt.number, "step attempt"),
    state: asString(attempt.state, "step attempt"),
    started_at: nullableString(attempt.started_at, "step attempt"),
    finished_at: nullableString(attempt.finished_at, "step attempt"),
    outputs: asArray(attempt.outputs, "step attempt outputs").map(
      decodeArtifactRef,
    ),
    output_produced: asBoolean(attempt.output_produced, "step attempt"),
    resolution,
    retry_of_attempt_id: nullableString(
      attempt.retry_of_attempt_id,
      "step attempt",
    ),
    execution:
      attempt.execution == null
        ? null
        : decodeAttemptExecution(attempt.execution),
    operational:
      attempt.operational == null
        ? null
        : decodeOperationalAttempt(attempt.operational),
    session:
      attempt.session == null ? null : decodeHarnessSession(attempt.session),
  };
}
function decodeAttemptExecution(value: unknown) {
  const execution = asRecord(value, "attempt execution");
  const model = asRecord(execution.model, "attempt model");
  return {
    harness: asString(execution.harness, "attempt harness"),
    model: {
      provider: asString(model.provider, "attempt model provider"),
      model: asString(model.model, "attempt model"),
    },
    reasoning: nullableReasoning(execution.reasoning),
    reasoning_capability: reasoningCapability(execution.reasoning_capability),
    tool_policy: toolPolicy(execution.tool_policy),
    tool_enforcement: toolEnforcement(execution.tool_enforcement),
    resolved_tool_profile: {
      tools: strings(
        asRecord(execution.resolved_tool_profile, "resolved tool profile")
          .tools,
        "resolved tool profile tools",
      ),
    },
    workspace_permission: access(execution.workspace_permission),
    worker_id: asString(execution.worker_id, "attempt Worker"),
  };
}
function decodeOperationalAttempt(value: unknown) {
  const operational = asRecord(value, "operational attempt");
  return {
    recovery_epoch: asNumber(operational.recovery_epoch, "operational attempt"),
    recovery_kind: asString(operational.recovery_kind, "operational attempt") as
      | "initial"
      | "human",
    attempt_in_epoch: asNumber(
      operational.attempt_in_epoch,
      "operational attempt",
    ),
    attempt_allowance:
      operational.attempt_allowance === null
        ? null
        : asNumber(operational.attempt_allowance, "operational attempt"),
    policy_source: asString(operational.policy_source, "operational attempt") as
      | "configured"
      | "legacy_unknown",
    continuation_mode: asString(
      operational.continuation_mode,
      "operational attempt",
    ) as "fresh" | "retained",
    recovery_authorized_at: asString(
      operational.recovery_authorized_at,
      "operational attempt",
    ),
  };
}

function decodeHarnessSession(value: unknown) {
  const session = asRecord(value, "harness session");
  const harness = asRecord(session.harness, "harness identity");
  const worker = asRecord(session.worker, "session Worker");
  const capabilities = asRecord(session.capabilities, "session capabilities");
  const attachment = asRecord(session.attachment, "session attachment");
  const nativeIdentity = asRecord(
    session.native_identity,
    "session native identity",
  );
  const attention =
    session.attention === null
      ? null
      : asRecord(session.attention, "human attention");
  return {
    id: asString(session.id, "harness session"),
    harness: {
      kind: asString(harness.kind, "harness identity"),
      display_name: asString(harness.display_name, "harness identity"),
    },
    worker: {
      id: asString(worker.id, "session Worker"),
      display_name: asString(worker.display_name, "session Worker"),
      state: asString(worker.state, "session Worker") as
        | "connected"
        | "disconnected",
    },
    state: asString(session.state, "harness session") as HarnessSessionState,
    native_identity: {
      conversation_id: nullableString(
        nativeIdentity.conversation_id,
        "native conversation identity",
      ),
      terminal_id: nullableString(
        nativeIdentity.terminal_id,
        "native terminal identity",
      ),
    },
    capabilities: {
      can_attach_terminal: asBoolean(
        capabilities.can_attach_terminal,
        "session capabilities",
      ),
      can_send_input: asBoolean(
        capabilities.can_send_input,
        "session capabilities",
      ),
      can_interrupt: asBoolean(
        capabilities.can_interrupt,
        "session capabilities",
      ),
      can_detect_attention: asBoolean(
        capabilities.can_detect_attention,
        "session capabilities",
      ),
      can_resume: asBoolean(capabilities.can_resume, "session capabilities"),
      can_observe_structured_events: asBoolean(
        capabilities.can_observe_structured_events,
        "session capabilities",
      ),
      structured_confirmation: asBoolean(
        capabilities.structured_confirmation,
        "session capabilities",
      ),
      structured_text_response: asBoolean(
        capabilities.structured_text_response,
        "session capabilities",
      ),
      structured_choice_response: asBoolean(
        capabilities.structured_choice_response,
        "session capabilities",
      ),
      structured_multiline_response: asBoolean(
        capabilities.structured_multiline_response,
        "session capabilities",
      ),
      native_prompt_control: asBoolean(
        capabilities.native_prompt_control,
        "session capabilities",
      ),
      conversational_takeover: asBoolean(
        capabilities.conversational_takeover,
        "session capabilities",
      ),
      automation_resume: asBoolean(
        capabilities.automation_resume,
        "session capabilities",
      ),
    },
    attachment: {
      mode: "local_native_terminal" as const,
      available: asBoolean(attachment.available, "session attachment"),
      reason: nullableString(attachment.reason, "session attachment"),
      can_observe: asBoolean(attachment.can_observe, "session attachment"),
      can_takeover: asBoolean(attachment.can_takeover, "session attachment"),
      can_recover: attachment.can_recover === true,
    },
    attention: attention
      ? {
          attention_id: asString(attention.attention_id, "human attention"),
          category: asString(attention.category, "human attention"),
          message: asString(attention.message, "human attention"),
          requested_at: asString(attention.requested_at, "human attention"),
          ...(attention.interaction == null
            ? {}
            : {
                interaction: decodeHumanInteraction(attention.interaction),
              }),
        }
      : null,
    started_at: asString(session.started_at, "harness session"),
    last_activity_at: asString(session.last_activity_at, "harness session"),
    events: asArray(session.events, "session events").map((value) => {
      const event = asRecord(value, "session event");
      return {
        id: asString(event.id, "session event"),
        type: asString(event.type, "session event"),
        attention_id: nullableString(event.attention_id, "session event"),
        metadata: asRecord(event.metadata, "session event metadata") as Record<
          string,
          JsonValue
        >,
        occurred_at: asString(event.occurred_at, "session event"),
      };
    }),
  };
}
function decodeHumanInteraction(value: unknown) {
  const interaction = asRecord(value, "human interaction");
  const kind = asString(interaction.kind, "human interaction");
  const controlState = asString(interaction.control_state, "human interaction");
  if (
    ![
      "confirmation",
      "text",
      "choice",
      "multiline_response",
      "conversational_intervention",
    ].includes(kind) ||
    !["intervention_pending", "human_control", "resuming_automation"].includes(
      controlState,
    )
  )
    throw new Error("Unsupported human interaction state.");
  return {
    kind: kind as
      | "confirmation"
      | "text"
      | "choice"
      | "multiline_response"
      | "conversational_intervention",
    control_state: controlState as
      | "intervention_pending"
      | "human_control"
      | "resuming_automation",
    ...(interaction.resume_command == null
      ? {}
      : {
          resume_command: asString(
            interaction.resume_command,
            "human interaction",
          ),
        }),
  };
}

function decodeArtifactRef(value: unknown) {
  const x = asRecord(value, "artifact reference");
  return {
    name: asString(x.name, "artifact reference"),
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
    producer_attempt_id: nullableString(
      x.producer_attempt_id,
      "artifact producer attempt",
    ),
    version: x.version == null ? null : asNumber(x.version, "artifact version"),
    supersedes_artifact_id:
      x.supersedes_artifact_id == null
        ? null
        : asString(x.supersedes_artifact_id, "superseded artifact"),
    content_hash:
      x.content_hash == null ? null : asString(x.content_hash, "artifact hash"),
    media_type:
      x.media_type == null
        ? null
        : asString(x.media_type, "artifact media type"),
    filename:
      x.filename == null ? null : asString(x.filename, "artifact filename"),
    title: x.title == null ? null : asString(x.title, "artifact title"),
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
  if (x.trim() !== "") return x;
  throw new Error("Invalid reasoning.");
}
function nullableReasoning(value: unknown): Reasoning | null {
  return value === null ? null : reasoning(value);
}
function reasoningCapability(value: unknown): ReasoningCapability {
  const capability = asRecord(value, "reasoning capability");
  if (capability.kind === "unsupported") return { kind: "unsupported" };
  if (capability.kind === "enumerated") {
    const values = strings(
      capability.values,
      "reasoning capability values",
    ).map(reasoning);
    if (values.length > 0) return { kind: "enumerated", values };
  }
  throw new Error("Invalid reasoning capability.");
}
function toolPolicy(value: unknown): ToolPolicy {
  const policy = asRecord(value, "tool policy");
  if (policy.kind === "native_permissions")
    return { kind: "native_permissions" };
  if (policy.kind === "exact")
    return { kind: "exact", tools: strings(policy.tools, "tool policy tools") };
  throw new Error("Invalid tool policy.");
}
function executionToolPolicy(value: unknown): { kind: ToolPolicy["kind"] } {
  const policy = asRecord(value, "execution tool policy");
  if (policy.kind === "exact" || policy.kind === "native_permissions")
    return { kind: policy.kind };
  throw new Error("Invalid execution tool policy.");
}
function toolEnforcement(value: unknown): ToolEnforcement {
  const enforcement = asString(value, "tool enforcement");
  if (enforcement === "exact" || enforcement === "native_permissions")
    return enforcement;
  throw new Error("Invalid tool enforcement.");
}
function access(value: unknown): WorkspaceAccess {
  const x = asString(value, "workspace access");
  if (x === "none" || x === "read_only" || x === "read_write") return x;
  throw new Error("Invalid workspace access.");
}
