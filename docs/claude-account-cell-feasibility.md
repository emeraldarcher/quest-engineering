# Claude account-cell feasibility

## Verdict

**PASS WITH CONSTRAINTS** for the architecture and the pinned, zero-auth,
zero-inference feasibility question. This is **not** production acceptance.

An unmodified Claude Code `2.1.292` process can run in a persistent,
repository-free ProviderAccount cell while exposing exactly eight newly named
QE tools whose operations are brokered to a separate credential-free Run cell.
The same headless process can execute a synthetic local readiness command,
report `system/init`, remain alive, and then accept the first real prompt. The
probe made zero model turns and reported zero cost and empty `modelUsage`.
Exact native-session UUIDs and provider-owned transcript storage also work with
a fixed empty working directory and explicit project-directory names.

The design is safe only with the constraints in this report. In particular:

1. the current execution-environment interface is Run-owned and cannot be
   reused as a fake account Run;
2. the QE Mod must be an immutable organization-managed `prepend` Mod, not a
   `--plugin-dir` Mod;
3. the startup tool, plugin, MCP, model, effort, permission, session, account
   generation, and Run binding must all be attested before the real prompt;
4. Claude Code's cross-project `--resume <uuid>` search must be fenced by QE's
   exact session-ownership record before process launch;
5. all login, status, logout, refresh, and inference processes remain serialized
   per ProviderAccount until a later pinned-version concurrency proof exists;
6. a production bridge and physical two-SBX firewall/restart proof are still
   required; and
7. production must find a preventive, pinned control for provider-side server
   tools. A Mod can detect `serverToolUses` only after the provider performed
   them, which is not preventive enforcement.

No login, credential creation, credential inspection, provider authentication,
model request, Agent SDK `query()`, or provider inference occurred in this
research. No production profile, protocol, schema, or adapter was changed.

### FLAG — current account-environment ownership gap

**Facts:** SBX v0.43 and QE's existing backend preserve a stopped sandbox's disk
and exact incarnation, and the verifier advertises
`environment_persistence: verified`. However, `EnvironmentSpec`,
`EnvironmentRef`, `currentEnvironment`, the durable unique key, markers, and
cleanup authority are all explicitly `{Worker, Run}` owned. They cannot express
`{Worker, ProviderAccount}` ownership today.

**Decision:** Phase B must add an account-owned lifecycle before any real login.
Do not encode a ProviderAccount as a synthetic `runId` and do not weaken the
existing Run contract.

**Recommendation:** build a dedicated ProviderAccount-environment contract and
store while reusing the audited SBX client, exact-incarnation fencing,
state-preserving stop/recover behavior, verifier primitives, and uncertainty
rules. This keeps Run cleanup and account disconnect independent. No Phase D
Claude launch may proceed until a stopped account cell is physically recovered
with the same UUID/incarnation/disk and a replacement receives a new
incarnation.

## Scope and evidence language

This report narrows the architecture selected in
[`provider-credential-context.md`](provider-credential-context.md). Evidence is
labeled as follows:

- **[PIN]** exact `2.1.292` declaration or bundled artifact;
- **[DOC]** documentation retained with the pinned reassessment;
- **[SRC]** source/static audit of the retained fixture or repository;
- **[RUN]** local runtime observation with an isolated fake config root;
- **[FAKE]** deterministic architecture model/test;
- **[INF]** inference from the preceding evidence, not an observed physical
  guarantee; and
- **[DEFER]** a later explicitly authorized acceptance gate.

The retained spike is
[`spikes/claude-account-cell-feasibility/`](../spikes/claude-account-cell-feasibility/).
Its fake credential is the literal canary
`QE_FAKE_ACCOUNT_CELL_CREDENTIAL_CANARY_8f42d19a`, not a provider credential.

## Exact pinned target

| Artifact | Identity |
|---|---|
| Agent SDK | `@anthropic-ai/claude-agent-sdk@0.3.292` |
| Bundled Claude Code | `2.1.292` |
| SDK `package.json` SHA-256 | `3de3fa7a76a15bc64951d0e5f46a401b7caafd09908f1242a01dcc18f60572f0` |
| Existing QE wrapper SHA-256 | `82781ffa4a23f60e6eb5078733554da9484d7db01392d2ac48481470f07cd66b` |
| Darwin bundled binary SHA-256 | `97a01e5bc74a199e67189435d0331ea3a24eac2e07db4b76d9148c5b0386138f` |
| Linux ARM64 binary SHA-256 | `24caa9e6ff13bf227049a2626f1c816fc895023050f0ec3b12dbf14d897367e0` |
| Linux x64 binary SHA-256 | `a967e7b1d8b4e47ee421d5433027880347952b0c0857abf880e2c942a4ec93b3` |

The Linux hashes and versions are already pinned by
`workers/bun/src/execution-environment/sbx-profile.ts`. The Darwin binary was
used only for local, credential-free runtime probes. Production remains Linux
inside SBX and must verify the architecture-specific hash before launch.

## Exact account-process model

### Ownership and disk

One connected ProviderAccount owns one Worker-local SBX account cell:

```text
ProviderAccount generation g
└── AccountEnvironmentRef {worker, provider_account, UUID, incarnation}
    ├── immutable qe-claude-provider-account-v1 profile
    ├── canonical provider-owned CLAUDE_CONFIG_DIR (persistent disk)
    ├── fixed empty cwd (no repository and no Run workspace)
    ├── pinned unmodified Claude Code + immutable managed QE Mod
    ├── fixed QE bridge executable and one-way Worker control route
    └── at most one admitted status/login/logout/Claude process
```

