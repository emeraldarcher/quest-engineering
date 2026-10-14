import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { WORKSPACE_TOOL_PROGRAM } from "../src/execution-environment/sbx-run.ts";
import type { WorkspaceToolRequest } from "../src/workspace-tool-broker-protocol.ts";

let root = "";
let outsideCanary = "";

beforeEach(async () => {
  root = join(
    process.cwd(),
    ".pi",
    "tmp",
    `workspace-tool-program-${crypto.randomUUID()}`,
  );
  outsideCanary = `${root}-account-canary`;
  await mkdir(root, { recursive: true });
  await writeFile(outsideCanary, "ACCOUNT_CELL_ONLY_CANARY", { mode: 0o600 });
});

afterEach(async () => {
  await Promise.all([
    rm(root, { force: true, recursive: true }),
    rm(outsideCanary, { force: true }),
  ]);
});

describe("Run-cell workspace tool program", () => {
  test("performs the complete bounded filesystem and search vocabulary", async () => {
    await mkdir(join(root, "notes"));
    expect(
      await invoke({
        version: "workspace_tool_broker_v1",
        type: "request",
        request_id: "write",
        operation: "filesystem.write",
        arguments: { path: "notes/item.txt", content: "alpha beta\nalpha\n" },
      }),
    ).toMatchObject({
      ok: true,
      result: { path: "notes/item.txt", bytes: 17 },
    });

    expect(
      await invoke({
        version: "workspace_tool_broker_v1",
        type: "request",
        request_id: "read",
        operation: "filesystem.read",
        arguments: { path: "notes/item.txt" },
      }),
    ).toMatchObject({
      ok: true,
      result: {
        path: "notes/item.txt",
        content: "alpha beta\nalpha\n",
        bytes: 17,
      },
    });

    expect(
      await invoke({
        version: "workspace_tool_broker_v1",
        type: "request",
        request_id: "stat",
        operation: "filesystem.stat",
        arguments: { path: "notes/item.txt" },
      }),
    ).toMatchObject({
      ok: true,
      result: { path: "notes/item.txt", name: "item.txt", type: "file" },
    });

    expect(
      await invoke({
        version: "workspace_tool_broker_v1",
        type: "request",
        request_id: "list",
        operation: "filesystem.list",
        arguments: { path: "notes" },
      }),
    ).toMatchObject({
      ok: true,
      result: { path: "notes", entries: [{ name: "item.txt", type: "file" }] },
    });

    expect(
      await invoke({
        version: "workspace_tool_broker_v1",
        type: "request",
        request_id: "edit",
        operation: "filesystem.edit",
        arguments: {
          path: "notes/item.txt",
          old_text: "alpha",
          new_text: "gamma",
          expected_replacements: 2,
        },
      }),
    ).toMatchObject({
      ok: true,
      result: { path: "notes/item.txt", replacements: 2, bytes: 17 },
    });

    expect(
      await invoke({
        version: "workspace_tool_broker_v1",
        type: "request",
        request_id: "search",
        operation: "search.grep",
        arguments: { path: ".", query: "gamma" },
      }),
    ).toEqual({
      ok: true,
      result: {
        matches: [
          { path: "notes/item.txt", line: 1, text: "gamma beta" },
          { path: "notes/item.txt", line: 2, text: "gamma" },
        ],
        truncated: false,
      },
    });
  });

  test("denies traversal, symlink escape, oversized reads, and stale edits", async () => {
    await symlink(outsideCanary, join(root, "outside-link"));
    expect(await invoke(readRequest("../outside", "traversal"))).toMatchObject({
      ok: false,
      error: { code: "path_invalid", certainty: "not_submitted" },
    });
    expect(await invoke(readRequest("outside-link", "symlink"))).toMatchObject({
      ok: false,
      error: { code: "path_invalid", certainty: "not_submitted" },
    });

    await writeFile(join(root, "large.txt"), "x".repeat(256 * 1024 + 1));
    expect(await invoke(readRequest("large.txt", "large"))).toMatchObject({
      ok: false,
      error: { code: "file_too_large", certainty: "not_submitted" },
    });

    await writeFile(join(root, "stale.txt"), "current");
    expect(
      await invoke({
        version: "workspace_tool_broker_v1",
        type: "request",
        request_id: "stale-edit",
        operation: "filesystem.edit",
        arguments: {
          path: "stale.txt",
          old_text: "missing",
          new_text: "replacement",
          expected_replacements: 1,
        },
      }),
    ).toMatchObject({
      ok: false,
      error: { code: "edit_mismatch", certainty: "not_submitted" },
    });
  });
});

function readRequest(path: string, requestId: string): WorkspaceToolRequest {
  return {
    version: "workspace_tool_broker_v1",
    type: "request",
    request_id: requestId,
    operation: "filesystem.read",
    arguments: { path },
  };
}

async function invoke(
  request: WorkspaceToolRequest,
): Promise<Record<string, unknown>> {
  const process = Bun.spawn(
    ["/usr/bin/python3", "-u", "-c", WORKSPACE_TOOL_PROGRAM],
    {
      cwd: root,
      env: {},
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  process.stdin.write(`${JSON.stringify(request)}\n`);
  process.stdin.end();
  const [exitCode, stdout, stderr] = await Promise.all([
    process.exited,
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
  ]);
  expect(exitCode, stderr).toBe(0);
  return JSON.parse(stdout) as Record<string, unknown>;
}
