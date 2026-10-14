import type {
	EngineInterface,
	Next,
	PluginRegisterInput,
	Register,
	TurnStepInput,
} from "claude-code";

const PROTOCOL = "qe_claude_account_cell_v1";
const BRIDGE = "/opt/qe/claude/qe-account-cell-bridge";
const MAX_BRIDGE_OUTPUT = 65_536;
const MAX_OPERATION_INPUT = 1_048_576;

const PREFIX = "mcp__qe-account-cell__";
const TOOLS = {
	read: `${PREFIX}qe_workspace_read`,
	list: `${PREFIX}qe_workspace_list`,
	write: `${PREFIX}qe_workspace_write`,
	edit: `${PREFIX}qe_workspace_edit`,
	search: `${PREFIX}qe_workspace_search`,
	shell: `${PREFIX}qe_run_shell`,
	complete: `${PREFIX}qe_complete_step`,
	attention: `${PREFIX}qe_request_human_assistance_and_wait`,
} as const;
const ALLOWED_TOOLS = new Set<string>(Object.values(TOOLS));

type JsonObject = Record<string, unknown>;

function object(value: unknown, label: string): JsonObject {
	if (typeof value !== "object" || value === null || Array.isArray(value))
		throw new Error(`${label} must be an object.`);
	return value as JsonObject;
}

function boundedString(value: unknown, label: string, maximum: number): string {
	if (typeof value !== "string" || value.length === 0 || value.length > maximum)
		throw new Error(`${label} is invalid.`);
	return value;
}

function optionalInteger(
	value: unknown,
	label: string,
	minimum: number,
	maximum: number,
): number | undefined {
	if (value === undefined) return undefined;
	if (
		typeof value !== "number" ||
		!Number.isSafeInteger(value) ||
		value < minimum ||
		value > maximum
	)
		throw new Error(`${label} is invalid.`);
	return value;
}

function workspacePath(value: unknown, label: string): string {
	const path = boundedString(value, label, 4_096);
	if (
		path.startsWith("/") ||
		path.includes("\\") ||
		path.includes("\0") ||
		path.split("/").some((segment) => segment === "..")
	)
		throw new Error(`${label} must remain relative to the Run workspace.`);
	return path;
}

function boundedJson(value: unknown, label: string, maximum: number): string {
	const encoded = JSON.stringify(value);
	if (encoded === undefined || encoded.length > maximum)
		throw new Error(`${label} is invalid or too large.`);
	return encoded;
}

function parseBridgeOutput(text: string): JsonObject {
	if (text.length > MAX_BRIDGE_OUTPUT)
		throw new Error("QE broker output exceeded the spike limit.");
	return object(JSON.parse(text), "QE broker output");
}

function parseEffort(value: string): NonNullable<TurnStepInput["effort"]> {
	switch (value) {
		case "low":
		case "medium":
		case "high":
		case "xhigh":
		case "max":
			return value;
		default:
			throw new Error("QE_CLAUDE_EFFORT is invalid.");
	}
}

async function runBridge(
	$: EngineInterface,
	operation: JsonObject,
): Promise<JsonObject> {
	const input = boundedJson(
		operation,
		"QE broker operation",
		MAX_OPERATION_INPUT,
	);
	const execution = await $.process.run([BRIDGE, "bound-operation"], {
		stdin: input,
		timeoutMs: 600_000,
	});
	if (
		execution.exitCode !== 0 ||
		execution.isStdoutTruncated ||
		execution.isStderrTruncated
	)
		throw new Error(`QE broker failed with exit code ${execution.exitCode}.`);
	return parseBridgeOutput(execution.stdout);
}

