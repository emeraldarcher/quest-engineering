import { expect, mock, test } from "bun:test";
import {
  ApiError,
  type Workspace,
  type WorkspaceSource,
} from "../../api/contracts";
import { ProjectAddCoordinator } from "./project-add-coordinator";

const source: WorkspaceSource = {
  candidate_id: "candidate-old",
  name: "quest-engineering",
  source_kind: "git_remote",
  source_fingerprint: "https://github.com/emeraldarcher/quest-engineering",
  publication_repository_identity: "emeraldarcher/quest-engineering",
  max_access: "read_write",
  shell_available: true,
};
const project: Workspace = {
  id: "workspace-authoritative",
  key: "quest-engineering",
  name: "Quest Engineering",
  source_kind: source.source_kind,
  source_fingerprint: source.source_fingerprint,
  binding: { state: "unbound", message: "Not connected." },
  archived_at: null,
};

test("retains the created Workspace when the binding request fails", async () => {
  const createWorkspace = mock(async () => project);
  const bindWorkspaceSource = mock(async () => {
    throw new Error("response lost");
  });
  const flow = new ProjectAddCoordinator({
    createWorkspace,
    bindWorkspaceSource,
  });

  const result = await flow.add(source, project.name, []);

  expect(result.project.id).toBe(project.id);
  expect(result.connection).toBe("issue");
  expect(flow.authoritativeProject?.id).toBe(project.id);
  expect(createWorkspace).toHaveBeenCalledTimes(1);
});

test("retries connection against the same authoritative Workspace ID", async () => {
  let attempts = 0;
  const bindWorkspaceSource = mock(
    async (_workspaceId: string, _candidateId: string) => {
      attempts += 1;
      if (attempts === 1) throw new Error("temporary failure");
    },
  );
  const flow = new ProjectAddCoordinator({
    createWorkspace: async () => project,
    bindWorkspaceSource,
  });

  await flow.add(source, project.name, []);
  const retry = await flow.reconnect("candidate-current");

  expect(retry.project.id).toBe(project.id);
  expect(bindWorkspaceSource.mock.calls.map((call) => call[0])).toEqual([
    project.id,
    project.id,
  ]);
});

test("rediscovered stale candidate binds the same Workspace", async () => {
  const candidateIds: string[] = [];
  const flow = new ProjectAddCoordinator({
    createWorkspace: async () => project,
    bindWorkspaceSource: async (workspaceId, candidateId) => {
      expect(workspaceId).toBe(project.id);
      candidateIds.push(candidateId);
      if (candidateId === source.candidate_id)
        throw new Error("candidate stale");
    },
  });

  await flow.add(source, project.name, []);
  await flow.reconnect("candidate-rediscovered");

  expect(candidateIds).toEqual(["candidate-old", "candidate-rediscovered"]);
  expect(flow.authoritativeProject?.id).toBe(project.id);
});

test("double Add submission shares one create operation", async () => {
  let release: (() => void) | undefined;
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  const createWorkspace = mock(async () => {
    await wait;
    return project;
  });
  const flow = new ProjectAddCoordinator({
    createWorkspace,
    bindWorkspaceSource: async () => undefined,
  });

  const first = flow.add(source, project.name, []);
  const second = flow.add(source, project.name, []);
  release?.();
  const [firstResult, secondResult] = await Promise.all([first, second]);

  expect(createWorkspace).toHaveBeenCalledTimes(1);
  expect(firstResult.project.id).toBe(secondResult.project.id);
});

test("a timed-out binding request retains the created Workspace", async () => {
  const createWorkspace = mock(async () => project);
  const flow = new ProjectAddCoordinator(
    {
      createWorkspace,
      bindWorkspaceSource: async () => new Promise(() => undefined),
    },
    1,
  );

  const result = await flow.add(source, project.name, []);

  expect(result.connection).toBe("issue");
  expect(result.project.id).toBe(project.id);
  expect(createWorkspace).toHaveBeenCalledTimes(1);
});

test("key suffix retry happens only before Workspace creation succeeds", async () => {
  const keys: string[] = [];
  const createWorkspace = mock(async (input: { key?: string }) => {
    keys.push(input.key ?? "");
    if (keys.length === 1)
      throw new ApiError(
        "validation_failed",
        "The request is invalid.",
        [{ code: "invalid_value", path: ["key"], details: {} }],
        {},
        422,
      );
    return { ...project, key: input.key ?? project.key };
  });
  const flow = new ProjectAddCoordinator({
    createWorkspace,
    bindWorkspaceSource: async () => undefined,
  });

  await flow.add(source, project.name, []);

  expect(keys).toEqual(["quest-engineering", "quest-engineering-2"]);
  expect(createWorkspace).toHaveBeenCalledTimes(2);
});
