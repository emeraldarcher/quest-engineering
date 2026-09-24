# Manual Antigravity strategy probes

These are historical, diagnostic-only human-operated procedures from the host-native strategy work. They are not the production launch path and grant no authority to change it. Current profile provenance is `agy 1.2.7`; the scripts still refuse to run unless `QE_RUN_SUBSCRIPTION_PROBE=1` is explicitly set. Quest Engineering does not run them as automated tests.

The procedures use isolated directories under `.pi/tmp/antigravity-human-probes/`. Production instead owns MCP registration in `qe-coding-execution-v1` and installs the namespaced hook in the lineage-private guest HOME; no operator should register or merge host-global production configuration.

Run commands from the repository root.

## A. Stop-hook continuation

Expected inference consumption: **at most two tiny model cycles**—the initial response and one forced continuation. The generic control authority allows exactly one missing-result continuation; the second Stop invocation is allowed to terminate with a bounded contract violation.

The original `--prompt-interactive` form was rejected after evidence showed that it can submit the initial prompt before asynchronous workspace-hook loading. The corrected probe starts an unprompted TUI in Herdr, verifies the native `/hooks` Stop screen, executes synthetic PreInvocation and Stop payloads through the generic bridge, rotates that synthetic control context, and only then submits the paid prompt.

Use the already trusted workspace from the first probe so no project-trust gate can race hook loading:

```bash
export QE_ANTIGRAVITY_STOP_PROBE_WORKSPACE="$PWD/.pi/tmp/antigravity-human-probes/stop-hook-2026-09-12T06-34-24-163Z-9861d8f9/workspace"
```

The zero-inference preflight command is:

```bash
bun run workers/bun/scripts/manual/antigravity-stop-hook-probe.ts preflight
```

It has already passed against this workspace. The bounded paid rerun is:

```bash
QE_RUN_SUBSCRIPTION_PROBE=1 \
  bun run workers/bun/scripts/manual/antigravity-stop-hook-probe.ts
```

The effective native launch is now deliberately unprompted:

```bash
agy \
  --model gemini-3.8-flash-low \
  --log-file <evidence-directory>/agy.log
```

The initial prompt is submitted through Herdr only after the same native TUI passes the zero-inference preflight.

The first Stop response injects this unmistakable continuation instruction:

```text
QE_STOP_HOOK_CONTINUATION_PROBE: This is the one permitted forced continuation.
Reply with exactly QE_STOP_HOOK_REENTERED, do not call tools or modify files,
and then stop.
```

Expected evidence:

- visible `QE_STOP_HOOK_INITIAL_CYCLE` response;
- visible `QE_STOP_HOOK_REENTERED` response;
- one Stop output with `decision: "continue"` and the probe marker;
- at least two `PreInvocation` events;
- a second Stop event whose output is `{}`;
- one native `conversationId` across the hook events;
- final process exit code.

The script terminates the TUI after the second Stop boundary and records its final Herdr state. To abort, press **Ctrl+C**, or run the exact emergency `herdr agent send-keys … ctrl+c ctrl+c` command printed by the script from another terminal. The continuation count cannot exceed one even if the model omits a QE result again.

Copy back:

1. both visible marker lines;
2. the complete `Probe summary` JSON block;
3. if the summary is unexpected, the printed `Full hook evidence` path and the relevant records from `hook-events.jsonl`.

## B. Headless → interactive → headless continuity

Run this procedure **inside an attached Herdr shell**. `HERDR_SOCKET_PATH`, `HERDR_WORKSPACE_ID`, and `HERDR_SESSION` are supplied by Herdr. Do not manually fabricate them.

Expected inference consumption for a fresh probe: **exactly three tiny model turns**—one initial headless turn, one human-authored interactive turn, and one final headless recall turn.

```bash
QE_RUN_SUBSCRIPTION_PROBE=1 \
  bun run workers/bun/scripts/manual/antigravity-hybrid-probe.ts
```

