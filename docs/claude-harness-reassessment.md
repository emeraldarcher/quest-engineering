# Claude harness reassessment: Claude Code Mods vs Agent SDK

**Decision date:** 2026-10-12

**Baseline:** `61771dfbbf1aacd823850bbe7323176fd4b81f7b` (`main == origin/main`)

**Decision:** **B — replace the production Claude Agent SDK adapter with headless Claude Code plus one QE Mod.**

This is a research decision, not an implementation. No production adapter or
immutable execution profile was changed. No Claude login, credential operation,
Agent SDK query, model turn, provider inference, Product prompt authorization,
or `qe_complete_step` call was performed.

## Evidence labels and source date

The report distinguishes evidence as follows:

- **[DOC]** current official Anthropic documentation, fetched 2026-10-12. The
  individual documentation pages do not display publication or last-updated
  dates, so the access date is the only honest page date.
- **[PIN]** the exact pinned runtime/package or declarations extracted from it.
- **[SRC]** the official `anthropics/claude-code` repository/tag.
- **[QE]** current QE source, tests, or Git history.
- **[PROTO]** the retained zero-inference Mod fixture.
- **[INF]** an architectural inference from the preceding evidence.
- **[REC]** a recommendation.

No community issue or experiment is used as decision evidence.

Primary official sources:

- Claude Code legal and compliance, authentication, settings, permissions,
  headless mode, CLI reference, sessions, model configuration, subagents, and
  plugin security pages. [DOC]
- Mods overview, creation, API, events, reference, testing, and organization
  administration pages. [DOC]
- Agent SDK overview and hosting pages. [DOC]
- Claude Code changelog and repository tags `v2.1.287` and `v2.1.292`. [SRC]
- The declarations embedded in the exact `2.1.292` executable. [PIN]

Exact source ledger (all documentation retrieved 2026-10-12):

| Subject | Source |
|---|---|
| Mods contract | `https://code.claude.com/docs/en/plugins/mods/{overview,create,api,events,reference,test,admin}` |
| Plugin security | `https://code.claude.com/docs/en/plugins/security` |
| CLI/runtime | `https://code.claude.com/docs/en/{headless,cli-reference,sessions,permissions,settings,settings-reference,model-config,sub-agents,authentication}` |
| Legal/policy | `https://code.claude.com/docs/en/legal-and-compliance` |
| Agent SDK | `https://code.claude.com/docs/en/agent-sdk/{overview,hosting}` |
| Public source/release | `https://github.com/anthropics/claude-code/tree/v2.1.292`, tag `fbe20e00e2851fc01506f54f98a8f0b875af3847`; Mods launch tag `v2.1.287`, `816ec211a648f17a411f63a45cfd44ddf8db00d9` |
| Authoritative extracted type contract | `.pi/tmp/claude-mods-reassessment/claude-code-v2.1.292-binary.d.ts` [PIN; ignored research artifact] |
| QE implementation/history | `workers/bun/src/harness-setup.ts`, `workers/bun/src/harnesses/claude-agent-sdk/`, `workers/bun/src/harnesses/control/`, `workers/bun/profiles/qe-coding-execution-v3/`, and commits cited in the failure table |

## Executive decision

Use this production shape:

```text
Product authorization + Worker authority
                 |
          Run-owned SBX
                 |
     pinned, unmodified Claude Code
      -p + stream-json + --restricted
                 +
    immutable organization-managed QE Mod
                 |
       lineage-private local control bridge
                 |
       HarnessControlAuthority
```

The Claude process should be started **only after the current Product inference
authorization**, live for that authorized prompt and its native tool loop, and
exit when that turn settles. A later QE continuation starts a new process with
`--resume <exact-session-id>` and re-passes all immutable flags and policy.
Claude Code's transcript is the native session store; it is not QE authority.

The Mod is analogous to Pi's native QE extension. It owns Claude-native semantic
interception, exact tool gating, `qe_complete_step`, model/effort request checks,
subagent denial, and native Stop enforcement. The Worker continues to own all
Run, Action, Attempt, lineage, nonce, stale-response, completion, and
HumanAttention authority.

This wins for three reasons:

1. Mods supply the deep structured engine surface that originally justified the
   Agent SDK, including capabilities the SDK wrapper does not expose as cleanly:
   pre-request `turn.step`, `tool.check` ceilings, registered tools, proactive
   tool calls, prompt composition, and direct process/socket calls. [PIN]
2. The official legal page expressly describes hosting the **unmodified Claude
   Code binary** for end users under stated conditions, while separately telling
   third-party developers building with the Agent SDK to use API-key billing
   rather than intermediate Claude.ai subscription credentials. A normal,
   unmodified Claude Code process with an official Mod is materially closer to
   the documented hosted-product model. It is not a legal guarantee. [DOC]
3. It removes the SDK package, QE SDK wrapper, and private wrapper protocol while
   retaining the generic SBX, streamed-process, control, completion, attention,
   private-Git, and lineage infrastructure. [QE][INF]

The one material gap is durable deferred HumanAttention. The Mod can hold a
custom tool call on a streaming local child indefinitely, but the existing QE
bridge can create an attention request only; it cannot return the eventual
structured human answer to that waiting child. The production replacement must
add one provider-neutral, generation-fenced `request_human_assistance_and_wait`
control operation before claiming parity. [PROTO]

## Exact pinned artifact and Mods provenance

| Item | Exact evidence |
|---|---|
| Agent SDK package | `@anthropic-ai/claude-agent-sdk@0.3.292` [QE] |
| Bundled Claude Code | `2.1.292 (Claude Code)` [PIN] |
| Runtime manifest source commit | `37832d0b7cad7b40bac7c82dff58629313913edf`, build `2026-10-06T05:43:35Z` [PIN] |
| Official public tag | `v2.1.292` at `fbe20e00e2851fc01506f54f98a8f0b875af3847`, authored `2026-10-06T18:59:09Z` [SRC] |
| Linux ARM64 SHA-256 | `24caa9e6ff13bf227049a2626f1c816fc895023050f0ec3b12dbf14d897367e0` [PIN] |
| Linux x64 SHA-256 | `a967e7b1d8b4e47ee421d5433027880347952b0c0857abf880e2c942a4ec93b3` [PIN] |
| Public Mods launch | Changelog `2.1.287`: “Added Claude Mods”; tag `816ec211a648f17a411f63a45cfd44ddf8db00d9`, `2026-10-01T17:59:57Z` [SRC] |
| Mods in pinned binary | Present and executable in `2.1.292` [PIN][PROTO] |

