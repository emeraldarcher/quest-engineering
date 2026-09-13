# Human-operated Pi conversational-takeover acceptance

This fixture intentionally invokes a real provider and is never part of automated tests.

## Prerequisites

- Herdr 0.8.2 and Pi 0.84.x are installed and authenticated by the human.
- `herdr integration install pi` installed the official Pi state integration.
- Phoenix migrations are current.
- Tauri, Phoenix and the Worker run on the same macOS host.
- Use a development/staging database and repository only.
- Do not run this as an automated gate or without explicit approval for provider use.

## Configuration

Start Phoenix with local native attachment enabled:

```sh
QE_LOCAL_SESSION_ATTACH_ENABLED=true mix phx.server
```

Start the Worker normally with a stable `QE_WORKER_ID`, stable data root, writable Project binding, and Pi provider. Relevant values are:

```sh
QE_WORKER_PROVIDER=pi
QE_MAX_CONCURRENCY=1
```

For the concurrency case, restart it with:

```sh
QE_WORKER_PROVIDER=pi
QE_MAX_CONCURRENCY=2
```

Start the local Tauri client. Browser clients cannot attach and must show that limitation truthfully.

## Human Takeover Acceptance Tactic

Create this reusable **development-only** Tactic through normal War Room semantic authoring. Do not add it to starter onboarding or model it with a Product test flag.

```text
Human Takeover Acceptance
└─ Sequence
   ├─ Implement — Builder, fresh context
   │  produces: change_set
   └─ Review — Reviewer, fresh context
      consumes: change_set from Implement
      produces: verdict
```

The semantic preview must read `Implement → Review`. The long choreography belongs in Step details, not the Tactic name/description or Quest intent.

Use this exact **Implement Step instruction**:

```text
Before making any repository changes, immediately call
qe_request_human_assistance by itself with:

  category: needs_input
  interaction: conversational_intervention
  message: Choose a filename and file contents with the Builder.

This is a conversational takeover acceptance step. Do not use confirmation,
a structured yes/no prompt, an input dialog, or a modal editor. Yield the
current automated Pi run so the human has the ordinary Pi prompt and can use
normal multi-turn chat and the tools available to that session.

Wait for the human to explicitly run /qe-resume. Do not interpret ordinary
chat, words such as "continue" or "done", or terminal activity as hand-back.
After /qe-resume, use the guidance retained in this Pi session to create the
selected harmless file and complete normally through qe_step_result with a
change_set.
```

Use this **Review Step instruction**:

```text
Review the implementation against the Quest requirements and produce the
normal verdict.

Do not deliberately invoke the conversational-takeover acceptance trigger.
Request human assistance only if an actual unrelated blocker requires it.
```

Create the acceptance Quest with ordinary intent only:

```text
Create a harmless test file according to the instructions you receive during
implementation.
```

Do **not** place forced-yield wording in the Quest objective. Quest intent is shared with every semantic Step; Step execution choreography is local to that Step.

## Multi-turn flow

1. Launch the Quest and wait for the Pi session to yield.
2. Verify all attention surfaces identify the same Member and Step:
   - HUD Needs Attention count;
   - in-app attention toast;
   - native notification, if OS permission was granted;
   - Work Yard card: `Pi · Waiting for you` and **Take Control**.
3. Record from Work Yard Technical details:
   - QE Attempt ID;
   - session/lineage ID;
   - Worker ID;
   - Herdr target and terminal ID where locally inspectable.
4. Optionally use **Open Session** first. It must be observation-only and must not clear attention.
5. Choose **Take Control**. Confirm the exact existing session opens via Herdr `--takeover`.
6. Verify the ordinary Pi prompt/editor is visible. A Yes/No selector, input dialog, editor modal, or pending tool UI is a failure.
7. Have at least two ordinary Pi exchanges:

   ```text
   Human: Use human-picked.txt
   Pi: <normal conversational response>

   Human: Why were you blocked, and does this preserve the public API?
   Pi: <normal conversational response>
   ```

8. Detach or close the terminal without resuming. Verify the Attempt remains running and attention remains. Reopen the same session with **Take Control**.
9. At the ordinary Pi prompt, enter exactly:

   ```text
   /qe-resume
   ```

10. Verify Pi receives the minimal QE resume instruction, applies guidance already in the retained conversation, creates only `human-picked.txt`, and completes normally.
11. Verify attention clears only after automation starts again.
12. Verify session history shows human control starting and explicit hand-back/automation resume without any chat text.
13. Compare Builder identities before and after. All must remain unchanged:
   - QE Attempt and StepOccurrence;
   - logical Member and Worker slot;
   - worktree;
   - harness lineage/session projection;
   - Herdr session, target, pane and terminal;
   - Pi native session ID/path and process PID.
