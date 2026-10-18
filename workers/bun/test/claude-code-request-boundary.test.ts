import { afterEach, expect, test } from "bun:test";
import { cp, mkdir, mkdtemp, rm } from "node:fs/promises";
import { createServer, type IncomingHttpHeaders } from "node:http";
import { join, resolve } from "node:path";
import {
  CLAUDE_CODE_EFFORT,
  CLAUDE_CODE_MODEL,
  CLAUDE_CODE_TOOLS,
} from "../src/harnesses/claude-code/adapter.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true })),
  );
});

test("pinned Claude Code fresh, multi-turn, retry, high-context compaction, and exact-resume recovery requests omit every provider/server tool", async () => {
  const root = await testRoot();
  const config = join(root, "config");
  const cwd = join(root, "cwd");
  await mkdir(config, { recursive: true });
  await mkdir(cwd, { recursive: true });
  await Bun.write(
    join(config, ".claude.json"),
    JSON.stringify({ hasCompletedOnboarding: true }),
  );

  const fresh = await capture({ config, cwd, mode: "fresh", requests: 1 });
  assertExactRequests(fresh.requests);

  const multi = await capture({
    config,
    cwd,
    mode: "fresh",
    requests: 2,
    sessionId: "22222222-2222-4222-8222-222222222222",
  });
  assertExactRequests(multi.requests);

  const retry = await capture({
    config,
    cwd,
    mode: "retry",
    requests: 2,
    sessionId: "33333333-3333-4333-8333-333333333333",
  });
  assertExactRequests(retry.requests);

  const compact = await capture({
    config,
    cwd,
    mode: "compact",
    requests: 2,
    sessionId: "55555555-5555-4555-8555-555555555555",
  });
  assertExactRequests(compact.requests);
  expect(JSON.stringify(compact.requests[1]?.body)).toContain(
    "preserved verbatim in the summary so they continue to apply after compaction",
  );

  const seedSession = "44444444-4444-4444-8444-444444444444";
  const seed = await capture({
    config,
    cwd,
    mode: "fresh",
    requests: 1,
    sessionId: seedSession,
  });
  assertExactRequests(seed.requests);
  const resumed = await capture({
    config,
    cwd,
    mode: "resume",
    requests: 1,
    sessionId: seedSession,
  });
  assertExactRequests(resumed.requests);
}, 60_000);

interface CaptureRequest {
  headers: IncomingHttpHeaders;
  body: Record<string, unknown>;
}