The admin documentation says Mods are on by default in `2.1.286` and later,
while the release changelog announces them in `2.1.287`. This report calls
`2.1.287` the public shipped release and does not infer more from the one-version
wording difference. [DOC][SRC]

The manifest source commit and public tag commit are different provenance
fields, not evidence that the binary is a different version: the package
manifest identifies the runtime build source, while the public tag points to a
later public repository snapshot. The public tag's checked-in declaration says
“Written by Claude Code 2.1.277” and is not byte-equivalent to the declarations
embedded in the `2.1.292` executable. Therefore the binary declarations are the
authority for this decision. [PIN][SRC]

Declaration SHA-256 values:

- binary-embedded declaration:
  `ec9fb8b86b52427c134e267749aa04ca84e419735e75810f5d2e5fa23f657ab3`
- public-tag declaration:
  `8ae1244d19d4b393261605fe72d517b66be0d7e1c214c378cdec5107e8b0b46c`

## Mods execution, packaging, state, and security

A Mod is a plugin with a `hooks/hooks.json` `modules` list pointing at a
JavaScript or TypeScript hooks module. Its `register(on)` function installs
middleware. Claude Code statically analyzes use of the `$` API, and `claude
plugin validate` reports hooks, calls, and literal environment reads. A module
runs in Claude Code's hooks worker, not in the model. [DOC][PIN]

Relevant runtime properties:

- Hooks form middleware. `next(e)` runs lower hooks/core; code before and after
  it provides pre- and post-observation. A hook may rewrite accepted fields,
  replace a result, deny/drop an operation, or call `next` again to retry where
  the event permits it. [DOC]
- Calls made through `$` traverse the same middleware chain while skipping only
  the calling hook frame. A proactive `$.tool.call` therefore still traverses
  other `tool.call` hooks, classic `PreToolUse`, permission resolution, and
  `tool.check`. [PIN]
- A hooks module has process/session memory. Reload resets module closure and
  timers and terminates children whose `process.spawn` streams are abandoned.
  `$.state` is session/UI state; `$.store` is plugin-namespaced durable storage.
  Neither is acceptable as QE identity or authorization authority. [DOC][PIN]
- `$.fs`, `$.process`, and `$.http` execute with the Claude Code user's access.
  Mods are expressly not sandboxed. The QE Mod must therefore run only in the
  Run-owned SBX, from immutable hashed bytes. [DOC]
- A repeatedly crashing hooks worker can unload installed Mods for the rest of
  the session. Exact CLI tool restriction and managed fallback denies must
  remain safe when the Mod is absent; the adapter must treat a missing/failed QE
  Mod as terminal, not continue optimistically. [DOC][REC]

Production must package the Mod as an immutable local organization marketplace,
not as an arbitrary repository plugin. The proposed v4 root is
`/opt/qe/claude-plugins`, with only `qe-control` as an installed organization
plugin; managed settings should enable it from that admin-owned directory,
identify it as an organization Mod, deny user Mods and hooks, disable sideload
flags, and pin the marketplace directory. Built-in Mods remain vendor code and
must be inventoried per pinned release; the probe observed `cc-plugin-agents-md`
and `cc-plugin-plugin-authoring`, in addition to the QE inline spike, and a
managed installation also loads the built-in guard. Disable unnecessary built-in
features through supported switches where permitted, but do not alter the
binary. The runtime must verify plugin name/path/version/hash and an empty
`plugin_errors` field from startup evidence. [DOC][PROTO][REC]

## Exact `2.1.292` engine event inventory

Legend: **pre** = before core; **rewrite** = accepted input fields can change;
**replace** = the core result can be replaced/refused; **post** = result can be
observed after `next`; **observe** = primarily lifecycle evidence; **stream** =
async-generator middleware. All entries below are from `EngineEventOf`. [PIN]

| Events | Capability |
|---|---|
| `tool.call` | pre, argument rewrite, deny/replace, retry, post-result observation |
| `tool.check` | pre-decision, replace verdict, post-decision; carries `agentId` and approval `ceiling` |
| `tool.describe` | rewrite/replace model-facing description and deferred status |
| `ui.render`, `ui.resolve` | replace/wrap UI tree or surface element table |
| `ui.press`, `ui.input`, `ui.select` | pre, rewrite input/value where typed, replace action |
| `ui.message` | intercept/rewrite/replace client-surface messages |
| `ui.fault` | observe a client-surface failure |
| `ui.scroll`, `ui.focus` | intercept/rewrite/replace navigation |
| `agent.offer` | hide/refuse an agent type before model offer/dispatch |
| `agent.spawn` | pre-spawn rewrite or deny, then observe resolved model |
| `prompt.submit` | pre-turn text/context rewrite or drop; includes exact `PromptOrigin` |
| `prompt.fill`, `prompt.suggest`, `prompt.edit`, `prompt.autocomplete` | intercept/rewrite/replace prompt-box behavior |
| `prompt.section`, `prompt.context`, `prompt.compose`, `prompt.attachment` | inspect/rewrite/replace model context and system-prompt composition |
| `prompt.mention` | intercept a mentioned-file read, redirect it, attach context, or deny |
| `command.run`, `command.describe` | intercept/rewrite/replace command execution/listing |
| `config.set`, `config.describe` | intercept/deny/rewrite config updates and descriptions |
| `telemetry.log`, `telemetry.mark` | intercept telemetry operations under their destination constraints |
| `skill.prompt` | inspect/rewrite/replace the prompt a skill contributes |
| `attribution.text` | inspect/rewrite attribution text |
| `session.start` | lifecycle observation and setup calls; cannot rewrite session cwd by returning another value |
| `session.receive`, `session.send` | intercept/rewrite/consume inter-session messages |
| `session.append` | inspect/rewrite a transcript row before storage |
| `session.compact` | intercept/rewrite compaction behavior/context where typed |
| `session.attach`, `session.detach` | observe/intercept surface attachment lifecycle |
| `session.measure` | intercept/replace session measurement |
| `session.end` | terminal lifecycle observation/interception |
| `plugin.register` | inspect or refuse another Mod before it loads |
| `turn.start` | exact main-turn lifecycle observation |
| `turn.step` | **stream**; pre-provider model/effort rewrite or refusal and streamed response/result replacement |
| `turn.complete` | post-turn answer/reason/usage observation and display-result replacement |
| `engine.create` | wrap/replace engine construction and add or withhold declared API nouns |

