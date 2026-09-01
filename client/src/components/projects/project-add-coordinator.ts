import type { WorkspaceInput } from "../../api/client";
import {
  ApiError,
  type Workspace,
  type WorkspaceSource,
} from "../../api/contracts";
import { availableProjectKey } from "./project-presentation";

export interface ProjectAddOperations {
  createWorkspace(input: WorkspaceInput): Promise<Workspace>;
  bindWorkspaceSource(
    workspaceId: string,
    candidateId: string,
  ): Promise<unknown>;
}

export interface ProjectAddResult {
  project: Workspace;
  connection: "requested" | "issue";
  issue?: unknown;
}

export class ProjectAddCoordinator {
  private project: Workspace | null = null;
  private addInFlight: Promise<ProjectAddResult> | null = null;
  private reconnectInFlight: Promise<ProjectAddResult> | null = null;

  constructor(
    private readonly operations: ProjectAddOperations,
    private readonly bindingTimeoutMs = 15_000,
  ) {}

  get authoritativeProject(): Workspace | null {
    return this.project;
  }

  useExistingProject(project: Workspace): void {
    this.project = project;
  }

  add(
    source: WorkspaceSource,
    name: string,
    existingKeys: Iterable<string>,
  ): Promise<ProjectAddResult> {
    if (this.addInFlight) return this.addInFlight;
    if (this.project) return this.reconnect(source.candidate_id);

    const operation = this.createAndConnect(source, name, existingKeys);
    this.addInFlight = operation;
    void operation.then(
      () => this.clearAdd(operation),
      () => this.clearAdd(operation),
    );
    return operation;
  }

  reconnect(candidateId: string): Promise<ProjectAddResult> {
    if (!this.project)
      return Promise.reject(
        new Error("A Project must exist before reconnecting."),
      );
    if (this.reconnectInFlight) return this.reconnectInFlight;

    const project = this.project;
    const operation = this.requestConnection(project, candidateId);
    this.reconnectInFlight = operation;
    void operation.then(
      () => this.clearReconnect(operation),
      () => this.clearReconnect(operation),
    );
    return operation;
  }

  private clearAdd(operation: Promise<ProjectAddResult>): void {
    if (this.addInFlight === operation) this.addInFlight = null;
  }

  private clearReconnect(operation: Promise<ProjectAddResult>): void {
    if (this.reconnectInFlight === operation) this.reconnectInFlight = null;
  }

  private async createAndConnect(
    source: WorkspaceSource,
    name: string,
    existingKeys: Iterable<string>,
  ): Promise<ProjectAddResult> {
    const keys = new Set(existingKeys);
    let suffix = 1;
    let project: Workspace | null = null;

    while (!project && suffix < 100) {
      const key = availableProjectKey(name, keys, suffix);
      try {
        project = await this.operations.createWorkspace({
          key,
          name: name.trim(),
          source_kind: source.source_kind,
          source_fingerprint: source.source_fingerprint,
        });
      } catch (cause) {
        if (!isCreateKeyCollision(cause)) throw cause;
        keys.add(key);
        suffix = suffix <= 1 ? 2 : suffix + 1;
      }
    }

    if (!project) throw new Error("Unable to create an available Project key.");
    this.project = project;
    return this.requestConnection(project, source.candidate_id);
  }

  private async requestConnection(
    project: Workspace,
    candidateId: string,
  ): Promise<ProjectAddResult> {
    try {
      await withTimeout(
        this.operations.bindWorkspaceSource(project.id, candidateId),
        this.bindingTimeoutMs,
      );
      return { project, connection: "requested" };
    } catch (issue) {
      return { project, connection: "issue", issue };
    }
  }
}

async function withTimeout<T>(
  operation: Promise<T>,
  milliseconds: number,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new Error("The repository connection request timed out.")),
      milliseconds,
    );
  });
  try {
    return await Promise.race([operation, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function isCreateKeyCollision(cause: unknown): boolean {
  return (
    cause instanceof ApiError &&
    cause.code === "validation_failed" &&
    cause.details.some(
      (detail) => detail.path.length === 1 && detail.path[0] === "key",
    )
  );
}
