# Live execution sessions and human assistance

## Authority boundaries

```text
Quest Engineering Worker
    -> AgentHarness
         -> PiHarness
              -> SbxRunExecutionManager
                   -> Run-owned SBX / private Git / guest Pi
    -> TerminalSessionBackend
         -> HerdrTerminalBackend -> provenance-bound SBX PTY launcher
```

Quest Engineering owns orchestration: Run, StepOccurrence, Attempt, Member, Worker-slot, context-lineage and worktree occupancy. `AgentHarness` owns coding-agent interaction and supplies rich provider-native assistance information where available. `TerminalSessionBackend` owns durable terminal topology, process transport, recovery, attachment, and actual terminal-agent blocked state. Pi, Claude Code, Codex and Antigravity are harnesses; Herdr is terminal/session infrastructure and is not a coding-agent provider. Quest Engineering correlates the harness and backend signals into one HumanAttention lifecycle per blocked episode.

Interactive attention is operational state. A Step remains `running` while its session has `human_attention`; Core Runtime and Tactic results do not gain a waiting result.

## AgentHarness

The Worker contract advertises a harness kind, display name and independent capabilities for terminal attachment, input, interrupt, attention detection, continuation and structured events. Human-interaction capabilities are separate: structured confirmation, text, choice and multiline response; native prompt control; conversational takeover; and automation resume. A harness must not collapse these into one vague takeover flag. Its minimal lifecycle covers:

- `start` and `continue`;
- initial input and result collection;
- `inspect`, `recover`, `interrupt` and `close`;
- structured session/attention events;
- provider-native session identity when it is safe to retain.

`PiHarness` adapts the existing Pi lifecycle without changing fresh/continuation selection, result envelopes, output collection or crash recovery. In production it prepares an exact Run-owned SBX lease and private-lineage Git worktree, asks the lease for one authoritative `HostLaunchDescriptor`, and gives that descriptor unchanged to Herdr's explicit managed-launch transport. Herdr executes the descriptor's absolute QE/backend-owned launcher with literal argv, cwd, environment overlay, and PTY semantics. No host-visible `pi` wrapper, shell, `PATH` lookup, or direct-host fallback participates. Pi itself, its native extensions, model runtime, session file, tools, HOME, cache and working directory remain inside the guest. `FakeHarness` deterministically simulates running, attention, resume, completion, interruption, failure/closure and recovery without invoking a provider.

A future harness implements this contract, maps its own native events to the small operational states, supplies only capabilities it actually supports, and provides a terminal launch specification to a compatible backend. Human handoff is harness lifecycle—not a Pi command in the QE core contract: automation yields, a human owns the native harness session, explicit hand-back occurs, and automation resumes. Claude Code might use an interactive REPL lifecycle; Codex might use CLI/app-server approval and steering mechanisms. Neither is implemented here. Provider prose and private provider data must not leak into Product contracts.

## TerminalSessionBackend

The backend creates/reuses terminal workspaces and panes, starts a harness integration, observes transport state, recovers exact terminal identity, sends validated control keys, and creates a transport-neutral attachment descriptor. `HerdrTerminalBackend` uses the pinned Herdr 0.9.0 binary and protocol 22; the protocol number is provenance rather than an allowlist, while endpoint generation and semantic capabilities are the compatibility authority. Pi additionally requires live `agent_explicit_launch` advertisement and `agent.start.command` schema metadata. The additive command carries an absolute executable, literal argv, optional absolute cwd, and environment additions without shell interpretation. Managed kind/detection/readiness, PTY sizing/resizing, signals, detach/reattach, pane identity, shell restoration, Open Session, and Take Control remain normal Herdr behavior. Live transitions come from Herdr `agent.wait`, point-in-time inspection comes from `agent.get`, and restart/adoption discovery comes from `session.snapshot`; QE consumes each returned agent's exact `idle | working | blocked | done | unknown` status.

The pinned Herdr 0.9.0 commands used by native attachment are:

```text
observe:  herdr --session <name> agent attach <target>
takeover: herdr --session <name> agent attach <target> --takeover
```

Svelte never constructs these commands.

## Identity and durability

The Worker lineage ID represents a durable harness-session/physical-lineage lifetime. One lineage has an exact `harness_kind`, native conversation identity, and Herdr provenance, and may be used by several Attempts through same-harness continuation. Each dispatch retains its association with that lineage.

Therefore:

```text
Attempt --uses--> QE lineage / harness session --hosted by--> Herdr terminal/process incarnation
```