async function capture(input: {
  config: string;
  cwd: string;
  mode: "fresh" | "retry" | "compact" | "resume";
  requests: number;
  sessionId?: string;
}): Promise<{ requests: CaptureRequest[] }> {
  const requests: CaptureRequest[] = [];
  let resolveCount: (() => void) | null = null;
  const enough = new Promise<void>((resolve) => {
    resolveCount = resolve;
  });
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    request.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<
        string,
        unknown
      >;
      requests.push({ headers: request.headers, body });
      if (requests.length >= input.requests) resolveCount?.();
      if (input.mode === "compact" && requests.length === 1) {
        response.statusCode = 200;
        response.setHeader("content-type", "text/event-stream");
        response.end(fakeSuccessSse());
      } else {
        response.statusCode = input.mode === "retry" ? 529 : 400;
        response.setHeader("content-type", "application/json");
        if (input.mode === "retry") response.setHeader("retry-after", "0");
        response.end(
          JSON.stringify({
            type: "error",
            error: {
              type:
                input.mode === "retry"
                  ? "overloaded_error"
                  : "invalid_request_error",
              message:
                input.mode === "retry"
                  ? "QE deterministic fake overload"
                  : "QE deterministic fake provider boundary",
            },
          }),
        );
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Fake provider did not bind.");
  const sessionId = input.sessionId ?? "11111111-1111-4111-8111-111111111111";
  const pluginSource = resolve(
    import.meta.dir,
    "../profiles/qe-claude-account-v2/files/home/.qe-profile/claude-plugins/plugins/qe-account-cell",
  );
  const plugin = join(input.config, "qe-account-cell-plugin");
  await cp(pluginSource, plugin, { recursive: true });
  const child = Bun.spawn(
    [
      claudeBinary(),
      "-p",
      "--input-format",
      "stream-json",
      "--output-format",
      "stream-json",
      "--verbose",
      "--restricted",
      "--strict-mcp-config",
      "--permission-mode",
      "dontAsk",
      "--permission-prompts",
      "none",
      "--model",
      CLAUDE_CODE_MODEL,
      "--effort",
      CLAUDE_CODE_EFFORT,
      ...(input.mode === "compact" ? ["--autocompact", "100000"] : []),
      input.mode === "resume" ? "--resume" : "--session-id",
      sessionId,
      "--tools",
      CLAUDE_CODE_TOOLS.join(","),
      "--plugin-dir",
      plugin,
    ],
    {
      cwd: input.cwd,
      env: {
        PATH: "/usr/bin:/bin",
        HOME: input.config,
        CLAUDE_CONFIG_DIR: input.config,
        TMPDIR: input.config,
        ANTHROPIC_BASE_URL: `http://127.0.0.1:${address.port}`,
        ANTHROPIC_API_KEY: "qe-local-fake-boundary-not-a-secret",
        BROWSER: "/bin/false",
        DISABLE_AUTOUPDATER: "1",
        DISABLE_TELEMETRY: "1",
        DISABLE_ERROR_REPORTING: "1",
        ENABLE_CLAUDEAI_MCP_SERVERS: "false",
        ENABLE_TOOL_SEARCH: "false",
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
        CLAUDE_CODE_DISABLE_OFFICIAL_MARKETPLACE_AUTOINSTALL: "1",
        CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
        CLAUDE_CODE_DISABLE_CLAUDE_MDS: "1",
        CLAUDE_CODE_DISABLE_BUNDLED_SKILLS: "1",
        CLAUDE_CODE_DISABLE_AGENT_VIEW: "1",
        CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: "1",
        CLAUDE_CODE_DISABLE_EXPLORE_PLAN_AGENTS: "1",
        CLAUDE_AGENT_SDK_DISABLE_BUILTIN_AGENTS: "1",
        CLAUDE_CODE_DISABLE_GIT_INSTRUCTIONS: "1",
        CLAUDE_CODE_DISABLE_ADVISOR_TOOL: "1",
        CLAUDE_CODE_DISABLE_ARTIFACT: "1",
        CLAUDE_CODE_DISABLE_FAST_MODE: "1",
        QE_ACCOUNT_CELL_MOD_PROTOCOL: "qe_claude_account_cell_v1",
        QE_CLAUDE_MODEL: CLAUDE_CODE_MODEL,
        QE_CLAUDE_EFFORT: CLAUDE_CODE_EFFORT,
        QE_ACCOUNT_CELL_MAILBOX:
          "/qe/control/claude/0123456789abcdef0123456789abcdef",
        QE_ACCOUNT_CELL_BRIDGE_TOKEN: "a".repeat(64),
        CLAUDE_CODE_STARTUP_FAILURE_RESULTS: "1",
        ...(input.mode === "compact"
          ? { CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: "1" }
          : {}),
      },
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const initialized = deferred<void>();
  const firstResult = deferred<void>();
  const output = pumpOutput(child.stdout, (frame) => {
    if (frame.type === "system" && frame.subtype === "init")
      initialized.resolve();
    if (frame.type === "result") firstResult.resolve();
  });
  const stderr = new Response(child.stderr).text();
  const send = async (content: string, shouldQuery: boolean) => {
    child.stdin.write(
      new TextEncoder().encode(
        `${JSON.stringify({
          type: "user",
          message: { role: "user", content },
          parent_tool_use_id: null,
          session_id: sessionId,
          uuid: crypto.randomUUID(),
          client_composed: true,
          ...(shouldQuery ? {} : { shouldQuery: false, isSynthetic: true }),
        })}\n`,
      ),
    );
    await child.stdin.flush();
  };
  try {
    await send("QE fixed zero-inference initialization probe.", false);
    await Promise.race([
      initialized.promise,
      Bun.sleep(10_000).then(() => {
        throw new Error("Pinned Claude Code did not initialize.");
      }),
    ]);
    await send(
      input.mode === "compact"
        ? `QE deterministic high-context compaction fixture. Do not call tools.\n${"x0a9f3z ".repeat(30_000)}`
        : "QE fake-boundary request one. Do not call tools.",
      true,
    );
    if (input.requests > 1 && input.mode !== "retry") {
      while (requests.length < 1) await Bun.sleep(20);
      if (input.mode === "compact")
        await Promise.race([
          firstResult.promise,
          Bun.sleep(10_000).then(() => {
            throw new Error("Fake high-context turn did not settle.");
          }),
        ]);
      else await Bun.sleep(100);
      await send("QE fake-boundary request two. Do not call tools.", true);
    }
    await Promise.race([
      enough,
      Bun.sleep(20_000).then(() => {
        throw new Error(
          `Pinned Claude Code emitted ${requests.length}/${input.requests} fake-boundary requests.`,
        );
      }),
    ]);
    return { requests };
  } finally {
    child.kill("SIGTERM");
    await Promise.race([
      child.exited,
      Bun.sleep(2_000).then(() => {
        child.kill("SIGKILL");
      }),
    ]);
    await Promise.race([
      Promise.allSettled([output, stderr]),
      Bun.sleep(2_000),
    ]);
    server.close();
  }
}

function fakeSuccessSse(): string {
  const events = [
    [
      "message_start",
      {
        type: "message_start",
        message: {
          id: "msg_qe_fake_compaction",
          type: "message",
          role: "assistant",
          model: CLAUDE_CODE_MODEL,
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 190_000, output_tokens: 0 },
        },
      },
    ],
    [
      "content_block_start",
      {
        type: "content_block_start",
        index: 0,
        content_block: { type: "text", text: "" },
      },
    ],
    [
      "content_block_delta",
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "QE fake boundary response." },
      },
    ],
    ["content_block_stop", { type: "content_block_stop", index: 0 }],
    [
      "message_delta",
      {
        type: "message_delta",
        delta: { stop_reason: "end_turn", stop_sequence: null },
        usage: { output_tokens: 6 },
      },
    ],
    ["message_stop", { type: "message_stop" }],
  ] as const;
  return events
    .map(
      ([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`,
    )
    .join("");
}

function assertExactRequests(requests: CaptureRequest[]): void {
  expect(requests.length).toBeGreaterThan(0);
  for (const request of requests) {
    expect(request.body.model).toBe(CLAUDE_CODE_MODEL);
    const tools = request.body.tools;
    expect(Array.isArray(tools)).toBe(true);
    const names = (tools as Array<Record<string, unknown>>).map(
      (tool) => tool.name,
    );
    expect([...names].sort()).toEqual([...CLAUDE_CODE_TOOLS].sort());
    for (const tool of tools as Array<Record<string, unknown>>) {
      expect(tool.type).toBeUndefined();
      expect(typeof tool.input_schema).toBe("object");
    }
    const encoded = JSON.stringify(request.body);
    for (const forbidden of [
      "web_search_20250305",
      "advisor_20260301",
      "agent_toolset_20260401",
      '"name":"WebSearch"',
      '"name":"Task"',
      '"name":"Agent"',
      '"name":"Bash"',
      '"name":"Read"',
      '"name":"Write"',
      '"name":"Edit"',
    ])
      expect(encoded).not.toContain(forbidden);
    const beta = String(request.headers["anthropic-beta"] ?? "");
    expect(beta).not.toContain("web_search_20250305");
    expect(beta).not.toContain("advisor_20260301");
    expect(beta).not.toContain("agent_toolset_20260401");
  }
}

function claudeBinary(): string {
  const platform = process.platform === "darwin" ? "darwin" : "linux";
  return resolve(
    import.meta.dir,
    `../node_modules/@anthropic-ai/claude-agent-sdk-${platform}-${process.arch}/claude`,
  );
}

async function pumpOutput(
  stream: ReadableStream<Uint8Array>,
  onFrame: (frame: Record<string, unknown>) => void,
): Promise<void> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffered = "";
  for (;;) {
    const next = await reader.read();
    if (next.done) return;
    buffered += decoder.decode(next.value, { stream: true });
    while (buffered.includes("\n")) {
      const index = buffered.indexOf("\n");
      const line = buffered.slice(0, index);
      buffered = buffered.slice(index + 1);
      if (!line) continue;
      const frame = JSON.parse(line) as Record<string, unknown>;
      onFrame(frame);
    }
  }
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function testRoot(): Promise<string> {
  const parent = resolve(import.meta.dir, "../.pi/tmp");
  await mkdir(parent, { recursive: true });
  const root = await mkdtemp(join(parent, "claude-request-boundary-"));
  roots.push(root);
  return root;
}