The account root is canonical, never snapshotted per Run, copied, exported,
hashed by QE, or exposed through a Worker file API. Official Claude processes
may read and mutate it. The host OS, SBX daemon, account-cell kernel, and
provider executable remain in the local infrastructure trust boundary. Product,
PostgreSQL, Worker SQLite, protocols, Runs, workspaces, Git, logs, Mod tool
results, and model-visible tools contain no credential bytes.

The initial profile identity remains the previously proposed
`qe-claude-provider-account-v1`; the credential-free Run profile remains the
future `qe-coding-execution-v4`. Neither immutable profile contains mutable
credentials.

### Configuration and cache hierarchy

The profile must resolve every path instead of inheriting the host environment:

| State class | Required location/handling | Model visibility |
|---|---|---:|
| Subscription credential and official refresh state | Canonical account-private `CLAUDE_CONFIG_DIR`; provider process only | No |
| Global Claude JSON and backups | Same account disk; official process owns format | No |
| Managed settings and QE Mod | Immutable profile/organization path, outside mutable provider state | No; effect is attested |
| Native transcripts | `CLAUDE_CONFIG_DIR/projects/<opaque-lineage-project>/<uuid>.jsonl` | Only through an exactly authorized resume |
| Auto memory | Disabled; directory must not be loaded | No |
| Prompt history | Account-private; no host/user history import | No direct tool |
| Plugin marketplace/cache/data | Official sync/install disabled; only immutable managed QE plugin is permitted | No |
| MCP state/OAuth | No configured external MCP; no user/project MCP state admitted | No |
| Debug, telemetry, stats, PR badges | Disabled or retained account-private with safe log policy | No |
| XDG cache/state, temp, HOME | Explicit account-private or fresh process-private directories | No |
| Run workspace, private Git, shell HOME/temp | Separate Run SBX only | Through eight bounded broker tools |

The official transcript format is internal and version-dependent. QE persists
only the UUID and safe ownership metadata; it does not parse transcript JSONL.
Retention cleanup may remove an exact retired project namespace through a
trusted account-lifecycle operation after all references are retired, but
ordinary Worker business logic has no provider-root `readFile`, copy, or export
capability.

### Fixed working directory

Claude Code runs from a QE-owned empty directory with no `.git`, checkout,
`CLAUDE.md`, `AGENTS.md`, `.mcp.json`, `.claude/`, socket, keychain, SSH agent,
Docker socket, or host mount. Its ancestors must also contain no instruction or
project files. The directory is never the Run workspace.

A credential-free runtime probe used an empty directory below
`.pi/tmp/claude-account-cell-runtime-probe-5/cwd`; it had no `.git` and the Mod
loaded successfully. A second probe placed an unapproved project `.mcp.json`
and project settings under a disposable cwd. Under `--restricted`, the MCP
process did not start, `system/init.mcp_servers` contained only the QE plugin
server, and the native tool inventory remained the eight QE tools. **[RUN]**

Required defense in depth is:

- `--restricted`;
- `CLAUDE_CODE_DISABLE_CLAUDE_MDS=1`;
- built-in `cc-plugin-agents-md` configured as `managed-only` or explicitly
  disabled;
- no project checkout or instructions physically present;
- `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1`;
- `CLAUDE_CODE_DISABLE_GIT_INSTRUCTIONS=1`; and
- actual Product prompts sent with `client_composed: true`, which the pinned SDK
  message contract says prevents slash-command and `@path`/resource expansion.

### Process admission and launch

The Worker performs this sequence for each admitted provider process:

1. acquire the exclusive lease for the exact ProviderAccount generation and
   account-environment incarnation;
2. revalidate local account status, inference authorization, Run authority,
   PhysicalLineage, Run-environment incarnation, and Run recovery epoch;
3. bind a bridge channel server-side. Model input cannot choose Worker,
   ProviderAccount, generation, Run, Action, Attempt, PhysicalLineage, Run
   environment, workspace, or endpoint;
4. create explicit account-private `HOME`, XDG, temp, config, and empty cwd;
5. launch the exact binary with a structured argv, exact model and effort,
   `--restricted`, `--strict-mcp-config`, `dontAsk`, no permission prompts,
   exact eight-tool `--tools`, stream-JSON input/output, and no browser;
6. use `--session-id <worker-generated-uuid>` for a fresh lineage or
   `--resume <exact-owned-uuid>` for an authorized resume—never both, never a
   name/path, and never `--continue`;
7. send one fixed synthetic stream-input message with `shouldQuery: false` and
   `client_composed: true`. This causes initialization and a zero-turn result
   without asking the model, even if the QE Mod is absent;
8. validate `system/init`, the exact session/model/tools/plugins/MCP/policy
   inventory, and zero turns/cost/model usage. If any check fails, terminate the
   process without sending another message;
9. only after confirming that the exact QE Mod loaded, send
   `/qe_account_cell_probe`, validate its second zero-turn result and matching
   native session/tool list, and commit the startup attestation;
10. send the Product prompt once with `client_composed: true`; and
11. retain the exclusive lease through tool calls, blocking HumanAttention,
   settlement, cancellation, and exact process-exit reconciliation.

