import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  SBX_CLAUDE_ACCOUNT_MOD_PROTOCOL,
  SBX_CLAUDE_ACCOUNT_PROFILE,
  SBX_CLAUDE_BROKER_RUN_PROFILE,
  verifySbxProfileAssets,
} from "../src/execution-environment/sbx-profile.ts";
import {
  attestClaudeInit,
  CLAUDE_CODE_EFFORT,
  CLAUDE_CODE_MODEL,
  CLAUDE_CODE_PLUGIN_NAME,
  CLAUDE_CODE_PLUGIN_PATH,
  CLAUDE_CODE_TOOLS,
  claudeCodeCommand,
} from "../src/harnesses/claude-code/adapter.ts";

const profileRoot = resolve(
  import.meta.dir,
  "../profiles/qe-claude-account-v1",
);

describe("Claude Code managed-Mod architecture", () => {
  test("launch is exact and contains no production sideload, native tool, fallback, or provider-server-tool grant", () => {
    const command = claudeCodeCommand(
      {
        configRoot: "/qe/state/claude/config",
        cwd: "/qe/state/claude/empty-cwd",
      },
      "11111111-1111-4111-8111-111111111111",
      false,
      "/qe/control/claude/0123456789abcdef0123456789abcdef",
      "a".repeat(64),
    );
    expect(command.executable).toBe("/opt/qe/claude/claude");
    expect(command.args).toEqual([
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
      "--session-id",
      "11111111-1111-4111-8111-111111111111",
      "--tools",
      CLAUDE_CODE_TOOLS.join(","),
    ]);
    expect(command.args).not.toContain("--plugin-dir");
    expect(command.args).not.toContain("--mcp-config");
    expect(command.args).not.toContain("--allowedTools");
    expect(command.args).not.toContain("--fallback-model");
    expect(command.environment.QE_ACCOUNT_CELL_MOD_PROTOCOL).toBe(
      SBX_CLAUDE_ACCOUNT_MOD_PROTOCOL,
    );
    expect(command.environment.CLAUDE_CODE_DISABLE_ADVISOR_TOOL).toBe("1");
    expect(command.environment.ENABLE_CLAUDEAI_MCP_SERVERS).toBe("false");
    expect(command.environment.ENABLE_TOOL_SEARCH).toBe("false");
    for (const forbidden of [
      "Bash",
      "Read",
      "Write",
      "Edit",
      "Task",
      "Agent",
      "WebFetch",
      "WebSearch",
      "advisor_20260301",
      "web_search_20250305",
      "agent_toolset_20260401",
    ])
      expect(command.args.join("\0")).not.toContain(forbidden);
  });

  test("zero-inference init attestation rejects every model, effort, plugin, MCP, skill, agent, and tool drift", () => {
    const exact = initFrame();
    expect(() => attestClaudeInit(exact, expectedInit())).not.toThrow();
    const traps: Array<(value: Record<string, unknown>) => void> = [
      (value) => (value.model = "claude-sonnet-4-6"),
      (value) => (value.effort = "medium"),
      (value) => (value.apiKeySource = "ANTHROPIC_API_KEY"),
      (value) => ((value.tools as string[])[0] = "Read"),
      (value) => {
        const [plugin] = value.plugins as Array<Record<string, unknown>>;
        if (plugin) plugin.path = "/home/agent/.claude/plugins/user";
      },
      (value) =>
        (value.plugins as Array<Record<string, unknown>>).push({
          name: "ambient-plugin",
          path: "/home/agent/.claude/plugins/ambient",
        }),
      (value) => (value.plugin_errors = [{ type: "hook-load-failed" }]),
      (value) => (value.mcp_servers = [{ name: "ambient", status: "ready" }]),
      (value) => (value.skills = ["user-skill"]),
      (value) => (value.agents = ["Explore"]),
      (value) => (value.permissionMode = "bypassPermissions"),
      (value) => (value.claude_code_version = "2.1.293"),
      (value) => (value.session_id = "22222222-2222-4222-8222-222222222222"),
      (value) => (value.cwd = "/qe/workspaces/default"),
    ];
    for (const trap of traps) {
      const value = structuredClone(exact);
      trap(value);
      expect(() => attestClaudeInit(value, expectedInit())).toThrow();
    }
  });

  test("managed policy installs one prepend organization Mod and fences every alternate extension surface", async () => {
    const settings = JSON.parse(
      await readFile(
        resolve(
          profileRoot,
          "files/home/.qe-profile/managed/managed-settings.json",
        ),
        "utf8",
      ),
    );
    expect(settings.enabledPlugins).toEqual({
      "qe-account-cell@qe-managed": true,
    });
    expect(settings.prependPlugins).toEqual([
      "qe-account-cell@qe-managed",
      "sec-default@builtin",
    ]);
    expect(
      settings.pluginConfigs["cc-plugin-sec-default@builtin"].options
        .allowManagedModsOnly,
    ).toBe(true);
    expect(settings.allowManagedHooksOnly).toBe(true);
    expect(settings.disableSideloadFlags).toBe(true);
    expect(settings.allowManagedMcpServersOnly).toBe(true);
    expect(settings.allowedMcpServers).toEqual([]);
    expect(settings.managedMcpServers).toEqual({});
    expect(settings.disableClaudeAiConnectors).toBe(true);
    expect(settings.syncClaudeAiSkills).toBe(false);
    expect(settings.syncClaudeAiPlugins).toBe(false);
    expect(settings.availableModels).toEqual([CLAUDE_CODE_MODEL]);
    expect(settings.availableModelsMatch).toBe("exact");
    expect(settings.fallbackModel).toEqual([]);
    expect(settings.effortLevel).toBe(CLAUDE_CODE_EFFORT);
    expect(settings.maxEffortLevel).toBe(CLAUDE_CODE_EFFORT);

    const source = await readFile(
      resolve(
        profileRoot,
        "files/home/.qe-profile/claude-plugins/plugins/qe-account-cell/hooks/register.ts",
      ),
      "utf8",
    );
    for (const forbidden of [
      "$.fs.",
      "$.http.",
      "$.model.",
      "$.mcp.",
      "$.session.send",
      "$.prompt.submit",
      "$.tool.call",
      "$.agent.spawn",
    ])
      expect(source).not.toContain(forbidden);
    for (const fence of [
      'on("plugin.register"',
      'on("agent.offer"',
      'on("agent.spawn"',
      'on("tool.call"',
      'on("tool.check"',
      'on("prompt.submit"',
      'on("turn.step"',
    ])
      expect(source).toContain(fence);
    expect(source).toContain("serverToolUses");
  });

  test("both repository-owned cell profiles pass immutable asset verification", async () => {
    await expect(
      verifySbxProfileAssets(SBX_CLAUDE_ACCOUNT_PROFILE),
    ).resolves.toBeUndefined();
    await expect(
      verifySbxProfileAssets(SBX_CLAUDE_BROKER_RUN_PROFILE),
    ).resolves.toBeUndefined();
  });
});

function expectedInit() {
  return {
    sessionId: "11111111-1111-4111-8111-111111111111",
    cwd: "/qe/state/claude/empty-cwd",
    model: CLAUDE_CODE_MODEL,
    effort: CLAUDE_CODE_EFFORT,
  };
}

function initFrame(): Record<string, unknown> {
  return {
    type: "system",
    subtype: "init",
    session_id: "11111111-1111-4111-8111-111111111111",
    claude_code_version: "2.1.292",
    apiKeySource: "oauth",
    cwd: "/qe/state/claude/empty-cwd",
    model: CLAUDE_CODE_MODEL,
    effort: CLAUDE_CODE_EFFORT,
    permissionMode: "dontAsk",
    tools: [...CLAUDE_CODE_TOOLS],
    mcp_servers: [],
    skills: [],
    agents: [],
    plugins: [
      {
        name: CLAUDE_CODE_PLUGIN_NAME,
        path: CLAUDE_CODE_PLUGIN_PATH,
        version: "1.0.0",
      },
      {
        name: "cc-plugin-sec-default",
        path: "builtin",
      },
    ],
  };
}