The relationships are not cardinality assumptions:

- an Attempt does not own a terminal;
- a Run does not own a terminal;
- continuation can reuse the same lineage/session;
- a fresh operational retry can rotate lineage according to existing context rules.

Worker SQLite adds harness kind, operational state, capability set, current attention, last Product-safe intervention lifecycle, and activity timestamps to `provider_lineages`. Existing Herdr/Pi IDs, native Pi session reference, workspace and active Action remain authoritative. Additive startup upgrades backfill old registries; already-running Pi processes do not gain capabilities for extension code they were not launched with. PostgreSQL stores the Product-safe session projection and links each `worker_dispatch` usage to it.

The local conversational checkpoint is versioned and minimal. It stores the attention identity/reason, `requested | resuming | resolved`, Worker/lineage/Action/Run/occurrence/Attempt IDs, Pi session ID, and hand-back/resumed timestamps. The complete objective, Step instruction and continuation context remain authoritative in the existing nonce-bound result-control Action and are not duplicated. The checkpoint survives Worker restart. It never contains human chat.

## HumanAttention

Categories are stable QE values:

- `needs_input`
- `needs_permission`
- `needs_authentication`
- `needs_confirmation`
- `blocked_external`
- `interactive_prompt`
- `unknown_interactive_block`

An attention record has a stable ID, category, concise message and requested time. Lifecycle is requested, optionally attached/acknowledged through audit, then resolved and absent. Repeated session updates with the same ID do not create duplicate audit or user notifications. A later distinct ID does.

Herdr is the authority for actual terminal-agent state. Every managed active session is observed independently through `HerdrTerminalBackend`. A Herdr transition to `blocked` creates HumanAttention even without harness metadata, using `interactive_prompt` and the safe message `<Harness> is waiting for input`. QE never uses Herdr's optional display message or terminal prose as the attention explanation. `idle`, `working`, `unknown`, and quiet duration do not create generic attention.

Pi does not provide a generic built-in permission prompt. QE therefore also loads `qe_request_human_assistance`, an explicit Pi extension tool. It supports a simple structured confirmation and a distinct `conversational_intervention` mode. This tool enriches intentional assistance; it is not the sole detection path.

For conversational intervention, the extension handles Pi's `tool_call` event before the tool body, persists the checkpoint, emits `herdr:blocked`, and returns `{block: true, terminate: true}`. Pi records the blocked tool result and settles only that automated agent run. No extension modal remains pending: the same TUI process and Pi session become idle, and the ordinary Pi editor accepts any number of normal human conversation turns. The extension keeps mutation/result tools fenced while automation is yielded. `/qe-resume` validates the active Pi session plus Worker/lineage/Action/Run/occurrence/Attempt identity, records explicit hand-back, and calls `pi.sendUserMessage()` with a minimal resume instruction. Pi's next `agent_start` proves automation resumed, records resolution, and clears `herdr:blocked`.

Thus one QE Attempt may contain multiple Pi runs/turns:

```text
automation run -> yielded/agent_settled -> ordinary human Pi runs
               -> /qe-resume -> resumed automation run -> qe_step_result
```

`agent_settled` is a Pi run boundary, not a QE completion signal. The Worker collects only the nonce-bound `qe_step_result`; while a conversational checkpoint is pending, terminal settlement cannot complete the dispatch. The answer, human messages, Pi replies, keystrokes, terminal transcript and credentials are not written to QE attention/audit storage.

The Worker correlates both signals by durable lineage and active blocked episode. A structured event may create attention before Herdr reports blocked. If Herdr blocks first, a later structured event replaces the generic category/message while preserving the episode's attention ID and requested time, so audit and user notifications remain singular. A Herdr-derived episode clears when Herdr reports `working`, `idle`, or `done` and no structured harness condition remains active; `unknown` never creates attention and does not by itself prove that an existing blocked episode resolved. QE does not regex-scan arbitrary terminal output or model prose; Herdr owns screen/TUI detection.

## Occupancy and recovery

Waiting for a human does not terminalize the dispatch. The Worker dispatch remains running, its harness lineage stays occupied, and Phoenix retains Worker slot, logical Member, context and worktree occupancy. Attachment creates no Attempt, occurrence, retry, process or terminal. Closing or detaching the terminal changes none of these facts; only `/qe-resume` hands Pi conversational control back.