A two-stage pinned stream-input probe followed that startup shape.
`system/init` reported session `44444444-4444-4444-8444-444444444444`, model
`claude-opus-5-5`, permission mode `dontAsk`, `apiKeySource: "none"`, only the
eight QE tools, and only the QE plugin MCP server. The `shouldQuery: false`
result and subsequent local Mod command each reported `num_turns: 0`,
`total_cost_usd: 0`, and `modelUsage: {}`; the same process remained alive.
A separate no-Mod probe proved that `shouldQuery: false` still initializes with
no assistant message or model turn. **[RUN]** This is the pre-inference gate and
uses no Agent SDK `query()`.

The ordering is security-relevant. A probe that sent the slash command first
without the Mod present attempted a normal turn (`num_turns: 1`) and then failed
locally because the disposable config was not logged in. An authenticated
process could have crossed the provider boundary. Therefore the fixed
non-querying message, external init validation, and only then the Mod command
are mandatory. These probes do not prove authenticated behavior.

Production must additionally attest the binary/Mod/settings hashes, organization
`prepend` provenance, no plugin errors, exact expected built-ins, no MCP errors,
account binding nonce, bridge protocol, account generation, Run binding, model,
effort, and native UUID. The spike Mod currently attests its protocol, native
session ID, model/effort at `turn.step`, and exact registered tool list; a real
bridge attestation is Phase D work.

### Environment allowlist

Launch from an allowlist, not a denylist. Required disabling entries include:

```text
DISABLE_TELEMETRY=1
DISABLE_ERROR_REPORTING=1
CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1
CLAUDE_CODE_DISABLE_OFFICIAL_MARKETPLACE_AUTOINSTALL=1
CLAUDE_CODE_DISABLE_AUTO_MEMORY=1
CLAUDE_CODE_DISABLE_CLAUDE_MDS=1
CLAUDE_CODE_DISABLE_BUNDLED_SKILLS=1
CLAUDE_CODE_DISABLE_AGENT_VIEW=1
CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1
CLAUDE_CODE_DISABLE_EXPLORE_PLAN_AGENTS=1
CLAUDE_AGENT_SDK_DISABLE_BUILTIN_AGENTS=1
CLAUDE_CODE_DISABLE_GIT_INSTRUCTIONS=1
ENABLE_CLAUDEAI_MCP_SERVERS=false
```

Do not pass provider API keys, bearer tokens, OAuth-token overrides, base URLs,
profiles, gateways, cloud selectors, proxy selectors, MCP configs, plugin dirs,
agents, fallback models, dynamic headers/bodies, inherited Git/SSH variables, or
`CLAUDE_CODE_RESUME_INTERRUPTED_TURN`. Inference and status use the canonical
credential file directly. Login is a separate, explicitly authorized process
with its own minimal browser/code-paste requirements.

### Serialization and mutation safety

The pin contains real concurrency fixes: login-refresh lock recovery, waiting on
a token-refresh lock, simultaneous logout after wake, and concurrent
`~/.claude.json` write loss. Those are positive evidence that the binary has
some locks; they are also evidence that shared state extends beyond one token
file. No pinned contract proves every credential, settings, plugin/cache,
session, logout, and crash-recovery write safe under arbitrary parallel
processes.

Therefore initial admission is **one process total per ProviderAccount**, not
one writer plus parallel readers. Status, login, logout, and all Claude
inference processes serialize. Routine official refresh mutates canonical state
in place and does not advance QE's credential generation. Login,
reauthentication, account replacement, logout, and administrative invalidation
do advance it. Multiple Runs may prepare concurrently, but inference queues.
A HumanAttention wait retains the lease. This is conservative and can reduce
throughput; it is not optional in v1.

## Model-visible capability audit

### Complete generated built-in inventory

The exact generated `2.1.292` Mod declarations contained 75 built-in input
variants:

```text
Agent, AppifactRepl, Artifact, ArtifactCheck, ArtifactComments, ArtifactData,
AskUserQuestion, Bash, CronCreate, CronDelete, CronList, DesignSync, Edit,
enable__mcp__claude-in-chrome,
enable__mcp__remote-devices__Claude_Browser,
enable__mcp__remote-devices__computer, EndConversation, EnterPlanMode,
EnterWorktree, ExitPlanMode, ExitWorktree, FetchInboxMessage, GetTask,
ListAgents, ListConnectors, ListMcpResourcesTool, ListPlugins, ListSkills, LSP,
memory_list, memory_read, memory_write, Monitor, NotebookEdit,
OfferChromeSetup, Poll, Projects, propose_skills, ProposeGoal, PublishPlugin,
PushNotification, Read, ReadMcpResourceDirTool, ReadMcpResourceTool,
ReadNotifications, RemoteTrigger, ReportFindings, request_computer,
ScheduleWakeup, SearchMcpRegistry, SearchPlugins, SearchSkills, SendFeedback,
SendFile, SendMessage, SendUserFile, SendUserMessage, ShareOnboardingGuide,
ShowOnboardingRolePicker, Skill, SuggestConnectors, SuggestPluginInstall,
SuggestSkills, TaskCreate, TaskGet, TaskList, TaskStop, TaskUpdate, TodoWrite,
ToolSearch, WaitForMcpServers, WebFetch, WebSearch, Workflow, Write
```

Tools documented elsewhere or present under other feature/platform sets—such as
`Glob`, `Grep`, `PowerShell`, and `TaskOutput`—are also unauthorized. The rule is
not “deny this observed list”; it is “startup inventory equals the exact eight
QE names.” Any ninth model tool fails launch.