Count: **46** engine events.

`turn.step` is especially important. Its input is raised at the moment an
individual model request is about to be sent and contains resolved `model`,
`effort`, `turnId`, step index, message count, and optional `agentId`. Its result
contains visible answer, engine tool uses, `serverToolUses`, stop reason, and
usage with the responding model. A Mod can refuse to call `next`, so a mismatched
request need not reach the provider. [PIN]

## Exact callable `$` API inventory

The following are the **61 host operation events in `OpEventOf`**. Each is
directly callable by the Mod and is middleware-visible (except that the calling
hook frame is skipped). [PIN]

| Namespace | Exact operations |
|---|---|
| Model/audio | `model.complete`, `model.classify`, `model.fork`, `audio.play`, `audio.speak` |
| MCP | `mcp.call`, `mcp.connect` |
| Session | `session.cwd`, `session.root`, `session.model`, `session.turns`, `session.id`, `session.messages`, `session.repo`, `session.surface`, `session.surfaces`, `session.authorize`, `session.usage`, `session.version` |
| Turn/prompt | `turn.abort`, `prompt.read` |
| Tools | `tool.list`, `tool.register` |
| Commands/config | `command.list`, `command.register`, `config.list` |
| Agents | `agent.list`, `agent.register` |
| UI | `ui.toast`, `ui.status`, `ui.log`, `ui.notice`, `ui.invalidate`, `ui.open`, `ui.close`, `ui.panes`, `ui.selection`, `ui.copy`, `ui.blit` |
| Files | `fs.read`, `fs.write`, `fs.list`, `fs.exists`, `fs.stat`, `fs.ancestors` |
| Durable/session state | `store.get`, `store.set`, `store.delete`, `store.keys`, `state.get`, `state.set` |
| Clock | `clock.now`, `clock.sleep`, `clock.after`, `clock.every` |
| Network/process | `http.fetch`, `process.run`, `process.spawn` |
| Configuration/environment | `settings.read`, `env.get`, `env.set` |

Count: **61** host operation events.

The callable `$` interface additionally raises engine events through
`session.compact`, `session.send`, `session.append`, `prompt.submit`,
`prompt.fill`, `prompt.suggest`, `prompt.compose`, `tool.call`, `tool.check`,
`command.run`, `config.set`, `agent.spawn`, `ui.scroll`, and `ui.focus`.
`ui.ask` is a convenience API implemented through the native
`AskUserQuestion` tool path. These calls are not duplicate `OpEventOf` entries;
they traverse the corresponding engine-event middleware. Together with the 61
host operations, this is the complete QE-relevant callable surface. [PIN]

`process.spawn` is a streaming operation in the binary declarations, alongside
`turn.step`. The public-tag declaration predates this addition, which is a
concrete reason not to substitute repository types for binary types. The QE Mod
must statically contain no `$.model.*` call and no `$.session.authorize` call:
the former could initiate inference and the latter exposes an opaque first-party
credential handle for authenticated HTTP. [PIN][REC]

## Classic hook inventory

The Mod can also handle all **33** settings-hook events through `classic.<name>`:

`ConfigChange`, `CwdChanged`, `DirectoryAdded`, `Elicitation`,
`ElicitationResult`, `FileChanged`, `InstructionsLoaded`, `MessageDisplay`,
`Notification`, `PermissionDenied`, `PermissionRequest`, `PostCompact`,
`PostModelSwitch`, `PostToolBatch`, `PostToolUseFailure`, `PostToolUse`,
`PreCompact`, `PreModelSwitch`, `PreToolUse`, `SessionEnd`, `SessionStart`,
`Setup`, `StopFailure`, `Stop`, `SubagentStart`, `SubagentStop`,
`TaskCompleted`, `TaskCreated`, `TeammateIdle`, `UserPromptExpansion`,
`UserPromptSubmit`, `WorktreeCreate`, and `WorktreeRemove`. [PIN]

For QE, `PreToolUse`, `PermissionRequest`, `Stop`, `StopFailure`, model-switch,
subagent, elicitation, and lifecycle events are the relevant subset. A Mod's
normalized classic Stop result uses `{ block: reason }`; the underlying command
hook JSON uses `decision: "block"`. [PIN][PROTO]

## “Force tool call” answer

The exact answer is **yes**, with distinctions:

- `$.tool.register(spec)` declares a custom tool from `session.start`. The tool
  appears as `mcp__<plugin>__<name>`. A `tool.call` hook serves its result. [PIN]
- `$.tool.call({ tool, ...input })` proactively calls a currently exposed
  built-in, MCP, or registered tool without waiting for the model to request it.
  It traverses the remaining tool and permission pipeline. [PIN]
- `$.agent.spawn(...)` proactively starts a subagent; `$.agent.register(...)`
  defines one. Calling the exposed Agent tool through `$.tool.call` is also a
  tool call, but `$.agent.spawn` is the direct API. [PIN]
- `$.prompt.submit({ text, asUser? })` queues a normal turn when the session is
  idle. Without `asUser`, the transcript/model receives plugin attribution. It
  fires the normal prompt and turn hooks; the calling prompt hook frame is
  skipped to prevent direct recursion. [PIN]
- `prompt.submit`, `prompt.context`, `prompt.section`, `prompt.compose`, and
  attachments provide typed prompt injection/interception. [PIN]
- The `tool` name in an existing `tool.call` is pinned. A Mod cannot rename it
  by mutating the envelope. It can deny/answer the original, proactively call a
  different tool, and map that result back, which is an explicit reroute rather
  than a name rewrite. [PIN]
- A Mod can replace a tool result or, after a failed `next(e)`, call `next(e)`
  again to retry. A denial after execution withholds the result but cannot undo
  the side effect. [DOC]

This is materially Pi-like extension power, not merely shell-hook wrapping.

## Pi parity

