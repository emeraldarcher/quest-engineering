import { afterEach, expect, mock, test } from "bun:test";
import { ApiClient } from "./client";

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

test("decodes projected occurrence and nested attempt history", async () => {
  globalThis.fetch = mock(
    async () =>
      new Response(
        JSON.stringify({
          run: {
            id: "run-1",
            status: "running",
            launched_at: "2026-09-01T12:00:00Z",
            revision: 3,
            launch: { id: "launch-1" },
            quest: { id: "quest-1", title: "Quest", objective: "Work" },
            execution_environment: {
              workspace: { id: "workspace-1", key: "project", name: "Project" },
              state: "ready",
              message: "Run workspace ready.",
              base_revision: "abc",
              branch: "qe/run/1",
              source_dirty_changes_excluded: false,
              issue: null,
            },
            delivery: null,
            squad: { id: "squad-1", key: "pair", name: "Pair", members: [] },
            steps: [
              {
                occurrence_id: "occurrence-1",
                semantic_step_key: "review",
                name: "Review",
                instruction: "Review.",
                state: "running",
                phase: "check",
                remediation_cycle: 1,
                control_path: [],
                attempt: {
                  id: "attempt-2",
                  number: 2,
                  state: "running",
                  started_at: "2026-09-01T12:01:00Z",
                  finished_at: null,
                  outputs: [],
                  output_produced: false,
                  resolution: null,
                  retry_of_attempt_id: "attempt-1",
                },
                attempts: [
                  {
                    id: "attempt-1",
                    number: 1,
                    state: "uncertain",
                    started_at: "2026-09-01T12:00:00Z",
                    finished_at: "2026-09-01T12:01:00Z",
                    outputs: [],
                    output_produced: false,
                    resolution: "retried",
                    retry_of_attempt_id: null,
                  },
                  {
                    id: "attempt-2",
                    number: 2,
                    state: "running",
                    started_at: "2026-09-01T12:01:00Z",
                    finished_at: null,
                    outputs: [],
                    output_produced: false,
                    resolution: null,
                    retry_of_attempt_id: "attempt-1",
                  },
                ],
                member: null,
                performer: {
                  selector: "class",
                  class_key: "reviewer",
                  source_occurrence_id: null,
                  source_semantic_step_key: null,
                },
                context: {
                  mode: "continue_from",
                  source_occurrence_id: "occurrence-0",
                  source_semantic_step_key: "implement",
                },
                inputs: [],
                outputs: [],
                issue: null,
              },
            ],
            artifacts: [],
            review_gate: {
              required: true,
              status: "missing",
              occurrence_id: null,
              attempt_id: null,
              artifact_id: null,
            },
            step_counts: {
              pending: 0,
              waiting: 0,
              scheduled: 0,
              running: 1,
              completed: 0,
              failed: 0,
              uncertain: 0,
            },
            issues: [],
          },
        }),
      ),
  ) as unknown as typeof fetch;

  const api = new ApiClient({ httpBaseUrl: "http://example.test/api/v1" });
  const run = await api.getRun("run-1");

  expect(run.launch.id).toBe("launch-1");
  expect(run.steps[0]?.attempt?.id).toBe("attempt-2");
  expect(run.steps[0]?.attempts).toHaveLength(2);
  expect(run.steps[0]?.attempts[0]).toMatchObject({
    number: 1,
    state: "uncertain",
    output_produced: false,
    resolution: "retried",
  });
});