### Selected strategy: new QE names

Strategy A is selected: omit every native model-visible tool and register new QE
names. Strategy B—intercepting native `Read`/`Bash`/`Edit`/`Write` and never
calling core—works in a successful hook, but is weaker:

- native tools would have to be offered in the model inventory;
- their input/result contracts and semantics remain coupled to core;
- an unloaded, crashed, reordered, or skipped Mod could expose core behavior;
- a gating hook without a successful fail-closed `.catch` can fall through; and
- future native behavior could change under an unchanged name.

With new names plus an exact `--tools` list, loss of the Mod removes
functionality instead of revealing an account-cell tool. The Mod still denies
native calls in depth, and tests prove native `Read` and `Bash` never reach
`next`.

### Exact permitted model surface

| Tool | Account-cell behavior | Run-cell authority |
|---|---|---|
| `qe_workspace_read` | fixed bridge + bounded JSON | read one relative regular file |
| `qe_workspace_list` | fixed bridge + bounded JSON | list one relative directory |
| `qe_workspace_write` | fixed bridge + bounded JSON | write one relative workspace file |
| `qe_workspace_edit` | fixed bridge + bounded JSON | exact text replacement in one file |
| `qe_workspace_search` | fixed bridge + bounded JSON | bounded search below workspace |
| `qe_run_shell` | command is stdin data, never account argv | shell only in the pre-bound Run SBX |
| `qe_complete_step` | semantic control operation | exact completion authority |
| `qe_request_human_assistance_and_wait` | fixed blocking bridge operation | existing durable HumanAttention lifecycle |

At runtime their names are the plugin-qualified
`mcp__qe-account-cell-feasibility__...` names. They are in-process registered
Mod tools represented as a plugin MCP server, not an external MCP transport.
The unqualified suffix is the stable semantic name.

`hooks/register.ts` calls only `$.env.get`, `$.session.id`,
`$.tool.register`, `$.command.register`, and `$.process.run/spawn`. Process argv
is fixed to `/opt/qe/bin/qe-account-cell-bridge` plus one fixed operation. It
contains no `$.fs`, `$.http`, `$.model`, `$.tool.call`, `$.agent.spawn`,
`$.prompt.submit`, Node filesystem/process import, or `fetch`. Inputs are
schema-bounded and serialized to stdin; bridge output is capped at 65,536
characters and must be JSON. **[SRC]**

Production must tighten the generic JSON output to an operation-specific schema,
byte-based UTF-8 bounds, streaming/backpressure, cancellation, and side-effect
certainty. The bridge itself must independently perform realpath/no-symlink
checks and exact authority validation; Mod validation is not a security
boundary.

### No alternate tool path

The pin needs all of these controls together:

| Surface | Required control | Evidence/status |
|---|---|---|
| Native tools | exact eight-name `--tools`; catch-all `tool.call` deny | Eight names in `system/init`; native denial test **[RUN][SRC]** |
| Permission prompts | `dontAsk`, `--permission-prompts none`, managed deny ceiling preserved | Mod test **[SRC]** |
| Subagents | no Agent/Task tools; hide offers; deny spawn and agent-scoped calls; disable built-ins/env/background | Mod tests; startup still enumerates agent metadata **[SRC][RUN]** |
| Slash commands | first exact QE probe only; catch-all command refusal; real prompt `client_composed: true` | Mod test and local probe **[SRC][RUN]** |
| Skills/workflows | bundled skills off; no Skill/Workflow/ToolSearch; strict customization | Tool inventory proof **[RUN]** |
| User/project Mods/hooks | managed-only policy, immutable managed marketplace, `plugin.register` refusal in depth | Local tests simulate `prepend`; real org provenance deferred **[SRC][DEFER]** |
| MCP/connectors | strict MCP config, connectors off, plugin-only customization, exact one QE plugin server | Malicious project MCP did not start **[RUN]** |
| Project instructions | empty cwd, CLAUDE files disabled, AGENTS built-in managed-only | Empty-cwd proof; profile acceptance deferred **[RUN][DEFER]** |
| Model/effort | exact CLI flags plus Mod `turn.step` equality | Test and local `system/init.model` **[SRC][RUN]** |
| Remote/background features | nonessential traffic, agent view, background tasks, memory, telemetry, plugin sync disabled | Pinned documented switches **[DOC]** |
| Model fallback | no fallback config; reject changed model at `turn.step` and settlement | Synthetic test; authenticated acceptance deferred **[SRC][DEFER]** |
| Provider server tools | require zero and fail settlement if observed | Detection exists, prevention unresolved **[SRC][DEFER]** |

`--safe-mode` is not usable because it disables the QE Mod. `--bare` is not a
replacement for managed policy. `--restricted` is useful but insufficient by
itself: it ignores user/project/local settings and removes command/code and
`WebFetch` tools unless explicitly named, yet startup still enumerates built-in
commands, agents, skills, and built-in plugins.

### Managed policy contract

Production may not use `--plugin-dir`. Managed settings must:

- register an administrator-owned local marketplace under an immutable profile
  path;
- force-enable the QE plugin and place it first with `prependPlugins`;
- place `cc-plugin-sec-default@builtin` immediately after it;
- set the built-in guard's `allowManagedModsOnly` option;
- set `allowManagedHooksOnly`, `allowManagedPermissionRulesOnly`,
  `disableSideloadFlags`, and `strictPluginOnlyCustomization: true`;