async function waitForHuman(
	$: EngineInterface,
	operation: JsonObject,
): Promise<JsonObject> {
	const input = boundedJson(
		operation,
		"QE HumanAttention operation",
		MAX_OPERATION_INPUT,
	);
	const stream = $.process.spawn({
		argv: [BRIDGE, "bound-human-attention-wait"],
		input,
	});
	let stdout = "";
	let stderr = "";
	let item = await stream.next();
	while (item.done !== true) {
		if (item.value.stream === "stdout") stdout += item.value.text;
		else stderr += item.value.text;
		if (stdout.length + stderr.length > MAX_BRIDGE_OUTPUT) {
			await stream.return({ code: null, signal: "SIGTERM" });
			throw new Error("QE HumanAttention output exceeded the spike limit.");
		}
		item = await stream.next();
	}
	if (item.value.code !== 0 || item.value.signal !== null)
		throw new Error("QE HumanAttention bridge did not exit successfully.");
	return parseBridgeOutput(stdout);
}

async function checkPlugin(
	_$: EngineInterface,
	event: PluginRegisterInput,
	next: Next<"plugin.register">,
) {
	if (event.tier === "user")
		return {
			refuse:
				"QE account-cell policy permits only immutable organization and built-in Mods.",
		} as const;
	return next(event);
}

function brokerOperation(tool: string, event: JsonObject): JsonObject {
	switch (tool) {
		case TOOLS.read:
			return {
				type: "workspace_read",
				path: workspacePath(event.path, "path"),
				...(optionalInteger(event.offset, "offset", 0, 10_000_000) === undefined
					? {}
					: { offset: event.offset }),
				...(optionalInteger(event.limit, "limit", 1, 100_000) === undefined
					? {}
					: { limit: event.limit }),
			};
		case TOOLS.list:
			return {
				type: "workspace_list",
				path: workspacePath(event.path ?? ".", "path"),
			};
		case TOOLS.write:
			return {
				type: "workspace_write",
				path: workspacePath(event.path, "path"),
				content: boundedString(event.content, "content", 262_144),
			};
		case TOOLS.edit:
			return {
				type: "workspace_edit",
				path: workspacePath(event.path, "path"),
				oldText: boundedString(event.oldText, "oldText", 262_144),
				newText:
					typeof event.newText === "string" && event.newText.length <= 262_144
						? event.newText
						: (() => {
								throw new Error("newText is invalid.");
							})(),
				expectedReplacements:
					optionalInteger(
						event.expectedReplacements,
						"expectedReplacements",
						1,
						1_000,
					) ?? 1,
			};
		case TOOLS.search:
			return {
				type: "workspace_search",
				query: boundedString(event.query, "query", 4_096),
				path: workspacePath(event.path ?? ".", "path"),
				...(optionalInteger(event.maxResults, "maxResults", 1, 1_000) ===
				undefined
					? {}
					: { maxResults: event.maxResults }),
			};
		case TOOLS.shell:
			return {
				type: "run_shell",
				command: boundedString(event.command, "command", 32_768),
				timeoutMs:
					optionalInteger(event.timeoutMs, "timeoutMs", 100, 30_000) ?? 30_000,
			};
		case TOOLS.complete:
			return {
				type: "complete_step",
				outputs: object(event.outputs, "outputs"),
			};
		default:
			throw new Error("The tool is not a synchronous QE broker operation.");
	}
}

