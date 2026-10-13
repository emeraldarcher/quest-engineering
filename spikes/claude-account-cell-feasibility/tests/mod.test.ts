import type { On } from "claude-code";
import { type Engine, expect, mock, test, tier } from "claude-code/testing";

tier("prepend");

const PREFIX = "mcp__qe-account-cell-feasibility__";
const READ = `${PREFIX}qe_workspace_read`;
const LIST = `${PREFIX}qe_workspace_list`;
const WRITE = `${PREFIX}qe_workspace_write`;
const EDIT = `${PREFIX}qe_workspace_edit`;
const SEARCH = `${PREFIX}qe_workspace_search`;
const SHELL = `${PREFIX}qe_run_shell`;
const COMPLETE = `${PREFIX}qe_complete_step`;
const ATTENTION = `${PREFIX}qe_request_human_assistance_and_wait`;
const MODEL = "claude-opus-5-5";
const BRIDGE = "/opt/qe/bin/qe-account-cell-bridge";

function configure(on: On): string[] {
	const registeredTools: string[] = [];
	mock.env(on, {
		QE_ACCOUNT_CELL_MOD_PROTOCOL: "qe_claude_account_cell_feasibility_v1",
		QE_CLAUDE_MODEL: MODEL,
		QE_CLAUDE_EFFORT: "high",
	});
	on("session.id", () => ({ value: "session-a" }));
	on("tool.register", (_$, event) => {
		registeredTools.push(event.name);
		return {
			value: { tool: `${PREFIX}${event.name}` },
		};
	});
	on("command.register", () => ({
		value: { command: "qe_account_cell_probe" },
	}));
	on("session.start", () => ({ cwd: "/account-cell/empty" }));
	return registeredTools;
}

async function start(engine: Engine) {
	return engine.session.start({
		cwd: "/account-cell/empty",
		surface: null,
		isInteractive: false,
	});
}

function successfulProcess(stdout: Record<string, unknown>) {
	return {
		value: {
			exitCode: 0,
			stdout: JSON.stringify(stdout),
			stderr: "",
			isStdoutTruncated: false,
			isStderrTruncated: false,
		},
	};
}

test("registers only the eight QE broker/control tools and attests the native session", async ($, on) => {
	const registeredTools = configure(on);

	await start($);
	const probe = await $.command.run({
		command: "qe_account_cell_probe",
		args: "",
		origin: { kind: "sdk" },
		presentation: { isFullscreen: false, columns: 80 },
	});

	expect(registeredTools).toEqual([
		"qe_workspace_read",
		"qe_workspace_list",
		"qe_workspace_write",
		"qe_workspace_edit",
		"qe_workspace_search",
		"qe_run_shell",
		"qe_complete_step",
		"qe_request_human_assistance_and_wait",
	]);
	expect(JSON.parse(probe.text ?? "")).toEqual({
		protocol: "qe_claude_account_cell_feasibility_v1",
		ready: true,
		nativeSessionId: "session-a",
		tools: [COMPLETE, ATTENTION, SHELL, EDIT, LIST, READ, SEARCH, WRITE],
	});
});

test("workspace Read crosses only the fixed pre-bound broker process", async ($, on) => {
	configure(on);
	on("process.run", (_$, event) => {
		expect(event.argv).toEqual([BRIDGE, "bound-operation"]);
		expect(JSON.parse(event.init?.stdin ?? "")).toEqual({
			type: "workspace_read",
			path: "src/main.ts",
			offset: 10,
			limit: 20,
		});
		return successfulProcess({ content: "run-cell data" });
	});

	await start($);
	const answer = await $.tool.call({
		tool: READ,
		path: "src/main.ts",
		offset: 10,
		limit: 20,
	});

	expect(JSON.parse(String(answer.result))).toEqual({
		content: "run-cell data",
	});
});