- disable command plugin sources, plugin sync/auto-install, external MCP,
  connectors, skills, agents, background tasks, and agent view;
- configure `cc-plugin-agents-md@builtin` to `managed-only` or disable it;
- preserve explicit deny rules for the config, control, profile, and credential
  paths; and
- be included in the immutable startup digest and verified from
  `system/init.plugins`, plugin errors, MCP inventory/errors, and a local probe.

The local runtime necessarily reported the fixture as `@inline` because a
research `--plugin-dir` was used. Mod tests can simulate organization
`prepend` order, but that does not prove managed provenance. **[DEFER]**

### Provider-side server tools

`2.1.292` exposes `serverToolUses` from `turn.step`, and usage accounts for
provider-side web search/fetch. The spike buffers a downstream turn and refuses
the result if this array is nonempty. That is useful evidence and accounting,
but the server operation has already occurred.

The exact native tool inventory excludes `WebSearch`, `WebFetch`, artifacts,
connectors, code execution, and tool search, and all corresponding client-side
features are disabled. This makes spontaneous provider server tools unlikely;
it does not establish a preventive boundary. Production acceptance needs one of:

1. a pinned documented setting/request contract that excludes every server tool;
2. an authorized packet/request-shape acceptance test proving the unmodified
   binary sends no server-tool schema for this launch; or
3. a provider guarantee that no server tool can execute without a schema that
   the exact launch omits.

Until then, any observed `serverToolUses` is a policy violation, its usage and
side effect are retained as evidence, no semantic completion is accepted, and
there is no automatic retry. This is a **production stop**, not a claim that a
post-response hook can undo the operation.

## Filesystem, process, and network boundaries

### Filesystem matrix

| Actor | Account config | Account empty cwd | Run workspace/private Git | Host/other Runs |
|---|---:|---:|---:|---:|
| Official Claude process | Yes, required | metadata only | No mount/path | No |
| Immutable QE Mod | Technically same trusted process; audited not to read | no fs API used | only through bridge | No |
| Fixed account bridge | no credential read capability | executable only | sends bound operation | No |
| Model-visible QE tools | No namespace/path | No namespace/path | bounded bound operation | No |
| Run tool executor | No route/mount/env | No | Yes, exact Run/lineage | No |
| Worker business logic | safe refs only; no read/copy/export | lifecycle | control authority | host infrastructure only |

The fake proof demonstrates relative-path containment, account-path rejection,
symlink escape rejection, no canary in workspace search, Run-local `HOME`/cwd,
and macOS kernel sandbox denial when a Run shell directly opens the fake account
credential or follows a symlink to it. **[FAKE]** Linux two-SBX namespace proof
remains mandatory because the fake does not make a macOS host sandbox equivalent
to SBX.

### Network matrix

| Source | Allowed destinations | Explicitly unavailable |
|---|---|---|
| Account Claude process | exact official Claude runtime endpoints only | registries, Git, project services, arbitrary MCP, Run addresses |
| Account login process | exact official setup endpoints under separate authorization | model inference authority, Run broker operations |
| Account bridge | one Worker-owned bound-operation channel | arbitrary account-cell command selection |
| Run broker client/tool executor | existing Run egress grants as resolved for the Run | account-cell IP/control socket, account disk, provider-account broker reverse route |
| Product/server | Worker protocol only | credential bytes and provider HTTP proxying |

`FakeNetworkBoundary` proves the intended direction: the account side may request
one bound broker operation; the Run has only `run-egress`, and direct Run
connections to either `account-cell-control` or `worker-bound-broker` throw.
**[FAKE]** Production must enforce this with separate VM namespaces, no shared
mount, no shared inherited descriptor, an account-to-Worker authenticated
channel, Run firewall denial of account/private control ranges, and physical
packet/path probes. The Worker brokers operations, never provider HTTP headers
or credential traffic.

### Broker authority and concurrency

A bridge instance is pre-bound to:

```text
Worker
AccountEnvironment incarnation
Credential generation
Run / Action / Attempt
PhysicalLineage
RunEnvironment incarnation
Run recovery epoch
Workspace
```

None of those fields exists in model tool input. A server-side binding maps the
account process identity/channel to that tuple. Every operation revalidates it
before dispatch and before returning a result. The fake proof concurrently
reads Run A and Run B and observes the correct content and exact distinct
lineages; a traversal from A to B is rejected. **[FAKE]**

The model's `qe_run_shell.command` is intentionally shell language, but it is
stdin data to the fixed account bridge. Only the credential-free Run executor
may interpret it. The account cell never evaluates that string or places it in
argv.

## Native session and history isolation

### Storage and ownership

Use one canonical `CLAUDE_CONFIG_DIR` per ProviderAccount generation and one
opaque 1–64 character `CLAUDE_CODE_PROJECT_DIR_NAME` per exact native-session
owner. The Worker generates the project namespace and UUID; it does not derive
a path from model input. A durable safe ownership row binds:

```text
native UUID -> ProviderAccount + credential generation
            + Run + PhysicalLineage
            + Run-environment incarnation/recovery epoch
            + account-environment incarnation
            + state {current, retired, uncertain}
```

Run/Action/Attempt authority is revalidated for each process, while the native
conversation remains PhysicalLineage-owned. Session contents stay in the account
cell. Product and Worker stores retain no transcript bytes.

### Pinned behavior and its consequence