The retained `falcon-643832` attempt cannot proceed directly to final recall because native structured evidence shows that its interactive user message was accidentally `QE_HYBRID_HEADLESS_1_ACK`, not the required `cedar-f9c4c1` handoff. To preserve its existing conversation ID while correcting that handoff, recovery mode skips headless turn 1 and performs exactly two additional turns:

```bash
QE_RUN_SUBSCRIPTION_PROBE=1 \
QE_HYBRID_RESUME_EVIDENCE="$PWD/.pi/tmp/antigravity-human-probes/hybrid-2026-09-12T07-40-46-401Z-d050c101/evidence.json" \
  bun run workers/bun/scripts/manual/antigravity-hybrid-probe.ts
```

The script will:

1. Generate fresh `falcon-…` and `cedar-…` values.
2. Run a small headless turn and capture its native `conversation_id`.
3. Create a Herdr tab and start:

   ```bash
   herdr agent start <generated-agent-name> \
     --kind agy \
     --pane <generated-pane-id> \
     -- \
     --conversation <headless-conversation-id> \
     --model gemini-3.8-flash-low
   ```

4. Attach with `herdr agent attach <generated-agent-name> --takeover`.
5. Print the exact one-line message to paste into the TUI.
6. Poll Herdr state and the native conversation ID reported by the installed Antigravity/Herdr hook.
7. Require a `working` → settled lifecycle transition under the exact first conversation ID.
8. Classify disappearance of the Herdr terminal after that completed turn as expected teardown rather than conversation deletion.
9. After a normal direct-attach detach, send Antigravity's native `/quit` command to end the interactive process cleanly.
10. Resume the exact ID headlessly and ask for both fresh values.

Inside the attached Antigravity TUI:

- paste only the exact message printed between the markers;
- verify the editor contains the fresh `cedar-…` word, not `QE_HYBRID_HEADLESS_1_ACK`;
- wait for `QE_HYBRID_INTERACTIVE_ACK`;
- detach the direct Herdr attachment with **Ctrl+B, then Q**;
- do not terminate Antigravity yourself—the script sends the native `/quit` command after detach.

Safe abort:

- during either headless command: press **Ctrl+C**;
- inside the TUI: detach with **Ctrl+B, then Q**, then abort the parent probe with **Ctrl+C**;
- if the attached terminal cannot accept input, use the exact emergency `herdr agent send-keys … ctrl+c ctrl+c` command printed by the script from another terminal.

A nonzero direct-attach exit is not by itself an interactive failure. If Herdr already observed the exact native identity and a complete `working` → `idle|done` transition, `terminal attach ended: terminal … not found` is accepted as expected process/terminal teardown and the final headless resume is still attempted. A changed identity, a turn that never settled, another attach failure, or a failed final native resume remains a failure.

Expected final summary fields:

```json
{
  "headlessTurn1ConversationId": "uuid",
  "interactiveHookConversationId": "same uuid",
  "headlessTurn2ConversationId": "same uuid",
  "allConversationIdsMatch": true,
  "probeValue": "falcon-random",
  "handoffWord": "cedar-random",
  "recalledProbeValue": true,
  "recalledHandoffWord": true,
  "contextContinuityProven": true,
  "finalStatus": "SUCCESS",
  "finalResponse": "...both fresh values...",
  "herdrStateSamples": []
}
```

Copy back:

1. the entire `Hybrid probe summary` JSON block;
2. the printed interactive resume command;
3. the `Herdr agent`, `Herdr pane`, and initial state lines;
4. any error emitted before headless turn 2;
5. if results are unexpected, the printed `Full evidence` path and relevant `evidence.json` fields.

The three native IDs—not transcript filenames—are the identity proof. Recall of both independently generated values is the context-continuity proof.

## C. Interactive MCP completion gate

This historical gate was cleared by the bounded human-operated probe on Antigravity CLI 1.2.2. The native TUI invoked `qe_complete_step` once with the expected semantic payload, the bridge attributed it to the exact active Attempt, and the real Stop hook returned `allow`. The static Antigravity registration contains no Run, Attempt, lineage, nonce, descriptor, or credential.