| Capability | Claude Code + QE Mod vs Pi native extension |
|---|---|
| Native lifecycle | Equal for session/prompt/turn/tool lifecycle; Claude exposes deeper model-step middleware |
| Tool registration | Equal; Mod tool names are MCP-shaped on the wire |
| Proactive tool invocation | Equal/stronger: `$.tool.call`, `$.mcp.call`, and `$.agent.spawn` are direct |
| Pre-tool authorization | Equal with different semantics: `tool.call`, `tool.check`, classic/managed hooks, and ceilings |
| Post-tool interception | Equal: result observe/rewrite/withhold/retry |
| Prompt interception/injection | Equal/stronger: typed composition sections plus submit/context hooks |
| Native session identity | Equivalent: `$.session.id()` plus CLI `system/init.session_id` |
| Model identity | Stronger pre-request visibility through each `turn.step`; response usage also reports model |
| HumanAttention | Weaker until QE adds a durable wait/response bridge operation |
| Structured completion | Equal with a registered tool and existing authority bridge |
| Stop interception | Equal with `classic.Stop`; `turn.complete` adds structured reason/usage |
| Usage | Equivalent/stronger: step/turn/session usage plus stream-json result/model totals |
| Cancellation | Slightly weaker host API than Pi/SDK; SIGINT works and `$.turn.abort` exists inside the Mod |
| Continuation | Equivalent with exact session ID and native transcript resume |
| Sandbox | Same architectural requirement; a Mod is not a sandbox |

Overall: **near parity, with richer Claude-native model events and one deferred
HumanAttention gap**.

## Tool policy and policy precedence

### Ordering

Settings precedence is managed policy, command-line settings, local project
settings, shared project settings, then user settings. `--restricted` loads only
managed settings and explicit `--settings`, confines native file tools, removes
command/code and WebFetch tools unless explicitly named, and refuses bypass
permissions. [DOC]

Mod middleware tiers run outermost to innermost as the built-in guard and
organization `prepend` Mods, user Mods, organization `append` Mods, other
built-ins, then core. Managed `PreToolUse` hooks run before any Mod and their
block is final. Other classic hooks run below Mods. The built-in guard prevents
a user Mod from weakening deny rules or managed hooks unless an administrator
explicitly opts out. [DOC]

`tool.check.e.ceiling` is pinned. The QE Mod should preserve an `ask` or `deny`
ceiling and should never upgrade a lower managed deny. Some inherently
interactive tools cannot have their dialog dismissed by a Mod's `allow` anyway.
[PIN][REC]

### Production enforcement

QE can continue to classify its **native tool-name profile** as `Exact`, subject
to the same meaning it has today: exact exposed tool names, not semantic parsing
of every possible Bash compound command. [INF]

Use all of these layers:

1. `--restricted` and an exact `--tools` list.
2. `--permission-mode dontAsk` and `--permission-prompts none`.
3. Managed deny rules/fallback `PreToolUse` policy.
4. `allowManagedModsOnly`, `allowManagedHooksOnly` as appropriate,
   `disableSideloadFlags`, and an immutable local organization marketplace.
5. QE Mod `tool.call` fail-closed allowlist, subagent denial, and custom tool
   implementation.
6. QE Mod `tool.check` that preserves managed deny/ceiling and upgrades only an
   exact QE-authorized ordinary ask.
7. The outer Run-owned SBX filesystem and egress boundary.
8. Adapter validation of `system/init.tools`, plugins, plugin errors, model,
   permission mode, runtime version, and Mod probe result before the real prompt.

A user/repository Mod must not load. A pinned QE Mod's own `$.process` and
`$.fs` calls bypass native tool permission rules, so static validation, hash
pinning, and the SBX are authoritative for those calls. [DOC]

`turn.step.serverToolUses` strengthens auditing because it reports tools the API
ran within the provider request. Those calls do **not** traverse `tool.check`,
`tool.call`, or classic hooks and can only be observed after execution. QE must
not label observation as pre-enforcement. Disable such features where possible
and fail the Attempt on an unauthorized server tool use. [PIN][REC]

Initial production policy should deny all Claude subagents. `agent.offer` should
return false, `agent.spawn` should deny fail-closed, Agent/Task tools should be
absent from `--tools`, and any tool call with `agentId` should be denied. Claude
subagents are harness-internal behavior, not QE Squad Members. They may be added
later only as an explicit resolved tool capability with separate usage and
attention semantics. [REC]

## Structured completion

The cleanest path is:

```text
model requests mcp__qe-control__qe_complete_step({ outputs })
  -> QE Mod tool.call handler
  -> $.process.run([QE_BRIDGE, "local-control"], bounded JSON stdin)
  -> HarnessControlClient / HarnessControlAuthority
  -> immediate semantic acceptance
  -> tool result to model
  -> asynchronous private-Git export remains Worker-owned
```

No identity, nonce, Worker, Run, Action, Attempt, or lineage is present in the
tool schema. The bridge inherits a lineage-private opaque descriptor from the
Worker, and the authority validates current generation and binding. This reuses
the current generic control plane and is narrower than adding an MCP server
solely to cross one local trust boundary. [QE][PROTO][REC]

The Mod should also own `classic.Stop`: call the existing native-stop control
operation and return `{ block: reason }` for a corrective continuation. A
managed classic Stop hook can remain as a fail-safe if the installed Mod fails.
[PROTO][REC]

## HumanAttention

Mods can observe or mediate:

- permission decisions through `tool.check`, `PermissionRequest`, and
  `PermissionDenied`;
- model questions through `AskUserQuestion` `tool.call` when that tool is
  exposed;
- MCP elicitation through `classic.Elicitation`/`ElicitationResult`;
- UI question rendering in interactive mode;
- subagent identity through `agentId` and agent events;
- notification and wait-related classic/session events. [PIN]

`$.ui.ask` is not the QE answer: it rejects in `-p` when no local person is
present and has no durable Product response channel. `--permission-prompts none`
also removes native person-required tools that no hook resolves. [DOC]

The recommended model is one explicit registered
`qe_request_human_assistance` tool. Its handler sends a bounded, identity-free
request through the local control authority and holds the native tool call while
a bridge child waits. `$.process.spawn` has streaming child-lifetime semantics:
the child remains alive while the Mod consumes its stream, and time spent in
Mods API calls does not consume ordinary hook CPU budget. [PIN]

The current bridge does not yet support the return half. Production needs a
generic operation with these semantics:

1. atomically create/idempotently recover a current HumanAttention request;
2. keep a lineage-private request pending without a fixed ten-minute
   `process.run` ceiling;
3. accept a Product response only for the exact attention/generation/binding;
4. return the bounded structured response to the waiting child;
5. cancel and mark stale on turn/process/Run loss;
6. never accept model-supplied QE identity;
7. make duplicate response handling explicit.

