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

Worker setup SQLite schema `3` adds durable cancellation operation state and preserves schema-`2` attempts through a one-way migration. Worker Protocol remains `18`: no command or report shape changes, and the implementation now fulfills the existing physical-settlement meaning of `cancellation_requested`, `cancelled`, `failed`, and `uncertain`.

1. Persist the Product cancellation request or internal supervision-termination intent.
2. Revalidate the complete setup and process identity: account, authorization/setup identity, credential/environment/invocation Worker generations, environment operation and incarnation, backend process ID, start identity, process generation, executable, owner, profile, and Worker.
3. Persist one cancellation operation ID and `requested` state before crossing the destructive boundary.
4. Prefer the still-attached handle when it matches exactly. After Worker restart, use the SBX detached path.
5. The detached SBX path revalidates the ownership-marker digest, numeric PID, `/proc` start identity, process state, and observed executable, then submits `SIGTERM` through a Linux pidfd. It never signals by PID alone.
6. Persist acknowledgement, then observe exit or authoritative absence read-only.
7. Report `cancelled` (external request) or the relevant `failed` supervision result only after physical `exited`/`gone` evidence. Identity mismatch or unavailable evidence is explicit uncertainty.

If the Worker could have crossed the cancellation boundary but did not durably record acknowledgement, it does **not** submit another signal. It performs read-only reconciliation only. A running process therefore remains `cancellation_requested` with uncertain invocation state rather than being falsely terminalized or destructively replayed.

Loss of a non-recoverable stdout/stderr attachment is also fail-closed: the Worker records supervision termination intent and exactly cancels the detached process instead of leaving it running.

## Post-merge retained-attempt reconciliation

The retained historical attempt must be reconciled only after the reviewed fix is human-merged and deployed to the same retained Product/Worker state.

1. Do not create another authorization, setup attempt, login invocation, account, or environment.
2. Let the normal Product-to-Worker reconciliation resend the already-persisted cancellation request for the exact attempt.
3. Let Worker schema `2` migrate to schema `3`; do not edit the SQLite database manually.
4. The Worker must read-only reconcile the stored environment/process handle before any cancellation submission.
5. If no cancellation submission may already have occurred, the Worker records one operation ID and invokes exact attached/detached cancellation once.
6. If submission is ambiguous, do not retry it. Continue only read-only exact-process observation.
7. Confirm physical `exited` or `gone` evidence and the truthful Product terminal state. Identity mismatch or unavailable evidence remains an explicit escalation; do not use a shell kill, PID-only signal, SBX attachment, Herdr, or provider-side workaround.

Only after that retained attempt is physically settled may a new Phase E begin from completely fresh state, and it requires a new explicit `PROCEED`.