test("shell command remains bounded JSON data and never becomes account-cell argv", async ($, on) => {
	configure(on);
	on("process.run", (_$, event) => {
		expect(event.argv).toEqual([BRIDGE, "bound-operation"]);
		expect(event.argv).not.toContain("pwd && env");
		expect(JSON.parse(event.init?.stdin ?? "")).toEqual({
			type: "run_shell",
			command: "pwd && env",
			timeoutMs: 5_000,
		});
		return successfulProcess({ cwd: "/run-cell/workspace", exitCode: 0 });
	});

	await start($);
	const answer = await $.tool.call({
		tool: SHELL,
		command: "pwd && env",
		timeoutMs: 5_000,
	});

	expect(JSON.parse(String(answer.result))).toEqual({
		cwd: "/run-cell/workspace",
		exitCode: 0,
	});
});

test("native Read and Bash plus malformed broker input fail before any local core or bridge execution", async ($, on) => {
	configure(on);
	let coreCalls = 0;
	let bridgeCalls = 0;
	on("tool.call", () => {
		coreCalls += 1;
		return { result: "core unexpectedly ran" };
	});
	on("process.run", () => {
		bridgeCalls += 1;
		return successfulProcess({ unexpected: true });
	});

	await start($);
	const nativeRead = await $.tool.call({
		tool: "Read",
		file_path: "/account-cell/claude-config/.credentials.json",
	});
	const nativeBash = await $.tool.call({ tool: "Bash", command: "env" });
	const malformed = await $.tool.call({ tool: READ, path: "../../account" });

	expect(nativeRead.deny).toContain("did not authorize Read");
	expect(nativeBash.deny).toContain("did not authorize Bash");
	expect(malformed.deny).toContain("failed closed");
	expect(coreCalls).toBe(0);
	expect(bridgeCalls).toBe(0);
});

test("subagents are hidden and cannot spawn or use broker tools", async ($, on) => {
	configure(on);
	let bridgeCalls = 0;
	on("process.run", () => {
		bridgeCalls += 1;
		return successfulProcess({ unexpected: true });
	});

	await start($);
	const offer = await $.agent.offer({
		agent: "Explore",
		description: "Explore code",
		source: "built-in",
		provider: { plugin: "engine", tier: "core" },
	});
	const spawn = await $.agent.spawn({
		tool_use_id: "tool-1",
		prompt: "Explore",
		description: "Explore",
		subagentType: "Explore",
		provider: { plugin: "engine", tier: "core" },
		parentModel: MODEL,
		permissionMode: "default",
		background: false,
		fork: false,
	});
	const call = await $.tool.call({
		tool: READ,
		path: "README.md",
		agentId: "agent-1",
	});

	expect(offer.isOffered).toBe(false);
	expect(spawn.deny).toContain("disables Claude subagents");
	expect(call.deny).toContain("denies subagent tool calls");
	expect(bridgeCalls).toBe(0);
});

test("HumanAttention waits on one fixed bridge operation without local UI or shell", async ($, on) => {
	configure(on);
	on("process.spawn", async function* (_$, event) {
		expect(event.argv).toEqual([BRIDGE, "bound-human-attention-wait"]);
		expect(JSON.parse(event.input ?? "")).toEqual({
			type: "request_human_assistance_and_wait",
			category: "needs_input",
			message: "Which target?",
			interaction: "choice",
			responseSchema: { enum: ["a", "b"] },
		});
		yield {
			stream: "stdout",
			text: JSON.stringify({
				accepted: true,
				humanResponse: { outcome: "completed", value: "b" },
			}),
		};
		return { value: { code: 0, signal: null } };
	});

	await start($);
	const answer = await $.tool.call({
		tool: ATTENTION,
		category: "needs_input",
		message: "Which target?",
		interaction: "choice",
		responseSchema: { enum: ["a", "b"] },
	});

	expect(JSON.parse(String(answer.result))).toEqual({
		accepted: true,
		humanResponse: { outcome: "completed", value: "b" },
	});
});

test("completion carries semantic output only and no QE authority identifiers", async ($, on) => {
	configure(on);
	on("process.run", (_$, event) => {
		const operation = JSON.parse(event.init?.stdin ?? "");
		expect(operation).toEqual({
			type: "complete_step",
			outputs: { summary: "done" },
		});
		expect(JSON.stringify(operation)).not.toContain("runId");
		expect(JSON.stringify(operation)).not.toContain("providerAccountId");
		return successfulProcess({ accepted: true });
	});

	await start($);
	const answer = await $.tool.call({
		tool: COMPLETE,
		outputs: { summary: "done" },
	});

	expect(JSON.parse(String(answer.result))).toEqual({ accepted: true });
});

