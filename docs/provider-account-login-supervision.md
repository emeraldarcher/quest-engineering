# ProviderAccount login supervision

This note describes the cancellation and interaction contracts for the pinned Claude Code `2.1.292` ProviderAccount setup path. It does not authorize a login, provider request, model turn, or inference.

## Root causes

Two independent defects explained the retained setup attempt:

1. **Supervision was registered after a fallible report.** The Worker persisted and physically spawned the login process, then awaited the `invocation_acknowledged` control-plane report before adding the process to its active supervisor map. A rejected report could therefore leave an acknowledged process running without local cancellation or output supervision.
2. **The guest relay buffered short output.** The relay used `BufferedReader.read(16384)` for target stdout and stderr. A long-lived login process could write a short prompt and wait for input while that read continued waiting for more bytes. The CLI had produced the interaction, but the Worker never received it.

The fixes are independent: supervision is installed before the acknowledgement report, and the relay now uses `os.read`, which returns currently available pipe bytes.

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

The recognizer accepts only the exact opening/prompt framing and a validated HTTPS authorization URL for `https://claude.com/cai/oauth/authorize` with the pinned manual redirect, PKCE challenge method, state, client, scope, and response-type fields. Unknown framing fails closed. OAuth URLs, state, PKCE material, codes, and credentials remain in memory and use the existing encrypted ephemeral HumanAttention transport; they are never written to the setup SQLite ledger, protocol history, event details, or telemetry.

The durable HumanAttention message is semantic only. It contains no URL, code, state, or credential.

## Time boundaries

The setup path has separate bounds:

- **Spawn acknowledgement:** owned by the streamed-process backend.
- **Interaction discovery:** bounds how long the pinned prompt may remain undiscovered.
- **Human completion:** starts only after the recognized interaction is available.
- **Cancellation settlement:** bounds a synchronous read-only observation loop after a detached cancellation acknowledgement.

Expiry records an internal supervision-termination intent, performs exact cancellation, observes physical exit/gone evidence, and only then reports failure. It does not report a timeout as terminal while a process is known to remain alive.

## Exact cancellation lifecycle

Fresh Worker setup state bootstraps current-only SQLite schema `3` directly with durable cancellation operation state. Schema `2` and every other obsolete version are rejected with explicit reset guidance and are never converted in production. Worker Protocol remains `18`: no command or report shape changes, and the implementation now fulfills the existing physical-settlement meaning of `cancellation_requested`, `cancelled`, `failed`, and `uncertain`.

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

The first authorized Gate-1 dry run stopped before environment or process access because its Product SQL used the reserved `authorization` alias and the reader collapsed that query failure into missing evidence. The forensic reader now fixes the alias, requires the explicit historical database name and exact Product migration identity, and distinguishes read-unavailable, successfully-read-but-missing, and present-but-mismatched authority. It uses one repeatable-read read-only transaction and proves one authorization, acknowledged invocation, the exact cancellation request/event, zero later semantic events, and zero HumanAttention before physical inspection is callable. Product-only validation after the read fix confirms that the retained row is present but mismatched, not absent: Product remains `cancellation_requested / requested`, with no invocation acknowledgement or Product process identity. The separate Worker-v2 acknowledgement evidence does not satisfy or weaken those Product predicates. The failed diagnostic operation ID `15428ed9-f6df-4b6d-bfcd-379c7c855eb4` is not reusable; any future separately approved Gate 1 would require a new operation ID, but the known Product mismatch remains a blocker. This fix does not itself authorize or perform that rerun.

The historical process must not be described as terminal until exact read-only reconciliation proves authoritative absence or an approved cancellation is physically observed. Fresh Phase E remains blocked until then and still requires completely fresh state plus a new explicit `PROCEED`.