The retained fixture names this proposed operation
`request_human_assistance_and_wait` and transport mode `local-control-wait`.
They do not exist in production. [PROTO]

Deferred HumanAttention is durable in QE authority, but the **native wait is not
recoverable merely because the authority is durable**. If Claude Code or the
Mod process dies mid-question, its tool-call promise dies. QE must retain the
attention record, reject stale replies, and recover through an explicit resumed
turn rather than silently replay the old tool call. This is weaker than the
Agent SDK's direct callback ergonomics, though an SDK subprocess loss also needs
recovery. [INF]

## Mod-to-Worker transport and state authority

Use the existing loopback descriptor and bridge CLI for the first production
version. A Unix-domain HTTP socket is also supported by `$.http.fetch` through
`socketPath` and is a reasonable later simplification, but it does not justify a
new protocol before the existing bridge proves insufficient. MCP is not needed
for this local authority boundary. [PIN][QE][REC]

The Mod may cache only non-authoritative session-local data: expected
model/effort/tool names, last turn reason, and current bridge path. Authoritative
identity remains behind the opaque descriptor. Do not put credentials, Run
identity, result nonce, or authorization state in `$.store`. [REC]

## Headless, interactive, and prompt submission

### Headless support proved without inference

The exact binary loaded the fixture in all of these zero-inference paths:

- `claude plugin validate`: static validation passed for the TypeScript module.
- strict TypeScript check against generated `2.1.292` types: passed.
- `claude plugin test`: **10 passed, 0 failed** with mocked events and operations.
- `--init-only --plugin-dir ...`: exit 0, no conversation.
- `-p /qe_mod_probe`: local command result, `num_turns: 0`,
  `total_cost_usd: 0`, empty `modelUsage`, and no permission denials.
- `--resume <session-id> -p /qe_mod_probe`: same exact session ID, still zero
  turns/cost/model usage.
- One long-lived `--input-format stream-json` process accepted two probe
  messages and returned two local-command results under the same session ID,
  each with zero turns/cost/model usage.
- With exact `--model` and `--tools`, `system/init` reported Claude Code
  `2.1.292`, model `claude-opus-4-6`, exactly `Bash`, `Edit`, `Read`, and the two
  QE tools, the QE plugin at the expected path, `plugin_errors: null`, and
  `permissionMode: dontAsk`.

The local probe is a slash command, not a model prompt. No credential was
present and no provider request occurred. [PROTO]

### Recommended prompt mechanism

Use one streamed headless process per Product-authorized prompt:

1. Persist Product inference authorization and prompt intent.
2. Spawn pinned Claude Code with no literal model prompt, using `-p`,
   `--input-format stream-json`, `--output-format stream-json`, `--verbose`,
   `--replay-user-messages`, `--restricted`, exact model/effort/tools, exact
   settings, and the required managed QE Mod.
3. Send `/qe_mod_probe` as the first stream message. It is a local command and
   starts no model turn. Validate `system/init`, replay acknowledgment, exact
   session/model/tools/plugin evidence, and the zero-turn probe result.
4. Persist the real message's submission intent immediately before one write.
5. Send one UUID-bearing user message and require its replay acknowledgment.
6. Consume structured output until completion or an authorized interrupt.

This starts the Claude process only **after** inference authorization but still
verifies the exact in-process Mod before sending model input. It is cleaner than
using `$.prompt.submit` as the host ingress and gives explicit stdin message
acknowledgment. `$.prompt.submit` remains useful for native Stop corrections or
future local control, not as the primary Product submission path. [PROTO][REC]

At `needs_confirmation`, only the SBX, private Git, credential context,
configuration, Mod bytes, and local authority exist. No Claude process or model
query needs to exist. [REC]

Do not use `--bare` for subscription-backed execution: current headless
documentation says bare mode does not read OAuth login credentials or
`CLAUDE_CODE_OAUTH_TOKEN`. Use `--restricted` instead. [DOC]

### Interactive candidate

Mods work in interactive sessions too and gain real UI surfaces and native
questions. That does not justify Herdr for ordinary QE execution. A live TUI
adds PTY lifecycle, focus/readiness, unauthorized keyboard-input risk, takeover
state, and dual Product/native control without adding semantic evidence the Mod
already supplies. It is useful only if native observation/takeover is a product
requirement strong enough to pay that cost. It is not today. [INF]

Herdr should remain exactly an optional `TerminalSessionBackend` implementation,
used by harnesses such as Antigravity that need a terminal surface. Do not make
it Claude infrastructure and do not remove it. [REC]

## Sessions, continuation, recovery, and cancellation

Claude Code continuously writes project-bound JSONL transcripts. `system/init`
and final results expose session ID; the Mod independently exposes
`$.session.id()`. QE should compare and persist this as `NativeSessionRef` bound
to the PhysicalLineage. [DOC][PIN]

- Fresh turn: assign or capture one exact UUID and persist it.
- Same-lineage continuation: spawn after authorization with `--resume` and the
  exact ID; re-pass every policy/plugin/model/effort/tool flag.
- Worker restart with retained SBX: inspect the native transcript/session and
  current authority, then resume only under normal side-effect certainty rules.
- Claude process restart: supported by native resume; module closure is rebuilt,
  so no Mod memory is authority.
- Replacement SBX: only resume if the exact transcript is deliberately restored
  and the new PhysicalLineage policy permits it; otherwise start a new session.
- In-flight ambiguous prompt/process loss: never auto-replay. Resume with an
  explicit recovery message only after QE decides the prior side effect state.

The zero-inference probe demonstrated same-ID resume across separate processes.
It did not prove model-turn recovery and makes no such claim. [PROTO]

For cancellation, first send SIGINT to end the current headless turn, wait for
structured terminal evidence, and use the generic process cancellation/teardown
path if it does not settle. Official docs distinguish SIGINT (end the turn) from
SIGTERM (exit 143 with no result). A future persistent Mod control stream may
call `$.turn.abort`, but it is not required for the initial design. [DOC][REC]

## Model, effort, usage, and provider-side tools

Pass a full exact model ID with `--model`, an exact level with `--effort`, and no
fallback chain. On every `turn.step`, the Mod must compare the resolved request's
`model` and `effort` before calling `next`; mismatch means no provider request.
The retained fixture proves a mismatch does not reach the mocked lower request.
After the response, compare `usage.model`; if it differs, withhold tool uses and
fail the Attempt. [PIN][PROTO]

