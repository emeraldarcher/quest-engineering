# ProviderAccount login supervision

This note describes the cancellation and interaction contracts for the pinned Claude Code `2.1.292` ProviderAccount setup path. It does not authorize a login, provider request, model turn, or inference.

## Root causes

Two independent defects explained the retained setup attempt:

1. **Supervision was registered after a fallible report.** The Worker persisted and physically spawned the login process, then awaited the `invocation_acknowledged` control-plane report before adding the process to its active supervisor map. A rejected report could therefore leave an acknowledged process running without local cancellation or output supervision.
2. **The guest relay buffered short output.** The relay used `BufferedReader.read(16384)` for target stdout and stderr. A long-lived login process could write a short prompt and wait for input while that read continued waiting for more bytes. The CLI had produced the interaction, but the Worker never received it.
3. **The account environment-operation lock covered the entire login lifetime.** `ProviderAccountEnvironmentManager.beginSetupProcess` acquired the per-account promise-tail lock before preflight but released it only from `process.exit`. Worker registration reconciles account environments before setup attempts, so reconnect reconciliation blocked behind the live generation-1 login and could not refresh setup routing before timeout settlement.

The fixes are independent: supervision is installed before the acknowledgement report, the relay now uses `os.read`, which returns currently available pipe bytes, and the account environment-operation lock ends after local durable invocation acknowledgement plus supervision registration rather than process exit.

The retained Phase-E chronology also exposed a separate Product settlement defect. At `2026-10-17T04:56:19.473Z`, Worker generation 1 reported the exact acknowledged `/opt/qe/claude/claude` process. Product rejected it as `stale_provider_account_setup_report` because the executable allowlist omitted that pinned production path. Error serialization then received `%{code: :stale_provider_account_setup_report, ...}` but accepted only `%{type: ...}`, raising `FunctionClauseError`; the channel closed at `04:56:19.490Z` and generation 2 registered at `04:56:20.142Z`. Each reconnect rewrote the attempt's sole `worker_generation`/environment operation fields, so the durable generation-1 invocation could no longer satisfy the current route and the same application-error crash repeated through generation 7. Protocol 19 fixes these independently: it allows the exact pinned executable, serializes code-shaped domain errors without raising, and separates immutable invocation ownership from current routing authority.

## Pinned Claude Code evidence

The supported interaction decoder is identified as:

```text
claude-code-2.1.292-auth-login-stdout-v1
```

Evidence extracted from the pinned `2.1.292` runtime establishes the following behavior:

| Concern | Pinned behavior |
| --- | --- |
| Invocation | QE invokes the unmodified executable as `claude auth login`. |
| TTY | The auth command uses `process.stdout.write` and a readline interface over `process.stdin`; it does not require a TTY. QE continues to use its existing non-PTY streamed-process transport. |
| `--console` | This flag selects Anthropic Console authentication rather than a noninteractive/structured output mode. It is not required for the Claude.ai subscription flow. |
| Structured mode | The auth login command has no JSON or other structured interaction mode. QE therefore recognizes one versioned native text contract rather than accepting arbitrary output. |
| Browser and callback | Claude creates a local authorization listener and constructs both an automatic localhost callback URL and a manual callback URL. It prints the manual URL, then attempts to open the automatic URL in a browser. No QE callback tunnel is required. |
| Manual completion | A stdin line is trimmed and split as `authorizationCode#state`. The OAuth flow accepts that manual code while retaining the locally generated PKCE verifier and state for token exchange. |
| Output stream | The opening text, manual authorization URL, prompt, and success line are written to stdout. Errors are written to stderr. |
| Hyperlinks | The URL formatter emits a plain URL when `process.stdout.isTTY` is false. QE's streamed process is non-PTY, so OSC hyperlink framing is not expected. |
| CLI buffering | `process.stdout.write` exposes the prompt immediately. The missing interaction was caused by QE relay buffering, not by Claude Code buffering. |

