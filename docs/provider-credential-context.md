# Provider credential context architecture

**Status:** accepted architecture; ProviderAccount Phases A–C implemented

**Date:** 2026-10-12

**Baseline:** `46685be1cf3641e83e8f8cc1aa13139e10a8b005` (merged PRs #35 and #36)

**Decision:** one persistent, user-scoped `ProviderAccount` in a dedicated
Worker-local provider-account SBX; unmodified Claude Code runs there and uses a
Worker-mediated tool broker to a separate Run-owned SBX. Credential bytes are
never mounted, copied, snapshotted, or proxied into a Run.

This report originally decided architecture only. ProviderAccount Phases A and
B now implement Product ownership, persistent account environments, and
account-scoped setup. Phase C implements the generic account-to-Run workspace
tool broker described in [Account-to-Run workspace tool broker](workspace-tool-broker.md).
The current Claude Agent SDK adapter and immutable execution profiles remain
unchanged, and Phase C performed no provider authentication or inference.

## Evidence labels

- **[DOC]** official Claude Code documentation retained with the pinned research
  material under `.pi/tmp/claude-mods-reassessment/docs/`.
- **[PIN]** behavior or declaration in the pinned Claude Code 2.1.292 / Agent SDK
  0.3.292 artifacts, their bundled changelog, or merged QE acceptance evidence.
- **[QE]** current merged Quest Engineering behavior or contract.
- **[INF]** an inference from the cited facts, not a provider guarantee.
- **[REC]** the architecture selected by this report.

Primary provider sources are the official [Authentication](https://code.claude.com/docs/en/authentication), [Environment variables](https://code.claude.com/docs/en/env-vars), [CLI reference](https://code.claude.com/docs/en/cli-reference), [Settings](https://code.claude.com/docs/en/settings), and [Sandboxing](https://code.claude.com/docs/en/sandboxing) pages retained in the pinned reassessment fixture. Pinned-runtime evidence also comes from Claude Code 2.1.292's bundled `CHANGELOG.md`, generated declarations, and the already-reviewed `docs/claude-harness-reassessment.md`. Current QE behavior was audited in `workers/bun/src/harnesses/claude-agent-sdk/`, the v3 wrapper, `workers/bun/src/execution-environment/sbx-run.ts`, and the merged protocol/control definitions. No source in this inventory required opening provider credentials.

## Executive decision

The Product entity is **`ProviderAccount`**. It belongs semantically to the QE
user and one provider/harness authentication method. Its current physical
credential context is assigned to exactly one Worker. It does not belong to a
Run, PhysicalLineage, workspace, project, or machine, although Worker locality
is a physical availability constraint.

The winning physical design is a **split account-cell / Run-cell topology**:

```text
local human / browser
        |
        | official login interaction; sensitive bytes are never durable QE data
        v
+-------------------------------------------------------------------+
| persistent ProviderAccount SBX (one account cell)                 |
|                                                                   |
| provider-owned CLAUDE_CONFIG_DIR                                  |
| unmodified Claude Code 2.1.292 -> Anthropic directly              |
| immutable managed QE Mod                                          |
| no Run workspace, no private Git, no general model shell/files    |
| one active Claude process for this ProviderAccount                 |
+-------------------------------+-----------------------------------+
                                |
                                | authenticated, generation-fenced
                                | workspace-tool RPC (not auth/token proxy)
                                v
                         trusted QE Worker
                                |
                                | exact Run/Action/Attempt/lineage authority
                                v
+-------------------------------------------------------------------+
| Run-owned SBX                                                     |
| private Git + PhysicalLineage workspace                           |
| workspace filesystem/search/shell tool executor                   |
| no ProviderAccount mount, file, environment value, or token       |
+-------------------------------------------------------------------+
```

The unmodified provider binary remains its own authentication client and sends
credentials directly to Anthropic. QE brokers **coding tools**, not
authentication. A Run gets an opaque, non-bearer
`ProviderCredentialContextRef`; it never gets credential bytes or a filesystem
path to them.

This design is intentionally stricter than the recommendation in the Claude
harness reassessment, which proposed mounting a protected account context into
a Run and relying on native sandbox/path denies. The mandatory fake proof for
this task established a cleaner boundary: keep the credential-bearing provider
process and every model-visible workspace tool in different OS namespaces.

## Baseline and preserved decisions

The clean baseline satisfies the requested prerequisites:

- `main == origin/main == 46685be1cf3641e83e8f8cc1aa13139e10a8b005` at
  branch creation, with a clean tree. [QE]
- PR #35 selects headless, unmodified Claude Code plus one immutable managed QE
  Mod as the future Claude harness. [QE]
- The Run-owned SBX remains the workspace, private-Git, shell, and cleanup
  boundary. [QE]
- The current subscription environment is explicit and removes API key, bearer,
  gateway, profile, federation, and cloud-provider selectors. [QE]
- The current authentication setup is Run/PhysicalLineage-bound. This report
  supersedes that **future target**, but does not modify it. [QE]
- Harness Control remains version 2. Worker Protocol v15 added credential-free ProviderAccount environment lifecycle; v16 added deterministic-fake account-scoped setup authority/reconciliation and ephemeral interaction; v17 adds only generic workspace-broker preparation/admission/retirement and safe activity. No version adds real provider authentication or credential transfer. [QE]
- Setup authorization and inference authorization remain separate. [QE][REC]
- Subscription-token proxying, API-key fallback, credential parsing, and
  modified Claude authentication remain prohibited. [REC]

## Requirements and non-negotiable invariants

1. Credential ownership remains with the end user.
2. Only unmodified provider software interprets or mutates provider credential
   contents.
3. Product/PostgreSQL, Worker SQLite, Git, private Git, workspace, protocols,
   logs, Mod storage, prompts, and tool output contain no credential bytes.
4. Model-visible `workspace.filesystem`, `workspace.search`, and
   `terminal.shell` execute in a Run SBX where the account context does not
   exist.
5. Subscription auth is selected and validated exactly; no API, cloud, profile,
   gateway, or environment fallback is accepted.
6. Credential state crosses neither a copy boundary nor a token-proxy boundary.
7. Account identity, Worker locality, environment incarnation, credential
   generation, and Run/PhysicalLineage identity remain distinct.
8. Login invocation obeys QE's commit-before-side-effect and uncertainty rules.
9. A new Run consumes readiness; it does not own or repeat login.
10. Local single-user implementation stays small while leaving explicit
    user/account/Worker keys for future multi-user and remote-Worker support.

## Claude-specific facts

### Persisted layout and selection

| Finding | Classification | Consequence |
|---|---|---|
| Linux stores credentials at `~/.claude/.credentials.json` with mode `0600`; `CLAUDE_CONFIG_DIR` relocates it. | [DOC] `authentication.md` | A Linux account SBX can give the official CLI a private canonical config root. Mode `0600` is not a model boundary when tools share the same UID. |
| macOS normally uses Keychain, falls back to `.credentials.json`, and keys the Keychain item to `CLAUDE_CONFIG_DIR`. | [DOC] | Direct host config is platform-coupled and cannot be handed safely to a Linux Run without a credential bridge or copy. |
| A config directory has its own settings, session history, and claude.ai login/API key. | [DOC] | Authentication is not the only mutable data under the root. Treat the whole root as provider-owned, opaque state. |
| `claude auth status` emits `loggedIn`, `authMethod`, `apiProvider`, and `configDirectory`, and exits 0 only when logged in. | [DOC][PIN][QE] | QE can validate safe readiness without parsing the credential file. Exact `claude.ai` is the only accepted method for this account type. |
| `/login` and `/logout` manage `.credentials.json`. | [DOC] | QE asks the official CLI to connect/disconnect; it never edits the file. |
| Credential precedence puts cloud selectors, bearer/API keys, helpers, OAuth-token environment injection, and profiles ahead of or near `/login`. | [DOC] | Every status/login/execution process needs the same explicit sanitized environment and must fail on any non-`claude.ai` selected method. |
| Login can expire and may refresh; the pinned 2.1.292 changelog includes fixes for a cross-process **login refresh lock**. | [DOC][PIN] | Ordinary authenticated operation can mutate provider state. Some refresh serialization exists, but its complete file/locking contract is not public. |
| Claude Code continuously writes session history under the config root during ordinary execution. | [DOC][PIN] | The config root is mutable even when credential bytes do not rotate. |
| `--restricted` limits setting sources and exposed tools, but built-in file tools run outside the Bash sandbox and follow permission rules. | [DOC][PIN] | A shared-UID credential mount plus path denies is defense in depth, not structural secret isolation. |
| The pinned Mod API can register tools and run a fixed local bridge process; the reassessment fixture proved those mechanisms without inference. | [PIN][QE] | A managed Mod can expose QE workspace tools whose implementation executes in the Run SBX rather than in the account cell. |

No real credential file was opened to establish these facts.

### Mutation, locking, copying, and portability

- **Ordinary mutation:** transcripts and other config state are written during
  normal sessions. Subscription login refresh may update credential state; the
  pinned refresh-lock fixes show that concurrent refresh is a real code path.
  [DOC][PIN]
- **Locking:** a login-refresh lock exists in the pinned runtime. No authoritative
  guarantee was found that every mutable config file or every credential update
  is transactionally safe for arbitrary concurrent hosted processes. [PIN]
- **Concurrent sharing:** ordinary Claude installations permit multiple
  sessions, but that does not prove QE can safely compose account generation,
  logout, refresh, crash recovery, and concurrent VM attachments. [INF]
- **Copying:** official docs support selecting a config directory, not cloning an
  authenticated directory as a deployment mechanism. A copy would fork refresh
  and revocation state. It is rejected even though a Linux file may appear
  mechanically copyable. [DOC][REC]
- **Machine binding:** no Linux machine-bound field is documented. macOS Keychain
  storage is path/platform bound. Absence of a documented Linux binding is not a
  portability guarantee, so canonical state remains on its original account
  cell disk. [DOC][INF]
- **File format:** QE does not depend on names or fields inside
  `.credentials.json`; the filename and mode are deployment facts, not a schema
  contract. [REC]

## Candidate evaluation

### Semantic scopes

| Candidate | Repeated login | Secret isolation | Refresh/revocation | Remote Worker model | Decision |
|---|---:|---|---|---|---|
| A. Run + PhysicalLineage-private | Worst | Credential is in the same VM/UID as native model tools | Many divergent contexts | Every Run repeats setup | Reject |
| B. One Run-private account context | Per Run | Better lineage sharing, same model/tool exposure | Diverges across Runs | Still Run-coupled | Reject |
| C. Persistent QE `ProviderAccount` outside Runs | Once per account generation | Can be structurally split from Run tools | One canonical state | Worker-local capability | **Choose** |
| D. User's normal host Claude config directly | Best apparent UX | Exposes unrelated host settings/history and host Keychain/config coupling | Native, but outside QE ownership fencing | Machine-only and ambient | Reject |
| E. Provider-account SBX + Run tool broker | Once per account generation | Credentials absent from Run namespace | One canonical serialized writer | Explicit Worker locality | **Chosen physical form of C** |

C is the Product decision; E is its concrete implementation.

### Persistent storage implementations

| Storage candidate | Isolation | Provider compatibility | Refresh/revocation | Complexity | Result |
|---|---|---|---|---|---|
| Host-private QE directory | Worker and any same-user host code can read bytes; mounting reintroduces Run exposure | Native Linux file layout | Shared mutation needs locks/mounts | Low | Reject |
| Dedicated long-lived credential SBX | Separate disk/namespace; host admin remains trusted | Official Linux CLI owns normal config | Canonical in-place mutation/logout | Moderate | **Choose** |
| OS Keychain-backed encrypted bundle | Strong host storage | Linux SBX Claude cannot consume host Keychain without a secret broker | Broker/copy required | High | Reject for subscription mode |
| Encrypted opaque blob | Good at rest if keys are sound | Must decrypt/materialize and merge provider mutations | Snapshot/rollback hazards | High | Reject |
| Direct provider home/config | Includes unrelated settings, plugins, history, and ambient auth choices | Native | Native | Low | Reject |
| Snapshot/template into each Run | Run-local | Not documented as supported | Divergent refresh and stale revocation | Medium | Reject |

The account SBX disk is protected by local OS/SBX ownership. QE does not promise
application-level encryption beyond the host's disk protections. A compromised
host administrator or SBX daemon is inside the current local-product trust
boundary.

### Copy vs mount vs broker

| Mechanism | Finding |
|---|---|
| Mount the same auth directory into every Run | Rejected. It makes credential bytes reachable in a shell-enabled VM, couples Runs through mutable files, and creates cross-Run corruption and teardown risk. |
| Copy/snapshot account state into a Run | Rejected. Refresh, logout, provider rotation, and account switching fork; old copies can remain usable. |
| Provider-auth/token broker | Rejected. QE would extract/intermediate subscription tokens or implement an unsupported auth client. |
| **Provider process in account cell; coding-tool broker to Run** | **Selected.** The official binary consumes canonical credentials directly. Only bounded workspace operations cross into a credential-free Run. |

The tool broker must never accept an HTTP request, provider URL, authorization
header, token, or arbitrary account-cell command. It is not a bearer-token
proxy.

## Product model

### `ProviderAccount`

A `ProviderAccount` means “this QE user connected an account usable by this
provider/harness/auth mode.” It is not a config-directory record.

Minimum durable semantic fields:

```text
ProviderAccount
  id
  qe_user_id                    # one local user initially
  provider                      # anthropic
  harness_family                # claude_code
  auth_mode                     # subscription
  safe_label                    # user-authored; optional
  state
  credential_generation
  assigned_worker_id
  physical_context_ref          # opaque Worker-owned reference, not a path
  authenticated_at
  last_validated_at
  validation_state
  environment_policy_version
  created_at / updated_at
```

The semantic owner is the user. `assigned_worker_id` is locality, not ownership.
Workspace/project scope is wrong because one account may serve many of each.
Worker or machine scope is wrong because those are replaceable execution
locations. Current UI may default to one Anthropic subscription account; IDs and
selection must not assume uniqueness so later Loadouts can select among multiple
accounts.

### Safe account identity

Correctness requires only QE's opaque account ID, provider, harness, auth mode,
selected `authMethod`, Worker locality, generation, and readiness timestamps.
Email, subscription tier, provider organization, and provider-issued account ID
are optional display metadata only if the official status surface explicitly
returns them and policy allows retention. They are never required. The current
pinned JSON `auth status` contract does not require them.

### Account lifecycle

```text
unconfigured
  -> setup_available
  -> setup_authorized
  -> setup_preparing
  -> login_invocation_requested
  -> login_invocation_acknowledged
  -> human_interaction_required
  -> validating
  -> authenticated
  -> invalid | authentication_required | inspection_unavailable
  -> reauthentication_required

authenticated
  -> revocation_requested
  -> quiescing
  -> logout_invocation_requested
  -> disconnected | revocation_uncertain
```

`forbidden_auth_method` and `incompatible_status` are fail-closed states, not
aliases for “please log in.” A setup attempt is a separate append-only
`ProviderAccountSetupAttempt` with its own attempt ID, setup generation,
authorization, process identity, side-effect certainty, HumanAttention identity,
and terminal outcome.

A successful connect/reauthenticate, account replacement, disconnect, or
administrative invalidation advances `credential_generation` monotonically.
Routine provider refresh inside the same authenticated account does **not**
advance it; it mutates canonical opaque state under the same generation. QE does
not hash secret content to detect either event.

### Conceptual Product actions

- **Connect Provider Account**: authorize and start a first official login.
- **Reauthenticate**: create a new setup attempt for a fenced existing account.
- **Validate Account**: run safe provider-owned status inspection; no model turn.
- **Disconnect / Log out**: fence new use, quiesce active use, then invoke the
  official logout/revocation flow with side-effect tracking.

These belong in user/provider settings (the Guild Hall can be the presentation
surface). They are not Run Actions or execution Attempts.

## Physical design

### Provider-account cell

For the current local product, each connected account has one durable,
Worker-local SBX environment with:

- an immutable account-cell profile (proposed identity
  `qe-claude-provider-account-v1`);
- one provider-owned Linux `CLAUDE_CONFIG_DIR` on the account-cell disk;
- the pinned, unmodified Claude Code binary;
- one immutable managed QE Mod and managed policy;
- a QE-controlled empty working directory, never a repository;
- no Run workspace, private Git repository, host home, host keychain, Docker
  socket, SSH agent, or arbitrary host mount;
- setup-time direct egress only to official login endpoints and runtime direct
  egress only to the exact official Claude endpoints;
- an account-scoped Worker control channel containing no credential bytes; and
- admission for at most one login/status/logout/Claude process at a time.

The account cell may contain provider-managed settings and session history
because Claude co-locates them under `CLAUDE_CONFIG_DIR`. Session IDs remain
bound to exact QE PhysicalLineage records, but the bytes live in the trusted
account cell rather than the Run workspace. The account cell exposes no session
listing or filesystem tool to the model. Disconnect removes/revokes credentials
through official logout but does not silently destroy retained lineage history;
separate retention/cleanup policy may remove an unused account cell only after
all referenced sessions are retired.

QE's Worker invokes structured operations but has no `readFile`/copy/export
capability for the provider root. The host OS, SBX daemon, account-cell kernel,
and official provider process can physically handle bytes as necessary. QE
Product/server, ordinary Worker business logic, Run, workspace tools, and Git
cannot.

### Run cell and tool execution

The Run retains its existing SBX, private Git, PhysicalLineage workspace,
artifacts, shell, and cleanup lifecycle. It has **no mount, file, keychain
handle, environment variable, helper, dynamic secret, or network proxy** for the
ProviderAccount.

The future managed Mod registers bounded QE-native equivalents for the resolved
semantic capabilities:

```text
workspace.filesystem -> QE read/write/edit tools
workspace.search     -> QE glob/search tools
terminal.shell       -> QE Run-shell tool
qe.completion        -> existing completion authority
human_attention      -> existing blocking attention authority
```

Native `Read`, `Edit`, `Write`, `Glob`, `Grep`, `Bash`, `Agent`, `Task`, web,
computer, MCP, and other local tools are absent unless a later architecture
explicitly proves them safe. The Mod's tool handler sends a schema-bounded
request over an authenticated account-process channel. The Worker validates the
exact ProviderAccount generation plus Run/Action/Attempt/PhysicalLineage and
forwards the operation to the Run SBX. Results return to the Mod. The model can
request a shell in the Run; it cannot request a process in the account cell.

The Mod may use its trusted `$.process` API only with hard-coded bridge argv and
bounded JSON. Model input is data to that bridge, never argv, a path in the
account cell, or a command. Exact `system/init` tool inventory, Mod hash,
managed policy, runtime hash, model, effort, permission mode, and local
zero-turn probe must pass before the real prompt.

This is structural isolation, not a string deny list. Native sandbox credential
rules and managed path denies remain defense in depth for the account process,
but acceptance does not depend on them to protect credential bytes from Run
tools.

### Why a different Unix user is insufficient

Running Claude as `qe-claude` and shell children as `qe-agent-tools` in one VM
could protect shell access, but Claude's built-in file tools execute inside the
credential-bearing process and outside its Bash sandbox. A same-process
permission bug would still have the privileged UID. Replacing all model-visible
workspace tools with brokered tools is necessary either way. Separate SBX VMs
then give simpler filesystem, process, `/proc`, socket, egress, teardown, and
cross-Run boundaries than a multi-user single VM. [DOC][INF][REC]

### SBX threat model

The Run SBX protects the host and other Runs from workspace tools. The account
SBX protects credentials from Runs and hosts only trusted provider/QE code. SBX
does not protect a secret from code intentionally running in the same VM with
read authority; therefore arbitrary model-controlled code never runs in the
account SBX. Host administrator compromise remains out of scope for the current
single-user local product.

## Trust map

| Component/state | May know credential bytes? | May know readiness/ref? | May request use? | May mutate? | May revoke? |
|---|---:|---:|---:|---:|---:|
| Local human / provider | Yes, by ownership | Yes | Yes | Through official flow | Yes |
| Host OS / SBX daemon / admin | Technically yes inside local trust boundary | Yes | Infrastructure only | Not through QE app semantics | Infrastructure only |
| QE Product/server | **No** | Yes | Authorizes semantic use | No | Records user intent |
| Worker control plane | **No application read** | Yes | Starts exact official process | No byte edits | Orchestrates official logout |
| Account-cell filesystem/kernel | Yes | Yes | N/A | Stores official writes | Enforces removal |
| Unmodified Claude login/runtime | Yes, necessarily | Yes | Direct provider use | Official refresh/login/logout | Official logout |
| Managed QE Mod | Technically capable as trusted in-process code, but explicitly prohibited/audited from reading it | Exact generation/binding only | Tool RPC | No | No |
| Run-owned SBX | **No** | Opaque generation-fenced ref only | Workspace work only | No | No |
| Model-visible tools | **No** | No account path/ref required | Bounded Run operations | Run workspace only | No |
| Workspace/private Git | **No** | No | N/A | Run changes only | No |
| PostgreSQL/Worker SQLite/logs | **No** | Safe metadata only | N/A | State machine only | Records outcome |

`ProviderCredentialContextRef` is not a bearer credential. Possession alone
grants nothing. Use also requires the authenticated Product dispatch, exact
Worker/account environment incarnation, current generation, current Run/Action/
Attempt/lineage authority, and an admitted account lease.

## Current Agent SDK credential-access audit

Current v3 places `CLAUDE_CONFIG_DIR` at a lineage-private path under
`/qe/state/claude-lineages/.../config` and runs the wrapper, Claude Code, and
tools as the same guest identity. The wrapper keeps workspace and config paths
disjoint and configures:

- Bash sandbox `denyRead`/`denyWrite` plus credential-file denies;
- no unsandboxed retry and fail-if-unavailable;
- permission denies for the config/control paths;
- a `PreToolUse` containment check for native file/search tools; and
- exact environment sanitization. [QE]

Therefore the expected Bash path is kernel-sandbox denied, and native file tools
are policy denied. However the credential file is mode `0600` for the **same OS
identity** as Claude Code; built-in file tools run in that credential-bearing
process. There is no separate account namespace or UID boundary. [DOC][QE]

**Finding:** the current code has layered deny controls, not an intentional
normal-path credential read. It nevertheless has a structural exposure
weakness: compromise/bypass in the native file-tool/permission layer has the OS
authority to read credentials. The split-cell design removes that authority
from every model-visible workspace tool instead of preserving the weakness.

## Login and setup

### Login location and Run relationship

Official `claude auth login` runs in the dedicated account SBX against its
canonical config root. It receives no repository, Run, private Git, model
prompt, model tools, or inference authorization. Login does **not** create or
require a Run, Action, execution Attempt, or PhysicalLineage.

The current non-PTY login compatibility question remains unproven because this
research correctly invoked no login. Implementation must support the official
browser/code-paste flow in the account cell and prove whether the pinned command
needs a PTY under a separately authorized real-login gate. If it needs one, use
an account-scoped, no-log PTY—not Herdr and not a fake Run.

### Setup authorization vs inference authorization

- `provider_account_setup` authorization permits one exact current setup attempt
  to cross the official login side-effect boundary.
- `model_inference` authorization permits one exact Product model execution only
  after account and Run readiness.

A valid existing account consumes no new setup authorization when a Run is
created. Reauthentication always needs a new setup authorization. No setup
authorization implies inference authority, and no inference authorization
implies login authority.

### HumanAttention and sensitive setup I/O

The durable blocking HumanAttention lifecycle should carry only safe messages
such as “complete official provider sign-in,” request identity, cancellation,
and safe completion status. It must not persist an auth URL, redirect, one-time
code, email, token, or raw provider output.

If the official container flow requires a pasted code/redirect, an account-
setup-scoped ephemeral no-log channel writes it only to the exact live login
process. It is bounded, expires with that process generation, and is never put
in Product/PostgreSQL, Worker SQLite, HumanAttention response values, logs, or
replay state. Worker restart expires the channel. Durable HumanAttention can
then acknowledge that human action was requested/completed without becoming a
credential store.

The existing Action-bound HumanAttention tables/control descriptor cannot be
reused by pretending setup has a Run. A future account-scoped command should
reuse its delivery-attempt, cancellation, stale-response, and uncertainty
semantics with `ProviderAccountSetupAttempt` identity.

### Side-effect certainty and recovery

For every setup attempt:

1. persist setup authorization;
2. persist login intent as `not_submitted`;
3. commit `invocation_requested` immediately before process spawn;
4. record physical spawn acknowledgement as `acknowledged`;
5. project safe HumanAttention;
6. observe process settlement;
7. run exact local status validation;
8. commit authenticated state and advance credential generation.

Known-not-submitted may accept a **new** explicit setup authorization. An
ambiguous invocation is never replayed automatically. Failure after an
acknowledged process is terminal for that setup attempt; a human may authorize a
new attempt after explicit inspection/recovery. Restart never fabricates
continuity with a lost login process.

## Run preparation and scheduling

For a new Claude Run:

```text
resolve Loadout and optional/default ProviderAccountRef
  -> select Worker that has exact runtime + account context
  -> validate account state and generation (no model query)
  -> provision credential-free Run SBX/private Git
  -> bind Run to opaque ProviderCredentialContextRef
  -> validate tool-broker route and immutable artifacts
  -> needs_confirmation
  -> persist inference authorization
  -> queue for the account's exclusive provider-process lease
  -> revalidate generation/readiness/authorization
  -> start unmodified Claude Code in account cell
  -> zero-turn Mod/runtime/tool probe
  -> submit the real prompt once
```

A Run prepared against generation `g` fails/re-prepares if the account is now
`g+1`; it never silently follows an account switch. Readiness timestamps are
advisory and must be revalidated at the process boundary.

Scheduling has three independent inputs:

1. immutable harness/runtime capability on a Worker;
2. exact ProviderAccount availability/generation on that Worker; and
3. provider/model capability/availability.

A Worker advertises only safe account availability, never global “Claude is
authenticated” and never secret material. A ProviderAccount available on Worker
A is unavailable on Worker B unless the user explicitly connects an account
there. No credential sync is implied.

## PhysicalLineage and multiple Runs

Authentication identity is independent of PhysicalLineage. Multiple lineages in
one or many Runs can reference the same ProviderAccount generation. Native
session/transcript identity remains PhysicalLineage-owned and exact; account
sharing does not authorize cross-lineage resume.

Initial implementation admits **one provider/login/status/logout process per
ProviderAccount**. Multiple Runs may be prepared or queued concurrently, but
actual Claude processes serialize. This is deliberately conservative:

- it prevents concurrent refresh/logout/write races;
- every process sees the one canonical state left by its predecessor;
- there are no snapshots to merge or roll back; and
- provider policy/rate limits remain separate from filesystem safety.

A later increase above one requires provider-version-specific proof of refresh,
all mutable config writes, logout, crash recovery, and session separation. The
presence of a pinned login-refresh lock alone is insufficient.

## Refresh, generation, and stale consumers

The official Claude process refreshes canonical provider state in place while it
holds the exclusive account lease. The Worker neither observes token fields nor
copies updated files. The next process opens the same canonical state after the
previous process exits, so refresh propagation is immediate and has no
last-writer-wins merge.

Credential generation is an explicit QE lifecycle epoch, not a digest or file
revision. Refresh within the same account retains the generation. Login,
reauthentication, account replacement, logout/disconnect, and administrative
invalidation advance it. A queued or prepared stale consumer fails before
process start and must return to readiness resolution; it never receives a new
account implicitly.

## Validation and subscription-only enforcement

Safe validation runs the pinned unmodified `claude auth status` in the account
cell with the exact account config directory and sanitized environment. The
account-scoped states are:

- `authenticated` only for exit 0, `loggedIn: true`, exact `claude.ai`, exact
  `firstParty`, exact config identity, and the complete pinned 2.1.292 shape;
- `authentication_required` only for exit 1, `loggedIn: false`, exact `none`,
  exact `firstParty`, and the complete pinned 2.1.292 shape;
- `forbidden_auth_method` for any API key, helper, OAuth environment token,
  profile, cloud, gateway, or third-party selection;
- `inspection_unavailable`; and
- `incompatible_status` for malformed, contradictory, unknown, or wrong-context
  output.

Local status does not prove every provider-side revocation before a request. No
documented subscription account-resource endpoint is assumed. If the provider
later documents a no-inference validation operation, it may be added under an
explicit protocol contract. Provider rejection on the first authorized request
invalidates readiness without retrying or selecting another billing method.

Every status/login/execution process starts from an allowlisted environment.
At minimum it excludes the current forbidden selectors:

```text
ANTHROPIC_API_KEY
ANTHROPIC_AUTH_TOKEN
ANTHROPIC_BASE_URL
ANTHROPIC_PROFILE
ANTHROPIC_IDENTITY_TOKEN_FILE
ANTHROPIC_FEDERATION_RULE_ID
ANTHROPIC_ORGANIZATION_ID
ANTHROPIC_AWS_WORKSPACE_ID
CLAUDE_CODE_OAUTH_TOKEN
CLAUDE_CODE_USE_BEDROCK
CLAUDE_CODE_USE_VERTEX
CLAUDE_CODE_USE_FOUNDRY
CLAUDE_CODE_USE_ANTHROPIC_AWS
```

The binary retains its built-in official authentication mechanisms. QE does not
patch or turn it into a subscription-only binary; QE configures this particular
ProviderAccount as subscription-only, validates the selected method, and fails
closed on any other method.

## Logout and revocation

Disconnect performs these steps:

1. commit `revocation_requested` and advance/fence the account for new use;
2. reject queued and not-yet-started processes;
3. request cancellation of an active provider process;
4. prove the exact process is inactive, or remain `revocation_uncertain`;
5. invoke official logout exactly once under the exclusive account lease;
6. commit its known outcome and validate `authentication_required/none`;
7. retain safe audit/session references according to retention policy.

QE does not promise that cancellation retracts a provider request already
accepted. It reports uncertainty. It does not replay an ambiguous logout. A
provider-side revocation performed by the user independently is detected by
validation or provider rejection and advances/fences readiness when observed.

## Persistence and restart

### Product/PostgreSQL

Store semantic account/setup records, IDs, state, safe label, auth mode,
generation, Worker assignment, safe physical ref, authorization and
side-effect ledger, timestamps, validation classification, and optional safe
provider metadata. Never store config paths exposed to clients, raw status
output, auth URLs/codes, provider stdout, credentials, tokens, or config bytes.

### Worker SQLite

Store exact ProviderAccount ID, Worker and account-environment ref/incarnation,
profile/policy identities, credential generation, safe validation state,
exclusive-admission state, setup attempt/process certainty, account-scoped
HumanAttention delivery facts, Run bindings, and restart reconciliation facts.
Store no secret, hash of a secret, copied config, auth URL/code, or provider
response body. Greenfield implementation should create one current schema
without legacy Run-auth migration.

### Restart behavior

- **Worker restart:** recover only the exact persisted account environment
  incarnation. Revalidate local status and generation before new use. An
  attached-only in-flight process follows existing process-loss uncertainty and
  is never replayed.
- **Product restart:** rebuild account/setup projections from PostgreSQL and
  Worker safe reports; no secret recovery is needed or possible.
- **Host restart:** recover the retained account SBX disk and exact identity. If
  exact recovery cannot prove the same environment, mark the account
  `reauthentication_required`; never reconstruct credentials from Product data.
- **Account cell missing/corrupt:** fail closed and require explicit user
  reconnect. Do not fall back to host Claude config.

Automatic cloud backup or cross-Worker credential sync is out of scope. A local
system backup may physically contain the SBX disk under the user's host security
policy; QE does not export a portable credential bundle.

## Protocol consequences

Worker Protocol v18 implements account inventory, canonical provider-neutral
authentication observations, exact Product authorization evidence, immediate
pre-login reinspection, account-scoped safe HumanAttention, ephemeral interaction
correlation, environment/process identity, and setup lifecycle/reconciliation.
It also carries separately versioned `workspace_tool_broker_v1` account-to-Run
binding and safe activity messages. Authentication evidence is bound to the
physical account cell plus versioned configuration and environment policy;
already-authenticated, forbidden, unavailable, incompatible, stale, or mismatched
preflight never becomes login intent.

Harness Control 2 remains unchanged. Account setup is not overloaded with Run or
broker semantics, and the account/Run tool transport remains separate from
Harness Control and credential semantics.

Current `HarnessSetupContext` should be:

- removed from Claude authentication;
- retained/narrowed for genuinely Run-scoped non-auth setup and deterministic
  Run harness preparation; and
- replaced for authentication by first-class `ProviderAccountSetupAttempt`.

`authorize_harness_setup` may remain for other harnesses, but Claude account
login uses an account-scoped authorization. No fake Run should be manufactured.

## Claude Code + QE Mod v4 consequence

The future adapter consumes the account as follows:

1. resolve the exact `ProviderAccountRef` and generation;
2. prepare the credential-free Run SBX and workspace tool endpoint;
3. after inference authorization and account admission, start unmodified Claude
   Code in the account cell;
4. pass only safe binding/generation/control descriptors, never credentials;
5. load one immutable managed Mod;
6. expose only brokered QE tools;
7. perform the zero-turn local Mod/tool/runtime probe;
8. submit the authorized prompt once; and
9. bind native session identity to the PhysicalLineage.

Recommended immutable profiles are:

- `qe-claude-provider-account-v1`: pinned Claude binary, managed QE Mod, managed
  settings, bridge, direct provider egress, and account-cell policy; and
- `qe-coding-execution-v4`: Run-side workspace tool executor/control assets and
  existing private-Git isolation.

Credential bytes and mutable account state are in neither profile. Existing v3
remains immutable historical evidence.

## Current Agent SDK disposition

Do not delete anything in this task. After ProviderAccount and v4 parity are
accepted, remove SDK-specific production pieces:

- `claude_agent_sdk` adapter registration;
- Agent SDK package/runtime and wrapper from the active replacement profile;
- wrapper protocol/binding/query startup code;
- Run-bound Claude auth/setup and lineage-private `CLAUDE_CONFIG_DIR` plumbing;
- SDK-specific MCP completion/permission callbacks; and
- SDK-specific tests replaced by account-cell/Mod/tool-broker tests.

Retain or extract generic infrastructure:

- explicit environment sanitization and exact auth-status classification;
- setup vs inference authorization;
- side-effect certainty and non-replay;
- streamed process identity/reconciliation;
- durable blocking HumanAttention and delivery certainty;
- structured completion and prompt lifecycle;
- Run-owned SBX, private Git, PhysicalLineage, cancellation, and recovery;
- native session refs, model/effort/tool attestation, and audit evidence.

Historical SDK decision and acceptance documents remain history, marked
superseded where appropriate rather than deleted.

## Prior onboarding pain

| Historical issue | Account-scoped result |
|---|---|
| Setup capability lifecycle coupled to a Run | Eliminated structurally; account setup is first class. |
| Per-Run/lineage `CLAUDE_CONFIG_DIR` | Eliminated; one canonical account context. |
| Repeated fresh `PROCEED`/setup authorization for each Run | Eliminated when account is valid; one authorization per connect/reauth attempt. |
| API-key sentinel selected forbidden billing | Remains a generic environment-policy defect, but is fixed once for the account cell and checked on every process. |
| Setup cwd outside streamed-process containment | Eliminated as a Run-worktree problem; account setup uses a fixed account-cell cwd. Generic cwd validation still matters. |
| Login invocation known-not-submitted vs ambiguous | Remains; side-effect certainty is generic and still mandatory. |
| Login output/HumanAttention transport | Remains a one-time/re-auth setup concern rather than a per-Run concern. |
| Pinned login PTY compatibility | Remains unproven until one explicitly authorized real-login acceptance. |
| Wrong auth method or expired/revoked account | Remains and is handled account-wide. |

## Security comparison

Scores are 1 (poor) through 5 (best). Security dominates convenience.

| Criterion | Per-lineage credentials | Shared directory mounted into Runs | Direct host credentials | **Split ProviderAccount cell** |
|---|---:|---:|---:|---:|
| Model secret isolation | 2 | 1 | 1 | **5** |
| Host secret minimization | 4 | 3 | 1 | **4** |
| Cross-Run isolation | 4 | 1 | 1 | **5** |
| Revocation correctness | 2 | 4 | 4 | **5** |
| User experience | 1 | 4 | 5 | **4** |
| Provider compatibility | 5 | 4 | 5 | **5** |
| Filesystem concurrency | 4 | 2 | 3 | **5** (serialized) |
| Refresh correctness | 2 | 3 | 5 | **5** (canonical) |
| Remote Worker clarity | 1 | 2 | 1 | **4** |
| Implementation simplicity | 4 | 3 | 5 | **2** |
| **Security-weighted decision** | Reject | Reject | Reject | **Choose** |

The selected design pays for a tool broker and second environment scope. That
cost is justified because neither `0600`, “outside workspace,” nor Mod path
checks can structurally protect a credential from arbitrary shell/file tools in
the same VM.

## Fake proof

Retained fixture: [`spikes/provider-credential-context/`](../spikes/provider-credential-context/).

Command:

```sh
bun test spikes/provider-credential-context/proof.test.ts
```

Observed result on the research host: **6 passed, 0 failed, 25 assertions**.
The fixture uses only
`QE_FAKE_CLAUDE_CREDENTIAL_DO_NOT_USE_7c11f6f9`.

### Secret isolation

- `workspace.filesystem` read accepted a Run file and rejected an absolute
  account credential path before access.
- `workspace.search` found Run content and returned no credential canary.
- Lexical and symlink escapes from `workspace.filesystem` were both rejected.
- macOS `sandbox-exec` default-denied file access, allowlisted only the Run
  workspace and OS runtime files, and successfully ran `cat` on the Run file.
- The same shell, given either the exact known account credential path or a
  workspace symlink to it, exited nonzero and emitted no canary.
- The shell environment contained only `HOME`, `LANG`, `PATH`, and `TMPDIR`; no
  account ref/path/secret was injected.

The physical test is a local kernel-policy analogue, not a claim that macOS path
rules equal SBX. Production is stronger: the account and Run are separate VMs,
so the account path is absent. Linux/CI must gain an equivalent separate-
namespace physical gate rather than treating the Darwin-only test as universal.

### Refresh and concurrency

Two consumers entered concurrently. The account cell admitted Run A at fake
revision 0, held Run B out, committed A's refresh to revision 1, then admitted B
at revision 1 and committed revision 2. This revision is fixture-only observability;
production does not inspect provider files or count refresh writes. The exact
event order proved one canonical state, no snapshot, no lost update, and no
rollback. Account
replacement advanced generation 1 -> 2 and rejected the stale reference without
hashing secret bytes.

### Restart and revocation

Fresh Worker/Product/host-process model objects reconstructed against the same
fake account-cell disk. Identity, readiness, generation, and revision survived;
the serialized Product projection did not contain the canary. Disconnect
advanced generation, projected `authentication_required/none`, rejected stale
use, and rejected current-generation use while not ready.

This is deterministic architecture evidence. It is not a live SBX daemon/host
restart, real Claude refresh, or provider revocation proof. Those belong to
later gated phases.

## Implementation phases and gates

Every phase is a separate PR with a human merge gate. No phase starts merely
because the previous PR exists.

1. **A — Domain and account environment:** add `ProviderAccount`, setup attempts,
   clean persistence schemas, safe projections, account-owned SBX lifecycle,
   exclusive admission, fake provider only, and restart/revocation tests.
2. **B — Account setup control:** add setup authorization, account-scoped durable
   HumanAttention, sensitive ephemeral input, official-command abstraction,
   side-effect certainty, cancellation, and fake login/status/logout.
3. **C — Run tool broker:** implement strict workspace filesystem/search/shell
   schemas from account process to Worker to Run SBX; prove namespace, symlink,
   environment, process, output, cancellation, and stale-generation fencing with
   fake provider state.
4. **D — Claude Code + QE Mod:** build immutable account-cell profile and Run v4
   assets; expose only brokered tools; add static/pinned Mod tests. Still no real
   login or inference.
5. **E — Zero-inference acceptance:** pinned binary/status/init-only/local probe,
   exact tool inventory, environment and network gates, fake credential canary,
   account/Run restart, and zero provider model requests.
6. **F — One real account login:** separate explicit human authorization; prove
   official login transport, status, logout/reconnect, canonical refresh
   behavior where safely observable, and zero model turns.
7. **G — One paid Claude Attempt:** separate explicit inference authorization;
   validate completion, HumanAttention, cancellation, continuation, usage, and
   no secret exposure.
8. **H — Retire SDK path:** only after parity and human acceptance; remove the
   superseded production adapter without dual-mode compatibility.

Before implementation, obtain the policy/legal sign-off already identified in
the reassessment for the intended local/hosted distribution model.

## Remaining risks and decision gate

The architecture has no unresolved requirement to expose credentials to model
or Run tools. These implementation/acceptance risks remain:

1. prove the pinned official login's PTY/browser-code behavior in the new account
   cell under explicit real-login authorization;
2. prove that the pinned headless CLI with exact custom Mod tools exposes no
   unbrokered native local tool or server feature;
3. build a tool broker with full shell streaming/cancellation/path/symlink/output
   discipline without becoming an arbitrary account-cell command channel;
4. physically prove separate account/Run SBX recovery across Worker and host
   restart; and
5. retain legal/policy approval for hosted unmodified Claude Code with each end
   user's own subscription.

These are staged gates, not reasons to choose a weaker credential mount.
Implementation Phase A is ready to begin **only after human merge of this
research PR**. Claude v4, real login, and provider inference are not authorized
by that merge.

## Zero-side-effect accounting

| Activity | Count |
|---|---:|
| Claude login invocations | **0** |
| Real credential reads | **0** |
| Real credential copies/imports | **0** |
| Credentials created | **0** |
| Product inference authorizations | **0** |
| Claude model turns | **0** |
| Agent SDK `query()` calls | **0** |
| Provider inference requests | **0** |
| Production profile/protocol/account changes | **0** |

Only documentation and the isolated fake proof fixture are retained.