Every fallback request creates another `turn.step`, so a different fallback
model can be blocked before that request. This is stronger than detecting a
fallback only after an SDK result. [PIN][INF]

Exact effort has one caveat: the request event attests the resolved client
request, but response usage has no independent effort field. QE can enforce the
outbound level under its closed plugin/settings inventory; it cannot claim the
provider echoed that effort. Organization effort caps may clamp a requested
level, so a mismatch must fail rather than be silently rewritten. [DOC][PIN]

Usage is available at step, turn, and `session.usage()` levels and in final
stream-json results (`usage`, `modelUsage`, and estimated cost). Cost is an
estimate, not a billing record. `serverToolUses` adds post-execution visibility,
not preauthorization. [DOC][PIN]

## Authentication is a separate architecture

Changing adapters does **not** change the underlying login command, credential
format, credential precedence, or official Claude Code flow. Agent SDK, plain
headless Claude Code, and Claude Code plus a Mod all ultimately use Claude Code
authentication. [DOC][QE]

The current Run + PhysicalLineage-private `CLAUDE_CONFIG_DIR` is over-isolated
for a desktop product: it turns every new context into another provider login
without adding meaningful protection against a model already running inside
that context. It also couples auth setup to Run scheduling and multiplies the
chance of onboarding failure. [INF]

### Credential-scope decision

Choose **C: a local QE user/provider account credential context outside
individual Runs, exposed through a controlled SBX credential boundary**. [REC]

Properties:

- one context per local QE user and provider/account/method;
- created and updated only by the unmodified provider CLI and its official
  sign-in flow;
- stored in local Worker-owned protected state, never Product/PostgreSQL, Git,
  workspace, logs, Mod storage, or protocol payloads;
- attached only to an authorized Run SBX;
- provider-managed credential files remain opaque to QE;
- Run-private `projects/`/transcripts and auto-memory remain separate from the
  account context, even though Claude Code normally puts both under
  `CLAUDE_CONFIG_DIR`;
- native sandbox/managed deny rules make credential paths unreadable to model
  tools, with the outer SBX as defense in depth;
- revocation uses the official logout/revocation flow and invalidates all
  attached generations;
- future multi-user installations namespace contexts by QE user and never share
  them;
- concurrent refresh/write behavior must be proved before allowing concurrent
  attachments.

A practical design is a protected account context mounted at the expected
Claude config location, with Run-private overlays for transcript/project state.
This needs a dedicated spike because Claude Code may update more than one
provider-owned metadata file. Do not copy host `~/.claude` state, do not inspect
credential contents, and do not use Product as a secret store. [REC]

This scope removes repeated login-per-Run. Claude Code plus a Mod does not do so
by itself. Run-bound setup remains valuable generic infrastructure and may
coordinate attachment/readiness, but Claude authentication becomes account
setup rather than inference authorization. [REC]

### Authentication and billing policy as of 2026-10-12

The official legal page, accessed 2026-10-12 and showing no page update date,
says: [DOC]

- hosted products may preinstall/run **unmodified Claude Code** under applicable
  terms;
- they may not remove, disable, or restrict built-in authentication methods;
- each end user must use their own subscription, API key, or supported
  third-party provider credential and be billed directly;
- the host may not pay for, resell, or intermediate inference;
- OAuth is for ordinary use of Claude Code and other native Anthropic apps;
- developers building products, expressly including Agent SDK products, should
  use API keys/cloud providers and may not offer or intermediate Claude.ai login
  in their own applications;
- an end user may sign in to the unmodified hosted Claude Code binary under the
  hosted-product conditions.

Classification:

| Mechanism | Current policy classification | Durability assessment |
|---|---|---|
| Agent SDK + user subscription in QE | **Ambiguous/discouraged for a third-party product**; ordinary individual Agent SDK usage is mentioned, but the specific developer-auth rule points products to API billing | Low for QE's subscription requirement |
| Agent SDK + end-user API key/cloud credential | Explicitly supported subject to normal terms | High |
| Unmodified `claude -p` + end-user credential/direct billing | Supported with explicit hosted-product conditions | High |
| Unmodified Claude Code + official local Mod | Supported with the same hosted-product conditions; Mod is an official plugin surface | High, though Mods API itself is new |
| Interactive unmodified Claude Code + Mod | Same hosted-product conditions | High |

QE must retain every built-in authentication method in the binary and must not
use managed policy to disable alternatives. It may validate which end-user-owned
method is selected for a particular configured account and prevent accidental
billing fallback, but the replacement design should not present a modified or
method-stripped Claude Code. Contact Anthropic before a hosted or multi-user
release; this report is architecture analysis, not legal advice. [DOC][REC]

Relative to the SDK wrapper, the Mod design materially reduces policy risk
because the product is the documented unmodified hosted binary plus its official
extension mechanism. It does not eliminate terms, billing, or credential-handling
obligations. [INF]

## Latest historical login exit-1 analysis

No retry or credential inspection was performed.

The safe conclusions are:

1. The login process **definitely started**. `beginSetup()` awaits
   `spawnStreamed()`, whose return follows relay process-identity
   acknowledgement, before the coordinator persists
   `invocation_acknowledged`. [QE]
2. Exactly one response was accepted by QE's streamed process write path. That
   proves transport acceptance, not that Claude Code or Anthropic accepted the
   code or completed login. [given historical evidence]
3. The child then definitely exited with status 1. [given historical evidence]
4. Setup output was bounded, sanitized, ephemeral, and intentionally not
   retained. There is no durable vendor message from which to infer the reason,
   and this report does not inspect credential files. The only safe retained
   vendor result is nonzero process exit. [QE]
5. `beginSetup()` runs the pinned Claude Code `auth login` executable directly;
   the Agent SDK and `query()` are not in this setup path. Therefore the exit
   happened in the Claude Code login/transport path, not in Agent SDK model
   execution. A direct Claude Code + Mod architecture using the same login flow
   could see the same exit. [QE]
6. The root cause of exit 1 is unknown. It could be provider rejection, CLI
   behavior, input/transport behavior, or another login failure; “likely vendor
   failure” is not proven. [INF]
7. QE's **classification is definitely wrong**. A nonzero exit is converted to
   a failed inspection with `authState=inspection_unavailable`; the coordinator
   then applies the preflight text “could not be inspected; login was not
   invoked,” even though invocation was acknowledged. The durable invocation
   state itself is `settled`, but the human-facing reason contradicts history.
   [QE]