The non-PTY stdout sequence is exactly `Opening browser to sign in…\n`, `If the browser didn't open, visit: <manual-url>\n`, and `Paste code here if prompted > ` (no trailing newline on the prompt). Browser-helper success does not remove or reorder this manual fallback. A submitted stdin line is trimmed, split at `#`, and passed to `handleManualAuthCodeInput` as `authorizationCode` plus `state`; QE deliberately accepts a stricter single-`#`, bounded character framing than the native parser. Invalid native framing writes `Invalid code. Please make sure the full code was copied.\n` to stderr and continues waiting. Successful exchange writes `Login successful.\n` to stdout and exits zero; OAuth/login failures write diagnostics to stderr and exit nonzero.

The recognizer accepts only that exact opening/prompt framing and a validated HTTPS authorization URL for `https://claude.com/cai/oauth/authorize` with the pinned public client ID, exact native scope sequence, manual redirect, 32-byte base64url PKCE challenge and state, response type, query order, and bounded native optional fields. ANSI/OSC decoration (including trailing decoration), control characters, duplicate or reordered query fields, unknown framing, wrong origins, and wrong redirects fail closed. OAuth URLs, state, PKCE material, codes, and credentials remain in memory and use the existing encrypted ephemeral HumanAttention transport; they are never written to the setup SQLite ledger, protocol history, event details, or telemetry.

The durable HumanAttention message is semantic only. It contains no URL, code, state, or credential.

## Time boundaries

The setup path has separate bounds:

- **Spawn acknowledgement:** owned by the streamed-process backend.
- **Interaction discovery:** bounds how long the pinned prompt may remain undiscovered.
- **Human completion:** starts only after the recognized interaction is available.
- **Cancellation settlement:** bounds a synchronous read-only observation loop after a detached cancellation acknowledgement.

Expiry records an internal supervision-termination intent, performs exact cancellation, observes physical exit/gone evidence, and only then reports failure. It does not report a timeout as terminal while a process is known to remain alive.

## Environment-operation lock boundary

`ProviderAccountEnvironmentManager` serializes short physical environment transitions with a per-account promise tail. Setup preflight acquires that lock before validating the exact account owner, credential generation, environment ID/incarnation, authentication evidence, trusted launcher, and launch specification. Under the same lock, the coordinator durably records invocation intent, the manager launches and validates the exact process handle, and the coordinator durably records immutable invocation ownership and process identity and installs the output, timeout, exit, and cancellation supervisor.

The manager releases the lock as soon as that local acknowledgement callback returns. The release occurs before any `invocation_acknowledged` Product report and is independent of control-plane report success. Interaction discovery, HumanAttention, input delivery, human completion, process settlement, timeout handling, and cancellation settlement are owned by setup supervision and never retain this environment lock.

Releasing the lock does not release the account for mutation. The setup coordinator exposes a Worker-local predicate derived from the existing durable setup ledger. While an attempt is active or physically uncertain, environment reconciliation permits only read-only recovery of the same provider account, credential generation, backend, environment ID, and incarnation with desired state `available`. Stop, remove, credential-generation rollover, stale cleanup, and replacement identity are rejected. A missing or changed environment fails closed and is never recreated or adopted for the old invocation. The setup ledger's one-active-attempt rule independently prevents a second login; safety does not depend on lock contention.

This allows Worker registration to retain its environment-before-setup ordering. A new connection generation first recovers the exact same environment without creating or replacing it, then setup reconciliation updates mutable routing while preserving the original invocation Worker generation, environment operation, launcher authority, and process identity.

## Exact cancellation lifecycle

Fresh Worker setup state bootstraps current-only SQLite schema `3` directly with durable cancellation operation state. Schema `2` and every other obsolete version are rejected with explicit reset guidance and are never converted in production. Worker Protocol `19` separates mutable current routing (`worker_generation` and `environment_operation_id`) from nullable immutable invocation ownership (`invocation_worker_generation` and `invocation_environment_operation_id`). Once invocation intent exists, every report carries both identities. The current channel may reconcile or settle an older-generation invocation only when the complete setup, environment incarnation, process handle, executable, and immutable invocation owner all match.