export const register: Register = (on) => {
	let ready = false;
	let expectedModel = "";
	let expectedEffort: NonNullable<TurnStepInput["effort"]> | "" = "";
	let nativeSessionId = "";

	on("plugin.register", checkPlugin).catch(async (_$, event, next) => {
		if (event.tier === "user")
			return {
				refuse: "QE failed closed while checking an unapproved Mod.",
			};
		return next(event);
	});

	on("session.start", async ($, event, next) => {
		ready = false;
		const protocol = await $.env.get("QE_ACCOUNT_CELL_MOD_PROTOCOL");
		expectedModel = (await $.env.get("QE_CLAUDE_MODEL")) ?? "";
		expectedEffort = parseEffort((await $.env.get("QE_CLAUDE_EFFORT")) ?? "");
		nativeSessionId = await $.session.id();
		if (
			protocol !== PROTOCOL ||
			expectedModel.length === 0 ||
			nativeSessionId.length === 0
		)
			throw new Error("QE account-cell Mod environment is incomplete.");

		await $.tool.register({
			name: "qe_workspace_read",
			description:
				"Read a UTF-8 file from the pre-bound Quest Engineering Run workspace. Paths are relative to that workspace; this tool cannot address the Claude account cell.",
			inputSchema: {
				type: "object",
				properties: {
					path: { type: "string", minLength: 1, maxLength: 4_096 },
					offset: { type: "integer", minimum: 0, maximum: 10_000_000 },
					limit: { type: "integer", minimum: 1, maximum: 100_000 },
				},
				required: ["path"],
				additionalProperties: false,
			},
		});
		await $.tool.register({
			name: "qe_workspace_list",
			description:
				"List a directory in the pre-bound Quest Engineering Run workspace. The account-cell filesystem is not in this tool's namespace.",
			inputSchema: {
				type: "object",
				properties: {
					path: { type: "string", minLength: 1, maxLength: 4_096 },
				},
				additionalProperties: false,
			},
		});
		await $.tool.register({
			name: "qe_workspace_write",
			description:
				"Write a UTF-8 file in the pre-bound Quest Engineering Run workspace.",
			inputSchema: {
				type: "object",
				properties: {
					path: { type: "string", minLength: 1, maxLength: 4_096 },
					content: { type: "string", maxLength: 262_144 },
				},
				required: ["path", "content"],
				additionalProperties: false,
			},
		});
		await $.tool.register({
			name: "qe_workspace_edit",
			description:
				"Replace exact text in a file in the pre-bound Quest Engineering Run workspace.",
			inputSchema: {
				type: "object",
				properties: {
					path: { type: "string", minLength: 1, maxLength: 4_096 },
					oldText: { type: "string", minLength: 1, maxLength: 262_144 },
					newText: { type: "string", maxLength: 262_144 },
					expectedReplacements: {
						type: "integer",
						minimum: 1,
						maximum: 1_000,
					},
				},
				required: ["path", "oldText", "newText"],
				additionalProperties: false,
			},
		});
		await $.tool.register({
			name: "qe_workspace_search",
			description:
				"Search only the pre-bound Quest Engineering Run workspace and return bounded matches.",
			inputSchema: {
				type: "object",
				properties: {
					query: { type: "string", minLength: 1, maxLength: 4_096 },
					path: { type: "string", minLength: 1, maxLength: 4_096 },
					maxResults: { type: "integer", minimum: 1, maximum: 1_000 },
				},
				required: ["query"],
				additionalProperties: false,
			},
		});
		await $.tool.register({
			name: "qe_run_shell",
			description:
				"Execute a command only inside the pre-bound credential-free Quest Engineering Run SBX. No command executes in the Claude account cell.",
			inputSchema: {
				type: "object",
				properties: {
					command: { type: "string", minLength: 1, maxLength: 32_768 },
					timeoutMs: { type: "integer", minimum: 100, maximum: 30_000 },
				},
				required: ["command"],
				additionalProperties: false,
			},
		});
		await $.tool.register({
			name: "qe_complete_step",
			description:
				"Submit the declared structured outputs to the pre-bound Quest Engineering completion authority.",
			inputSchema: {
				type: "object",
				properties: { outputs: { type: "object" } },
				required: ["outputs"],
				additionalProperties: false,
			},
		});
		await $.tool.register({
			name: "qe_request_human_assistance_and_wait",
			description:
				"Create a durable Quest Engineering HumanAttention request and wait for its exact response without opening a local account-cell prompt.",
			inputSchema: {
				type: "object",
				properties: {
					category: {
						type: "string",
						enum: [
							"needs_input",
							"needs_permission",
							"needs_authentication",
							"needs_confirmation",
							"blocked_external",
							"interactive_prompt",
							"unknown_interactive_block",
						],
					},
					message: { type: "string", minLength: 1, maxLength: 16_384 },
					interaction: {
						type: "string",
						enum: [
							"confirmation",
							"text",
							"choice",
							"multiline_response",
							"conversational_intervention",
						],
					},
					responseSchema: { type: "object" },
				},
				required: ["category", "message"],
				additionalProperties: false,
			},
		});
		ready = true;
		return next(event);
	});

	on("command.run", () => ({
		text: "QE account-cell policy refused this local command.",
	})).catch(() => ({
		text: "QE account-cell command policy failed closed.",
	}));

	on("agent.offer", () => ({ isOffered: false })).catch(() => ({
		isOffered: false,
	}));

	on("agent.spawn", () => ({
		deny: "QE account-cell policy disables Claude subagents.",
	})).catch(() => ({
		deny: "QE account-cell subagent policy failed closed.",
	}));

	on("tool.call", async ($, event) => {
		if (!ready) return { deny: "QE account-cell Mod is not ready." };
		if (event.agentId)
			return { deny: "QE account-cell policy denies subagent tool calls." };
		if (!ALLOWED_TOOLS.has(event.tool))
			return {
				deny: `QE account-cell policy did not authorize ${event.tool}.`,
			};

		const input = object(event, "tool input");
		if (event.tool === TOOLS.attention) {
			const category = boundedString(input.category, "category", 64);
			const message = boundedString(input.message, "message", 16_384);
			const interaction =
				input.interaction === undefined
					? undefined
					: boundedString(input.interaction, "interaction", 64);
			const responseSchema =
				input.responseSchema === undefined
					? undefined
					: object(input.responseSchema, "responseSchema");
			if (responseSchema !== undefined)
				boundedJson(responseSchema, "responseSchema", 16_384);
			const result = await waitForHuman($, {
				type: "request_human_assistance_and_wait",
				category,
				message,
				...(interaction === undefined ? {} : { interaction }),
				...(responseSchema === undefined ? {} : { responseSchema }),
			});
			return { result: JSON.stringify(result) };
		}

		const result = await runBridge($, brokerOperation(event.tool, input));
		return { result: JSON.stringify(result) };
	}).catch((_$, event, next) => ({
		deny: `QE account-cell tool mediation failed closed for ${event.tool}: ${next.error.kind}.`,
	}));

	on("tool.check", async (_$, event, next) => {
		if (!ready || event.agentId || !ALLOWED_TOOLS.has(event.tool))
			return {
				decision: "deny",
				reason: "QE account-cell exact tool policy denied this call.",
			};
		const lower = await next(event);
		if (lower.decision === "deny") return lower;
		if (event.ceiling === "ask" || event.ceiling === "deny")
			return {
				decision: event.ceiling,
				reason: "QE preserved the managed policy ceiling.",
			};
		return {
			decision: "allow",
			reason: "QE allowed an exact pre-bound broker tool.",
		};
	}).catch(() => ({
		decision: "deny",
		reason: "QE account-cell permission mediation failed closed.",
	}));

	on("prompt.submit", async (_$, event, next) => {
		if (!ready)
			return {
				drop: "QE account-cell Mod is not ready; refusing the prompt.",
			};
		return next({
			...event,
			context: [
				...(event.context ?? []),
				"Quest Engineering account-cell contract: every filesystem, search, and shell operation must use the QE broker tools. No local account-cell coding tool exists. Never claim completion without calling qe_complete_step with exactly the declared output keys. Use qe_request_human_assistance_and_wait for human input.",
			],
		});
	}).catch(() => ({
		drop: "QE account-cell prompt mediation failed closed.",
	}));

	on("turn.step", async function* (_$, event, next) {
		if (
			!ready ||
			event.agentId !== undefined ||
			event.model !== expectedModel ||
			event.effort !== expectedEffort
		)
			return {
				turnId: event.turnId,
				index: event.index,
				answer: "",
				toolUses: [],
				stopReason: "refusal",
				usage: null,
			};
		const chunks = [];
		const downstream = next(event);
		let item = await downstream.next();
		while (item.done !== true) {
			chunks.push(item.value);
			item = await downstream.next();
		}
		if ((item.value.serverToolUses?.length ?? 0) > 0)
			return {
				turnId: event.turnId,
				index: event.index,
				answer: "",
				toolUses: [],
				serverToolUses: item.value.serverToolUses,
				stopReason: "refusal",
				usage: item.value.usage,
			};
		for (const chunk of chunks) yield chunk;
		return item.value;
	});
};