test("managed deny remains final while ordinary broker asks can be approved", async ($, on) => {
	configure(on);
	on("tool.check", (_$, event) =>
		event.tool === WRITE
			? { decision: "deny", reason: "managed deny" }
			: { decision: "ask", reason: "ordinary prompt" },
	);

	await start($);
	const read = await $.tool.check({ tool: READ, input: {} });
	const write = await $.tool.check({ tool: WRITE, input: {} });
	const native = await $.tool.check({ tool: "Bash", input: {} });

	expect(read.decision).toBe("allow");
	expect(write).toEqual({ decision: "deny", reason: "managed deny" });
	expect(native.decision).toBe("deny");
});

test(
	"unapproved user Mods fail closed before their hooks load",
	{
		plugins: [
			{
				name: "unapproved",
				register(pluginOn: On) {
					pluginOn("tool.call", async ($, event) => {
						await $.process.run(["/bin/sh", "-c", String(event.tool)]);
						return { result: "unapproved" };
					});
				},
			},
		],
	},
	async ($, on) => {
		configure(on);
		let refusal = "";

		try {
			await start($);
		} catch (error) {
			refusal = error instanceof Error ? error.message : String(error);
		}

		expect(refusal).toContain("refused by qe-account-cell-feasibility");
		expect(refusal).toContain("only immutable organization");
	},
);

test("unapproved local commands fail before core execution", async ($, on) => {
	configure(on);
	let coreCommands = 0;
	on("command.run", () => {
		coreCommands += 1;
		return { text: "core command" };
	});

	await start($);
	const command = await $.command.run({
		command: "doctor",
		args: "",
		origin: { kind: "sdk" },
		presentation: { isFullscreen: false, columns: 80 },
	});

	expect(command.text).toContain("refused this local command");
	expect(coreCommands).toBe(0);
});

test("prompt mediation adds context but never submits a second prompt", async ($, on) => {
	configure(on);
	let downstreamPrompts = 0;
	on("prompt.submit", (_$, event) => {
		downstreamPrompts += 1;
		return {
			text: event.text,
			context: event.context,
			origin: event.origin,
		};
	});

	await start($);
	const prompt = await $.prompt.submit({
		text: "Implement the authorized step",
		wait: false,
		origin: { kind: "sdk" },
	});

	expect(downstreamPrompts).toBe(1);
	expect(prompt.context?.[0]).toContain("account-cell contract");
});

test("exact model and effort pass while subagent and server-tool responses are refused", async ($, on) => {
	configure(on);
	let modelRequests = 0;
	on("turn.step", async function* (_$, event) {
		yield* [];
		modelRequests += 1;
		return {
			turnId: event.turnId,
			index: event.index,
			answer: "unexpected",
			toolUses: [],
			serverToolUses: [
				{
					id: "server-tool-1",
					name: "advisor",
					input: {},
					startedAt: 1,
					endedAt: 2,
				},
			],
			stopReason: "end_turn",
			usage: null,
		};
	});

	await start($);
	const subagent = $.turn.step({
		turnId: "turn-1",
		index: 0,
		model: MODEL,
		effort: "high",
		messageCount: 1,
		agentId: "agent-1",
	});
	let subagentItem = await subagent.next();
	while (subagentItem.done !== true) subagentItem = await subagent.next();

	const main = $.turn.step({
		turnId: "turn-2",
		index: 0,
		model: MODEL,
		effort: "high",
		messageCount: 1,
	});
	let mainItem = await main.next();
	while (mainItem.done !== true) mainItem = await main.next();

	expect(modelRequests).toBe(1);
	expect(subagentItem.value.stopReason).toBe("refusal");
	expect(mainItem.value).toMatchObject({
		answer: "",
		toolUses: [],
		stopReason: "refusal",
	});
});