14. Verify the Builder has one dispatch, one Attempt, no retry, and one nonce-bound final result.
15. Wait for Review to start. Verify its resolved Step instruction is the normal Review instruction, its inputs include the Builder `change_set`, and its Quest objective remains the same ordinary intent.
16. Verify Review uses the Reviewer Member with a fresh logical lineage and a different Pi/Herdr session from the Builder.
17. Verify the Reviewer does **not** deliberately repeat the acceptance takeover and completes normally. A genuine unrelated blocker may still create HumanAttention.
18. Verify the complete fixture produced exactly one deliberate acceptance-test HumanAttention episode: the Builder intervention. There must be no artificial Review intervention.

If Review repeats the deliberate takeover, stop. Inspect resolved Step instructions, context selectors, logical lineage/session binding, artifacts, launch snapshot, and Class instructions. Do not hide instruction or session leakage with a stronger Reviewer prohibition.

## Proactive escalation without forced choreography

Use an ordinary writable Implement Step and this materially underspecified Quest objective:

```text
Create a harmless test file according to the instructions you receive during implementation.
```

Provide no filename or contents in the Step, artifacts, repository, or Class instructions. Verify Pi follows the harness escalation policy rather than inventing them: it requests conversational intervention, the human supplies both values through at least two normal turns, and `/qe-resume` completes the same Attempt. Repeat with an ordinary internal implementation choice and verify Pi uses responsible engineering judgment without escalating.

## Reactive retained-session recovery

1. Use a controlled operational failure classified `operator_recovery_required`; do not use a rejected Review verdict.
2. Verify the failed Attempt and its retained Pi session appear in Work Yard.
3. **Inspect Session** must not create an Attempt, reopen execution, or consume allowance.
4. Choose **Help & Retry**, discuss and correct the failure in the exact retained session, then try `/qe-resume`. It must explain that no live intervention exists and direct the human to `/qe-retry`.
5. Run `/qe-retry`. Verify Phoenix authorizes one new human recovery epoch and scheduling reacquires the Member, Worker slot, context, and worktree normally.
6. Verify the same StepOccurrence and retained Pi/Herdr lineage continue with a new globally numbered QE Attempt shown as `Human recovery 1 · Attempt 1 of 2`.
7. Verify the failed prior Attempt remains visible and unchanged. Repeating `/qe-retry` with the same pending request must not create another epoch.
8. If the retained session is unavailable or its Pi identity cannot be proven, verify retained recovery fails closed. Use the explicit **Retry with fresh session** action and verify QE does not claim conversation continuity.
9. An uncertain Attempt must expose only the existing uncertainty-resolution controls; neither automatic retry nor `/qe-retry` is allowed.

## Worker restart while yielded

1. Reach conversational intervention and record the identities above.
2. Stop only the Bun Worker. Do not stop Herdr, Pi, Phoenix, or the Tauri client.
3. Leave the terminal detached or continue ordinary Pi conversation.
4. Restart the Worker with the same ID, data root and Herdr session.
5. Verify recovery uses SQLite plus `session.snapshot`/`agent.get`, returns the same lineage/session to waiting-for-human, and does not launch Pi.
6. Reattach and run `/qe-resume`.
7. Verify the original dispatch completes once and occupancy was retained throughout.
8. If the exact Herdr/Pi session was removed, verify the session becomes unavailable while attention remains truthful; no replacement session may be created.

## Concurrency

1. Run with `QE_MAX_CONCURRENCY=2`.
2. Launch two independently eligible Actions. Session A must request conversational intervention; Session B must continue ordinary automation.
3. Verify A remains blocked/occupied while B continues and can complete.
4. Chat with A for multiple turns and detach once. B must remain unaffected.
5. Run `/qe-resume` in A and verify only A resumes.
6. Confirm neither session ID, Member assignment, Attempt, or worktree crossed between Actions.

## Generic Herdr-blocked and structured confirmation regression

- A Herdr-native blocked prompt without the QE tool still creates one generic `interactive_prompt` attention with `Pi is waiting for input`; no terminal prose is copied.
- `idle`, `working`, initial `unknown`, and quiet duration do not create attention.
- Simple `interaction: confirmation` still presents `Completed` / `Cannot complete` and continues the same Attempt after resolution.
- Generic prompts do not claim conversational resume capability unless the active harness advertises it.

## Detection and privacy boundary

Herdr remains authoritative for `idle | working | blocked | done | unknown` through `agent.wait`, `agent.get`, and `session.snapshot`. The QE checkpoint and `/qe-resume` are structured Pi harness signals. QE never parses chat for “continue,” “done,” or similar prose, and never regex-scans terminal output.

QE persists only attention identity/reason, interaction/control state, attachment mode, hand-back, and automation-resumed timestamps. Inspect Product API responses and audit rows and verify they contain no human messages, Pi replies, terminal transcript, keystrokes, credentials, or native session paths.