The following historical command changed global Antigravity configuration and must not be used for the SBX production path:

```bash
agy mcp add qe \
  /Users/kylec/.bun/bin/bun \
  /Users/kylec/quest-eng-prod/workers/bun/src/harnesses/control/mcp-server.ts
```

Verify the static registration:

```bash
agy mcp list
```

Run the zero-inference preflight first from an attached Herdr shell:

```bash
bun run workers/bun/scripts/manual/antigravity-mcp-tool-probe.ts preflight
```

The preflight launches two concurrent, unprompted Antigravity TUIs using the same global `qe` MCP command. Each TUI receives a different `QE_HARNESS_CONTROL_PATH`. The MCP child must authenticate to that descriptor's bridge context before initialization, and writes probe-only startup evidence containing a descriptor-path hash—never its path or credential. Native `agy mcp list` plus successful Antigravity-launched child initialization are authoritative. The native `/mcp` screen is captured only as optional presentation corroboration because Herdr 0.9 input/read timing does not reliably retain that transient screen. No model prompt is submitted.

Expected summary:

```json
{
  "staticRegistrationVisible": true,
  "sameStaticMcpCommand": true,
  "sessionA": {
    "nativeMcpDiscoveryComplete": true,
    "mcpChildLaunched": true,
    "bridgeContextObserved": true,
    "bridgeContextValid": true
  },
  "sessionB": {
    "nativeMcpDiscoveryComplete": true,
    "mcpChildLaunched": true,
    "bridgeContextObserved": true,
    "bridgeContextValid": true
  },
  "distinctSessionContexts": true,
  "concurrentIsolationProven": true,
  "modelTurns": 0,
  "finalStatus": "SUCCESS"
}
```

Before the paid turn, run the combined MCP and Stop-hook readiness gate with zero inference:

```bash
bun run workers/bun/scripts/manual/antigravity-mcp-tool-probe.ts readiness
```

This gate verifies the exact namespaced hook config, waits for Antigravity's native `hooks_manager` discovery record, executes the configured Stop command with a synthetic structured payload, proves the command reached the current generic bridge context, rotates that consumed context, proves the old context is stale, and verifies the replacement context. The `/hooks` panel is not authoritative under Herdr 0.9 because it may not remain available for capture.

The following command is retained only for explicit regression acceptance if a new implementation-specific native uncertainty is discovered. Do not rerun it routinely:

```bash
QE_RUN_SUBSCRIPTION_PROBE=1 \
  bun run workers/bun/scripts/manual/antigravity-mcp-tool-probe.ts
```

The script starts the TUI unprompted, independently proves MCP and Stop-hook readiness, writes `pre-inference-summary.json` with `paidPromptSubmitted: false`, rotates the synthetic Stop context, and only then submits this prompt:

```text
Call qe_complete_step exactly once with outputs {"probe_result":{"status":"ok"}}.
Do not call any other tool, inspect files, or modify files. After the tool
succeeds, stop.
```

If Antigravity's native permission system asks before calling the MCP tool, use the exact `herdr agent attach … --takeover` command printed by the script, approve only `qe_complete_step`, wait for settlement, and detach with **Ctrl+B, then Q**. The script sends native `/quit` during cleanup.

Expected proof:

- static registration plus Antigravity-launched MCP child startup proves native discovery; `/mcp` rendering is optional and was not observed in the successful gate;
- the MCP child accepts the session-specific bridge descriptor;
- the bridge records exactly `{probe_result: {status: "ok"}}` under the generated active Attempt;
- the result envelope's Worker, Action, Run, occurrence, and Attempt match that active context;
- the Stop hook consults the same bridge, observes `decision: allow`, and does not force another cycle; its native `terminationReason` is diagnostic only (`NO_TOOL_CALL` was observed after a real successful tool call);
- the TUI exits cleanly with no repository work.

Copy back the complete `MCP invocation probe summary`. Do not rerun the Stop-hook continuation or hybrid-continuity probes; those behaviors are already established.