A failed operational Attempt is different. Its session may remain retained for postmortem conversation without occupying an execution slot. `/qe-retry` writes a durable local request that the Worker validates and sends through generation-fenced Worker Protocol; Phoenix appends a human recovery epoch and the scheduler reacquires normal resources for a new Attempt under the same StepOccurrence. Valid retained Pi lineage is preferred, but unavailable or unverifiable continuity is never silently replaced. See `docs/retry-and-remediation.md`.

Worker restart loads the SQLite dispatch/lineage and attention record. For Pi, startup also reconciles every unfinished `sbx-run-executions.sqlite` record against the exact durable environment ref. Recovery re-verifies the immutable environment spec, frozen source, isolated host and guest repository/worktree identity, durable launch provenance, and current control descriptor before relaying anything. It then locates the exact surviving Herdr pane and rechecks guest attestation; an environment without the exact process, or a process without the exact environment, is not treated as continuity. A known wrong launcher is `environment_launch_mismatch`; guest mismatch is `environment_attestation_failed`; typed Herdr process failure is `agent_explicit_launch_failed`. These are deterministic non-recoverable infrastructure outcomes, not ambiguous prompt state. For either harness, `agent.get` inspection reconciles blocked/running state. Antigravity may otherwise resume only a verified native conversation ID into a new interactive terminal/process incarnation and must verify the returned identity. A currently blocked recovered agent restores HumanAttention. Worker Protocol v7 reports the same QE session ID under the new connection generation. Stale-generation projections cannot issue attachment descriptors.

Each lineage is observed independently. Guest Pi first writes a structurally bound attestation and then only lifecycle/native-session identity and Product-safe control state to its Run-private control directory. The Worker compares that attestation with its exact durable Worker/Run/environment/incarnation/profile/lineage/workspace launch binding before making Pi promptable. The relay forwards authenticated tool requests to the host loopback authority and reports lifecycle through Herdr; it never mirrors terminal text, chat, prompts, provider responses, credentials or the Pi transcript. Repeated relay failure is durable attention-required infrastructure state and tool calls time out fail-closed. No global session lock is introduced, so assistance for one session does not pause another Worker slot or Quest.

## Product projection and audit

Ordinary Run projections include harness display identity, Worker display identity/liveness, operational state, advertised capabilities, attachment availability, attention, timestamps and small audit-event summaries. They exclude local paths, native session paths, environment, control data, credentials and terminal output.

Product-safe audit events are:

- attention requested;
- attachment descriptor issued;
- local session opened, with observation/takeover mode and native human-control-start confirmation;
- attention resolved, with explicit hand-back and automation-resumed timestamps when applicable.

No transcript or input is audited. While active, conversational attention projects `intervention_pending`, `human_control`, or the short-lived `resuming_automation` control state. The Tauri open callback records human control only after native provenance validation and Terminal launch succeeds; descriptor issuance alone is not attachment proof.

## Local attachment security

Remote attachment is disabled. `QE_LOCAL_SESSION_ATTACH_ENABLED=true` must explicitly enable the endpoint. It additionally requires a direct loopback request, a localhost Host header, no forwarding headers, and the local Tauri client marker. The endpoint validates the exact Run, Attempt, dispatch, session, Worker and current Worker generation, then issues an on-demand descriptor with a signed token valid for 60 seconds. It never returns a reusable shell command or remote shell URL.

Tauri validates descriptor shape and takeover authority, confirms that the named Herdr session is already running via the exact configured Herdr executable's `session list --json`, verifies the exact terminal plus QE ownership/Worker/lineage provenance from `agent get`, and only then opens macOS Terminal. A running session opens observation-only. `--takeover` is accepted only for a session currently projected as waiting for the human. The native success callback is then recorded as local-session-opened/human-control-started. Herdr 0.9.0 exposes no separate durable attach-ack query, so QE's strongest confirmation is successful native validation plus macOS Terminal accepting the exact attach launch. Browser clients display the Worker hosting the session and honestly state that browser attachment is unavailable.

The local endpoint is not a substitute for authentication. Future proxied/remote attachment remains blocked until QE has user identity and Project authorization, and must use a narrowly scoped authenticated relay rather than turning Phoenix into SSH.

## Loadouts and harness selection

Loadouts select `harness_kind`, model, nullable reasoning/effort, authored ToolPolicy, and workspace access. `reasoning: null` is resolved only with explicit unsupported capability evidence. Tool enforcement and the adapter's current QE semantic capability profile are derived at scheduling and frozen in per-Attempt resolved execution; they are not authored Loadout fields. `ResolvedToolProfile` records that exact QE profile, not necessarily a raw inventory of every internal native harness tool. These execution concerns never belong in Class instructions.