Pinned documentation says `--resume <session-id>` searches the current project
and worktrees, then **every other project on the machine**. The local proof was
stronger: it created session A under `qe_pa1_run_a_lineage_a`, session B under
`qe_pa1_run_b_lineage_b`, resumed A from A, and then asked raw Claude Code to
resume B while launched with A's project name. Raw Claude Code accepted B and
reported B's UUID, while B's transcript remained in B's project directory. All
four operations were synthetic local commands with zero turns, cost, and model
usage. **[DOC][RUN]**

Therefore project-directory naming is storage partitioning, **not resume
authorization**. QE must reject A→B before launch. The native CLI cannot be the
authority.

### Resume policy

| Request | Decision |
|---|---|
| Fresh UUID generated for exact current lineage/binding | Allow with `--session-id` |
| Exact UUID owned by same current binding/generation/epochs | Allow with `--resume <uuid>` |
| UUID owned by another Run or lineage | Reject before process start |
| UUID from prior credential generation | Reject/retire |
| UUID from replaced Run-environment epoch | Reject/retire |
| Name, transcript path, picker, `/resume`, `/branch`, `/clear`, `/cd`, `--fork-session` | Prohibit |
| `--continue` or “latest” selection | Prohibit |
| Missing/ambiguous ownership after restart | Fail closed; do not search heuristically |

The fake matrix proves exact A→A and B→B resumes, A→B/B→A rejection,
`--continue` rejection, generation fencing, and Run-replacement fencing.
**[FAKE]**

## Login, refresh, logout, restart, and cleanup

### Authentication remains a separate authority

`claude auth login`, `claude auth status`, and official logout run only in the
account cell. Login has no Run, repository, model prompt, model-visible tools,
or inference authorization. A separately authorized real-login acceptance phase
must establish the official browser/code-paste/PTY shape. If sensitive pasted
setup input is needed, it uses an account-setup-scoped ephemeral no-log channel;
it never passes through durable HumanAttention, Product, PostgreSQL, Worker
SQLite, a Run, logs, or a transcript.

The zero-auth spike did not validate `claude auth status` output or login/logout.
No undocumented account-resource or “free auth check” request is assumed.

### Lifecycle matrix

| Event | Generation/session rule | Side-effect/recovery rule | Evidence |
|---|---|---|---|
| Routine official refresh | generation unchanged | canonical state mutates under exclusive lease | serialized fake revision **[FAKE]** |
| Login/reauth/account replacement | advance generation | old bindings and sessions retire before new use | generation fake **[FAKE]** |
| Logout requested | immediately fence admission | cancel and prove quiescence before one official logout | quiescence fake **[FAKE]** |
| Logout ambiguous | remain fenced/uncertain | never replay automatically | design **[INF][DEFER]** |
| Run cell replaced | account generation unchanged; Run epoch increments | old bridge/session binding retires | replacement fake **[FAKE]** |
| Worker restart | recover exact account ref and safe ledgers | no prompt/login/tool replay; in-flight stream unavailable | reconstruction fake + existing SBX contract **[FAKE][SRC]** |
| Host restart | recover same account UUID/incarnation/disk | if exact proof fails, require reconnect | physical proof deferred **[DEFER]** |
| Run cleanup | retire only that Run's bindings/sessions | do not logout or delete account | cleanup fake **[FAKE]** |
| Account cleanup | only after references retired and disconnect settled | separate stop/remove uncertainty state | implementation deferred **[DEFER]** |

The fake generation-rotation proof refuses replacement while a provider process
is active, leaves generation unchanged, then permits rotation only after exact
release and fences the old handle. The fake logout starts one provider process,
commits a fenced revocation state, rejects a new binding, waits until the
process releases, advances generation, clears bindings, and rejects the old
handle. The fake Worker/host reconstruction
retains safe ownership/session metadata, contains no fake canary in its
projection, and records zero uncertain replays. These prove state-machine shape,
not SBX persistence. **[FAKE]**

### HumanAttention and cancellation

The Mod's blocking tool uses a fixed bridge operation and waits for one bounded
result. Mod tests prove it does not return before the fake exact response. The
production bridge must preserve the existing provider-neutral rules:
commit-before-delivery, exact request/generation acknowledgement, 64-waiter
bound, cancellation, stale-response rejection, uncertainty on lost settlement,
and no automatic replay.

Inference-time HumanAttention cannot perform ProviderAccount setup or accept an
Anthropic credential/code. Account setup uses its separate lifecycle. A Run
HumanAttention message and response may be durable only under the existing safe
Product contract.

Cancellation must propagate from exact Attempt authority to the Mod bridge wait,
Run shell/tool operation, and exact account Claude process. Lost process/tool
acknowledgement is uncertain and never retried automatically. The spike proves
blocking and lifecycle fencing but not physical cancellation; that is a Phase C
and D stop gate.

## Proof matrices

### Retained deterministic tests

| Proof | Result | What it proves | What it does not prove |
|---|---:|---|---|
| `claude plugin validate` | pass | manifest/hooks valid; seven gating sites have `.catch` | organization provenance |
| `claude plugin test` | 12 pass | tool registration, fixed routing, native denial, malformed paths, subagent denial, blocking attention, completion, managed deny, Mod/command refusal, prompt/model/effort handling | real bridge/provider |
| proof TypeScript | pass | fake model and tests typecheck | protocol compatibility |
| `bun test proof.check.ts` | 12 pass, 53 expectations | fs/symlink/shell, concurrency, session, generation, logout, replacement, restart, cleanup, network, serialization | physical Linux SBX/login |
| empty-cwd local command | zero turns/cost | Mod works without a checkout | coding quality |
| two-stage same-process stream probe | both stages zero turns/cost; process alive | non-querying init gate, then Mod probe, without SDK `query()` | authenticated execution |
| malicious project MCP probe | did not start | `--restricted` ignored project MCP/settings in this pin | managed organization installation |
| two-project session probe | zero turns/cost | exact storage; raw cross-project resume risk is real | QE production gate |