8. The terminal setup and one-time response remain non-replayable. The proposed
   post-login classification fix should not be implemented in the losing SDK
   adapter. Equivalent correct classification belongs in the new generic
   account-setup/CLI adapter. [REC]

## Historical failure classification

| Defect | Layer/root cause | Fixed? | SDK-specific? | Removed by Mod? | Removed by account credential scope? |
|---|---|---:|---:|---:|---:|
| Product harness identifier grammar | Product validation accepted only key grammar, rejecting canonical `claude_agent_sdk`; `3e7bf1d` | Yes | No | No | No |
| Work Yard setup capability guard | Client rejected Product-authorized setup when a semantic attempt already existed; `f115df5` | Yes | No | No | No |
| SBX JSON version/update framing | Generic SBX client parsed a valid version/update response too narrowly; `ffc49db` | Yes | No | No | No |
| Setup ToolPolicy discriminator loss | Product encoded a struct without required `kind`; `9fe7cc6` | Yes | No | No | No |
| SDK query constructed before Product inference authorization | Wrapper/adapter used `query()` as initialization, crossing the intended boundary; `ee91810` | Yes | **Yes** | **Yes** | No |
| Retained SDK pre-query gates not restored | Recovery could lose immutable pre-query evidence; `ac7a0bb` | Yes | **Yes** | **Yes** | No |
| Immutable execution profile mutation pressure | Remediation initially touched a frozen profile rather than introducing v3; `1d9dec8` | Yes | No, governance | No; v4 still required | No |
| `ANTHROPIC_API_KEY=none` selected API-key mode | SBX inherited a selector whose presence changes Claude Code auth precedence; `8278252` | Yes | No, Claude runtime/env | No | Reduces frequency, not cause |
| Setup streamed-launch cwd | Caller passed lineage worktree while generic lease authorized canonical setup cwd; `56d4034` | Yes | No | No | Setup path changes, invariant remains |
| Latest post-login exit/classification | Real CLI exited 1 after acknowledged invocation; adapter mapped failed post-invocation inspection to “login not invoked” | No; terminal history retained | No for exit; current mapping is adapter-specific | No for exit; classification reimplemented correctly | Fewer login events, not cause |

Among the mandated failures, the Mod architecture actually removes **two
incidents**, both from the same SDK pre-query lifecycle: query-before-authorization
and retained pre-query-gate recovery. It does not make Claude login disappear.
The account-level credential context reduces how often login is needed but does
not retroactively fix any listed root cause. [INF]

## Candidate architectures

### A. Current Agent SDK

```text
Worker -> SBX -> QE wrapper -> Agent SDK -> Claude Code subprocess
                    |             |
             QE JSONL protocol   callbacks/MCP
```

**Strengths:** mature typed result/control protocol, initialization result,
streaming input, interrupt receipts, direct `canUseTool` callbacks, convenient
deferred questions, SessionStore option, rich usage, and in-process custom MCP.

**Weaknesses:** another package and wrapper protocol around a subprocess that is
already Claude Code; duplicated lifecycle; SDK-specific query state; tighter
runtime/package coupling; and materially worse policy alignment for QE's desired
subscription-backed third-party use.

### B. Headless Claude Code + QE Mod — winner

```text
Worker -> SBX -> unmodified claude -p/stream-json
                         + QE Mod
                         -> local control bridge
```

**Strengths:** deepest native event surface, proactive tool/prompt APIs, exact
pre-request model/effort evidence, no SDK wrapper/protocol, official plugin model,
headless structured output, native resume, no Herdr, and better hosted-product
alignment.

**Weaknesses:** new Mod API, installed-Mod crash behavior, unsafe if plugin policy
is open, no ready-made durable Product callback, and CLI cancellation/input
protocol is less ergonomic than SDK control methods.

### C. Interactive Claude Code + QE Mod + Herdr

```text
Worker -> TerminalSessionBackend/Herdr -> Claude TUI + QE Mod -> control bridge
```

It has the same semantic power plus native observation/takeover, but adds PTY,
focus, input authority, and dual-control complexity. It is justified only by a
future explicit native-TUI product requirement, not by harness correctness.

### D. Plain headless Claude Code

```text
Worker -> SBX -> claude -p/stream-json + MCP/settings hooks
```

This is operationally simple and policy-aligned, but loses pre-request
`turn.step`, proactive native calls, deep prompt/session interception,
agent-aware permission evidence, and clean native tool registration. Rebuilding
those properties from stream-json, MCP, and shell hooks would recreate a weaker
adapter. It is a good fallback if Mods are withdrawn, not the preferred design.

Deferring Claude is unnecessary: candidate B has a validated zero-inference path
and one bounded generic bridge gap rather than a fundamental blocker.

## Complexity and 1–2 year maintenance

| Candidate | Main production concepts | Complexity | Maintenance sensitivity |
|---|---|---|---|
| Agent SDK | adapter, QE wrapper, SDK package, bundled CLI, wrapper JSONL, SDK controls/callbacks, MCP tool, bridge, auth setup | Highest headless stack | SDK API + wrapper protocol + child CLI + subscription SDK policy |
| Headless Mod | adapter, CLI stream-json, one Mod, managed plugin policy, bridge, auth setup | Moderate; one vendor process and one QE extension | Mod API and CLI version; reduced package/protocol layering |
| Interactive Mod | headless-Mod concepts plus PTY, Herdr, TUI readiness/focus/takeover | Highest overall | Mod/CLI plus TUI rendering and terminal lifecycle |
| Plain headless | adapter, CLI stream-json, MCP/classic hooks, bridge, auth setup | Lowest initial, compensating state grows | CLI output/session schemas; lacks semantic interception |

Expected maintenance ranking, best to worst: **headless Mod**, plain headless,
Agent SDK, interactive Mod. Plain headless ranks second only if its weaker
semantics are accepted; reproducing Mod guarantees would erase its simplicity.

## Scorecard

Scores are 1 (poor) through 5 (best). “Maintenance burden” is reverse-scored:
5 means the lowest expected burden.