1. Persist the Product cancellation request or internal supervision-termination intent.
2. Revalidate the complete setup and process identity: account, authorization/setup identity, credential/environment/invocation Worker generations, environment operation and incarnation, backend process ID, start identity, process generation, executable, owner, profile, and Worker.
3. Persist one cancellation operation ID and `requested` state before crossing the destructive boundary.
4. Prefer the still-attached handle when it matches exactly. After Worker restart, use the SBX detached path.
5. The detached SBX path revalidates the ownership-marker digest, numeric PID, `/proc` start identity, process state, and observed executable, then submits `SIGTERM` through a Linux pidfd. It never signals by PID alone.
6. Persist acknowledgement, then observe exit or authoritative absence read-only.
7. Report `cancelled` (external request) or the relevant `failed` supervision result only after physical `exited`/`gone` evidence. Identity mismatch or unavailable evidence is explicit uncertainty.

If the Worker could have crossed the cancellation boundary but did not durably record acknowledgement, it does **not** submit another signal. It performs read-only reconciliation only. A running process therefore remains `cancellation_requested` with uncertain invocation state rather than being falsely terminalized or destructively replayed.

Loss of a non-recoverable stdout/stderr attachment is also fail-closed: the Worker records supervision termination intent and exactly cancels the detached process instead of leaving it running.

## Retained schema-2 attempt

The historical acknowledged attempt and its already-persisted Product cancellation request remain unresolved outside the production schema-3 path. Its original schema-2 ledger is forensic evidence: do not migrate, reset, rewrite, or import it into a fresh Worker database. Do not fabricate a replacement setup attempt, process handle, authorization, or cancellation request.

Read-only review established that the original schema-2 runtime is not a safe cancellation path for this attempt. The acknowledged-process report interruption occurred before the old coordinator installed its active-process ownership. Without that attachment, the schema-2 cancellation path does not submit exact detached cancellation for a running process and cannot enforce schema-3 physical-settlement truth. Reconnecting or delivering the cancellation through that path could also rewrite the forensic schema-2 ledger, so it must not be used.

The isolated one-time implementation is under `workers/bun/tools/forensic/historical-claude-containment/`; production Worker code does not import it. It reads the schema-2 ledger and Product cancellation authority without modifying them; validates the exact SBX environment/incarnation, backend PID, process start identity, executable, and process generation; rejects mismatch or uncertainty; cannot launch or retry login; crosses at most one already-authorized physical cancellation boundary; and writes results only to a separate append-only journal.

Building, testing, reviewing, or merging that utility does **not** authorize even its dry-run. A future human-approved dry-run plan must precede inspection. Any signal then requires a second explicit human instruction, `EXECUTE HISTORICAL CONTAINMENT`, with the reviewed operation ID and physical-identity digest.

The first authorized Gate-1 dry run stopped before environment or process access because its Product SQL used the reserved `authorization` alias and the reader collapsed that query failure into missing evidence. The forensic reader fixes the alias, requires the explicit historical database name and exact Product migration identity, and distinguishes read-unavailable, successfully-read-but-missing, and present-but-mismatched semantic authority.

The resulting asymmetry is expected incident evidence rather than a contradiction. Worker v2 physically spawned the login and durably recorded one login-invocation intent event, one acknowledgement event, `invocation_acknowledged / acknowledged`, and the exact process handle; delivery of that report to Product was interrupted, so Product truthfully remained `cancellation_requested / requested` with no process fields when the human later requested cancellation. The one-time tool consequently assigns Product authority only for setup authorization, account/attempt ownership, and semantic cancellation request/state/event/chronology. Worker v2 is the mandatory authority for login intent, physical acknowledgement, complete historical environment/process identity, and absence of Worker-side cancellation submission. It compares every shared attempt/account/authorization/generation/Worker/environment/authentication identity before any physical call. A Product/Worker disagreement is `corroboration_mismatch`; missing or contradictory Worker physical proof is a distinct Worker-evidence failure. No Worker process field is copied into Product evidence.

A future exact-live digest commits versioned Product semantic authority, Worker-v2 physical evidence, shared corroboration, environment-ledger evidence, and the current SBX/pidfd observation. The failed diagnostic operation ID `15428ed9-f6df-4b6d-bfcd-379c7c855eb4` remains non-reusable. This correction does not run or authorize Gate 1; any future inspect-only run requires human approval and a new operation ID.

The historical process must not be described as terminal until exact read-only reconciliation proves authoritative absence or an approved cancellation is physically observed. Fresh Phase E remains blocked until then and still requires completely fresh state plus a new explicit `PROCEED`.