### Requirement disposition

| Requirement | Disposition |
|---|---|
| Unmodified hosted Claude Code with subscription auth | Feasible; real auth deferred |
| No repository in account cell | Proven for startup/tool registration; model quality deferred |
| Only brokered Run tools visible | Proven in exact local `system/init` and Mod tests |
| No account-cell shell/fs/search for model | Structural with new names and separate Run executor; physical profile deferred |
| Canonical refresh across Runs | Feasible under one process lease; fake serialized proof |
| Concurrent Run/lineage isolation | Fake proof passes; physical dual-SBX proof deferred |
| Durable exact native sessions | Pinned CLI behavior proven; QE ownership gate fake-proven |
| Logout/generation fencing | Fake state machine passes; official logout deferred |
| Worker/host restart | Safe model passes; exact account-owned SBX recovery deferred |
| Credential-free Run | Fake path/network proof passes; production packet/mount proof deferred |
| No provider-side server tools | Not yet preventively proven; production stop |
| No production implementation in research PR | Satisfied |

## Exact 61-item stop report

A `PASS` here means the research evidence supports the design. `STOP` means the
named production phase may not proceed until satisfied; it does not change the
feasibility verdict to a production acceptance.

| # | Check | Status | Stop condition / evidence |
|---:|---|---|---|
| 1 | SDK pin is `0.3.292` | PASS | Profile declaration/hash **[PIN]** |
| 2 | Claude pin is `2.1.292` | PASS | Package and runtime declaration **[PIN]** |
| 3 | Linux runtime hashes are exact | PASS | ARM64/x64 hashes recorded **[PIN]** |
| 4 | Research performed no login | PASS | No login command or setup authorization used |
| 5 | Research performed no provider/model inference | PASS | Zero usage/cost; one negative auth-rejected command incremented `num_turns` without a request **[RUN]** |
| 6 | Research used no SDK `query()` | PASS | Direct local CLI/fixture tests only |
| 7 | No API-key/token/profile/gateway fallback | PASS | Isolated env; `apiKeySource: none` **[RUN]** |
| 8 | Account cwd needs no checkout | PASS | Empty-cwd Mod probe **[RUN]** |
| 9 | Account cwd has no Git/project instructions | PASS | Empty/no `.git`; profile must preserve it |
| 10 | Generated built-in surface inventoried | PASS | 75 variants listed **[PIN]** |
| 11 | Startup model surface is exact | PASS | Eight QE names only **[RUN]** |
| 12 | QE tools use new names | PASS | Native names omitted **[SRC][RUN]** |
| 13 | Native `Read` is refused pre-core | PASS | Mod test **[SRC]** |
| 14 | Native `Bash` is refused pre-core | PASS | Mod test **[SRC]** |
| 15 | Unknown tools fail closed | PASS | Catch-all tool hook + `.catch` **[SRC]** |
| 16 | Account bridge executable/argv are fixed | PASS | Static audit **[SRC]** |
| 17 | Model cannot choose authority identifiers | PASS | Tool schemas/fake bound bridge **[SRC][FAKE]** |
| 18 | Mod has no fs/http/model/tool-call API | PASS | Static audit **[SRC]** |
| 19 | Tool inputs and outputs are bounded | CONSTRAINT | Spike bounds JSON; production needs byte/exact output schemas |
| 20 | Symlink/traversal escape is rejected | PASS | Fake broker and shell proofs **[FAKE]** |
| 21 | Run shell executes outside account cell | PASS/STOP | Fake kernel proof; physical Linux SBX proof required |
| 22 | Run HOME/cwd contain no account credential | PASS/STOP | Fake proof; physical profile proof required |
| 23 | Run cannot connect to account/control routes | PASS/STOP | Fake topology; physical firewall proof required |
| 24 | Two concurrent Runs route exactly | PASS/STOP | Fake concurrency passes; physical test required |
| 25 | Completion remains semantic control | PASS | Authority-free Mod payload; existing semantics retained |
| 26 | HumanAttention blocks for exact response | PASS | Mod test **[SRC]** |
| 27 | HumanAttention durability/uncertainty preserved | STOP | Real bridge/cancellation/restart test required |
| 28 | Subagents are unavailable | PASS/STOP | Tool/spawn tests pass; managed startup attestation required |
| 29 | User/project Mods cannot load | PASS/STOP | Hook test; managed organization proof required |
| 30 | Project MCP cannot load | PASS | Malicious disposable MCP did not start **[RUN]** |
| 31 | Only QE plugin MCP is present | PASS/STOP | Local inventory passes; production exact attestation required |
| 32 | Skills/workflows/tool search are absent | PASS/STOP | Exact tools pass; managed customization proof required |
| 33 | Slash commands have no alternate path | PASS | Non-querying init first, exact Mod probe second, catch-all; real prompt client-composed |
| 34 | Model and effort are exact | PASS/STOP | Local init/test pass; authenticated turn proof required |
| 35 | Permission mode is `dontAsk`/no prompts | PASS | Local init/test **[RUN][SRC]** |
| 36 | Managed deny ceilings survive Mod allow | PASS | Mod test **[SRC]** |
| 37 | QE Mod is immutable organization `prepend` | STOP | `--plugin-dir` only simulated this tier |
| 38 | Managed settings provenance is exact | STOP | Build profile and attest hashes/source |
| 39 | Background/remote/plugin-sync features are off | CONSTRAINT | Documented env/settings set; production startup audit required |
| 40 | Provider server tools are preventively absent | STOP | Post-response `serverToolUses` detection is insufficient |
| 41 | Fresh native UUID is Worker-generated | PASS/STOP | CLI proof; production ownership persistence required |
| 42 | Exact same-binding resume works | PASS | A→A/B→B fake and local proof |
| 43 | Cross-Run resume is rejected by QE | PASS/STOP | Fake rejects; raw CLI accepts, so production prelaunch gate required |
| 44 | `--continue`/latest/name/path resume is forbidden | PASS/STOP | Fake policy; production argv builder required |
| 45 | Credential-generation rollover fences old work | PASS | Fake process-start/session rejection |
| 46 | Run replacement has an independent epoch | PASS | Fake old-binding/session rejection |
| 47 | Provider processes serialize per account | PASS/CONSTRAINT | Fake mutation order; max concurrency must stay one |
| 48 | Refresh keeps generation and canonical state | PASS/STOP | Design/fake revision; real refresh deferred |
| 49 | Login advances generation under setup authority | STOP | No real login was authorized |
| 50 | Login sensitive input is ephemeral/no-log | STOP | Account setup channel not implemented |
| 51 | Logout fences before quiescence | PASS | Fake rejects new work immediately |
| 52 | Logout waits and never replays ambiguity | PASS/STOP | Fake quiescence; official side-effect proof required |
| 53 | Worker restart performs no prompt/tool replay | PASS/STOP | Fake reconstruction; durable Worker integration required |
| 54 | Host restart recovers exact account disk/incarnation | STOP | Current account-owner contract absent; physical proof required |
| 55 | Missing/corrupt account state fails closed | CONSTRAINT | Required state; destructive/reconnect test deferred |
| 56 | Run cleanup does not logout/delete account | PASS | Fake cleanup retains B/account generation |
| 57 | Account cleanup is a separate lifecycle | STOP | Dedicated owner/store and retention policy required |
| 58 | Product/Worker/logs never receive credential bytes | PASS/STOP | Architecture/static fake; production canary/log audit required |
| 59 | Harness Control v2 / Worker Protocol v14 / schema 2 unchanged | PASS | Research adds no production protocol/schema code |
| 60 | All retained validation gates pass | PASS | Commands/results below |
| 61 | Production launch is authorized by this report | NO | Verdict is feasibility-only; every STOP needs its own PR/gate |