| Criterion | Agent SDK | Headless Mod | Interactive Mod | Plain headless |
|---|---:|---:|---:|---:|
| Native subscription alignment | 2 | 5 | 5 | 5 |
| Policy durability | 2 | 5 | 5 | 5 |
| Architecture simplicity | 2 | 4 | 2 | 5 |
| Auth simplicity | 3 | 3 | 3 | 3 |
| QE/Pi-like extension power | 4 | 5 | 5 | 2 |
| Event richness | 5 | 5 | 5 | 3 |
| Exact tool enforcement | 4 | 5 | 5 | 3 |
| Proactive tool control | 3 | 5 | 5 | 2 |
| Prompt control | 5 | 5 | 4 | 3 |
| HumanAttention | 5 | 3 | 4 | 2 |
| Structured completion | 5 | 5 | 5 | 4 |
| Session continuity | 5 | 4 | 4 | 4 |
| Restart recovery | 4 | 4 | 3 | 4 |
| Cancellation | 5 | 4 | 4 | 3 |
| Usage/observability | 5 | 5 | 5 | 4 |
| Exact model attestation | 5 | 5 | 5 | 4 |
| Exact effort attestation | 4 | 4 | 4 | 3 |
| SBX fit | 4 | 5 | 4 | 5 |
| Herdr independence | 5 | 5 | 1 | 5 |
| Human observation/takeover | 2 | 2 | 5 | 2 |
| Maintenance burden | 2 | 4 | 2 | 4 |
| **Total / 105** | **81** | **92** | **85** | **75** |

HumanAttention prevents a perfect headless-Mod score. It is a required
implementation gate, not a reason to retain the entire SDK stack.

## Greenfield replacement plan

### Retain

Retain these generic assets unchanged in architectural role:

- SBX per-Run isolation and full Run teardown;
- `ExecutionEnvironmentBackend` and streamed-process primitives;
- private Git, PhysicalLineage, immutable profile provenance, and workspace
  lifecycle;
- Product setup vs inference authorization separation;
- `HarnessControlAuthority`, result envelopes, asynchronous export, native Stop,
  and structured completion;
- generic HumanAttention state and stale-response fencing;
- generic headless `AgentHarness` seam and protocol event normalization;
- setup side-effect certainty and cancellation semantics.

Historical docs, commits, tests, and v1/v2/v3 profiles remain in Git as evidence.
Do not rewrite or delete that history.

### Replace/delete from production

After parity is accepted, remove rather than support in parallel:

- the `@anthropic-ai/claude-agent-sdk` production dependency;
- the immutable wrapper from the new active profile (v3 stays untouched);
- SDK wrapper client/binding/protocol code used only by
  `claude_agent_sdk_stream_v2`;
- SDK `query()` startup/turn state and SDK-specific custom MCP plumbing;
- SDK-specific adapter registration and tests, replacing them with Mod/CLI
  equivalents.

Extract and retain any generic auth-status, process-certainty, prompt-building,
control, and session-binding logic rather than deleting it with the SDK folder.
Keep `docs/claude-agent-sdk*.md` as superseded historical decision/acceptance
evidence or add a supersession note; do not erase it.

### New immutable profile

Create **`qe-coding-execution-v4`**. Never mutate v3. V4 should contain:

- the exact reviewed unmodified Claude Code binary for each architecture;
- an immutable local organization marketplace with the hashed QE Mod;
- managed plugin/tool fallback policy without disabling built-in authentication
  methods;
- no Agent SDK package and no QE SDK wrapper;
- the generic bridge CLI and protected account-context attachment support;
- private Run transcript/project state and disabled auto-memory;
- static provenance for binary, Mod, settings, and bridge bytes.

### Implementation sequence

1. Approve this architecture and obtain a policy/legal sign-off for the intended
   local/hosted distribution model.
2. Specify and test the provider-neutral
   `request_human_assistance_and_wait` authority operation, cancellation, stale
   replies, and process-loss behavior.
3. Spike the account-level provider context and Run-private transcript overlay
   without reading credential content; prove refresh, revocation, concurrency,
   and model-tool path denial.
4. Promote the fixture into a production QE Mod with generated exact binary
   types, fail-closed catches, startup self-description, and a content hash.
5. Build `qe-coding-execution-v4` and a new `claude-code-mod` adapter using the
   post-authorization stream-json probe/prompt sequence.
6. Add zero-inference gates, then explicitly authorized model acceptance for
   completion, attention, cancellation, resume, and model/effort behavior.
7. Delete the superseded SDK production path once the new single adapter is
   accepted. Do not keep dual Claude implementations for compatibility.

The **minimum next implementation task** is step 2: a bounded generic control
protocol design/test PR for blocking HumanAttention wait/response. Do not fix the
terminal historical SDK login record and do not begin model inference as part of
that task.

## Retained prototype

Path: `spikes/claude-mod-harness/`.

The retained Mod module SHA-256 is
`c3f384c81b6793aa87e013bb60034305a9845e94a3629ee5c9b548381ff8f7c3`.
The canonical prototype plugin triplet (plugin manifest, hooks manifest, and
module, each filename NUL-framed with its SHA-256 in that order) hashes to
`22657cab4cc757177d7adc220992a92e74c020074003ad699b3577a96666ca9c`.
These are spike hashes, not future v4 production provenance. [PROTO]

It is deliberately non-production and proves, with mocks only:

- session initialization and headless local readiness command;
- prompt, turn-start, turn-step, and turn-complete interception;
- registered completion and HumanAttention tools;
- exact tool allow/deny and managed-deny preservation;
- completion over mocked `$.process.run` using the existing bridge shape;
- deferred attention over mocked streaming `$.process.spawn`;
- model/effort mismatch refusal before a mocked model request;
- classic Stop correction;
- normalization into current generic QE harness event shapes and an opaque
  native session reference without any terminal identity; and
- subagent suppression.

`local-control-wait` is intentionally documented as missing production work.
The fixture does not alter the current profile or adapter.

## Zero-side-effect accounting

For this reassessment only:

| Side effect | Count |
|---|---:|
| Real `claude auth login` invocations | **0** |
| Credentials created/imported/read | **0** |
| Product inference authorizations | **0** |
| Product model prompts | **0** |
| Agent SDK `query()` calls | **0** |
| Claude Code `-p` model turns | **0** |
| Interactive Claude turns | **0** |
| Provider inference requests | **0** |
| `qe_complete_step` calls | **0** |

Several `-p` invocations executed only the local `/qe_mod_probe` command. Their
own structured results reported `num_turns: 0`, `total_cost_usd: 0`, and empty
`modelUsage`; they are not silently counted as model turns.