## Validation commands

```sh
.pi/tmp/claude-mods-reassessment/packages/darwin/claude \
  plugin validate spikes/claude-account-cell-feasibility

workers/bun/node_modules/.bin/tsc \
  -p spikes/claude-account-cell-feasibility/tsconfig.json --noEmit

.pi/tmp/claude-mods-reassessment/packages/darwin/claude \
  plugin test spikes/claude-account-cell-feasibility

workers/bun/node_modules/.bin/tsc \
  -p spikes/claude-account-cell-feasibility/proof-tsconfig.json --noEmit

bun test ./spikes/claude-account-cell-feasibility/proof.check.ts
```

Expected retained result: validation success, both TypeScript checks clean,
12 Mod tests passing, and 12 fake architecture tests/53 expectations passing.
The historical repository-wide `workers/bun bun run check` still has unrelated
baseline findings in `sbx-verifier.ts` and `src/config.ts`; this research does
not change those files.

## Phase-gated implementation order

Each phase is a separate PR and human merge gate. Agents never merge.

1. **A — Product domain:** ProviderAccount, setup authorization/attempt,
   generation, safe projection, and account-scoped HumanAttention metadata; no
   login implementation.
2. **B — Account environment:** dedicated account-owned SBX lifecycle/store,
   immutable account profile, exact stop/recover/replacement proof, and
   credential-inaccessible Worker APIs.
3. **C — Broker:** versioned bound operation protocol, exact input/output
   schemas, Run-side filesystem/search/shell/control implementation,
   cancellation/uncertainty, physical two-SBX and firewall/canary proofs.
4. **D — Pinned Claude Mod:** organization-managed immutable installation,
   managed settings, startup attestation, direct stream-input process, native
   session ownership, server-tool preventive proof, and fake-provider parity.
5. **E — Real authentication acceptance:** separately authorized official
   subscription login/status/refresh/logout, no inference, sensitive no-log
   channel, Worker/host restart, and disconnect uncertainty.
6. **F — Authorized inference acceptance:** one narrow Product Attempt proving
   exact model/effort, only broker tools, session resume, cancellation,
   HumanAttention, completion, usage, no provider server tools, and no credential
   canary leakage.
7. **G — Retirement:** only after v4 parity and human approval, remove the
   production Agent SDK query wrapper and Run-bound Claude auth path in a
   separate PR. Retain generic streamed-process, cancellation, authority,
   HumanAttention, and native-session infrastructure.

Until those gates pass, the current production behavior remains unchanged.
