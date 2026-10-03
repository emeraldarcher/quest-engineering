# Phase 5 closure: Antigravity in Run-owned SBX

## Status

Phase 5 runtime acceptance is complete. The accepted source is branch `phase5/antigravity-sbx` at commit `e6c6927913b218900b59795dbc1f62ed58c6e353`.

The closure dimensions are intentionally independent:

| Dimension | Verdict |
|---|---|
| Product / Antigravity semantics | **ACCEPTED** |
| Phase-aware structured completion | **PASS** |
| SBX teardown | **DEVIATION / UNCERTAIN** |
| Procedure / evidence hygiene | **DEVIATION** |

The teardown and evidence-hygiene deviations do not downgrade the semantic acceptance established before teardown.

## Accepted architecture

Phase 5 accepts all of the following as the production architecture:

- SBX is the per-Run execution boundary.
- Pi and Antigravity execute inside the same immutable mixed-harness SBX profile, with separate PhysicalLineages when needed.
- Antigravity 1.2.7 is the accepted pinned native runtime.
- Live-TUI prompt transport uses one literal Herdr `pane.send_text` followed by one `pane.send_keys(["enter"])` after durable Product authorization and prompt intent.
- Fresh Antigravity readiness is conversation-free and requires native project, workspace, writable lineage state, prompt-surface, editor-mode, Enter-binding, MCP-child, and Stop-hook readiness.
- Worker registration proves connectivity only; dispatch requires readiness fenced to the current Worker connection generation.
- Managed-agent input is fenced by immutable environment/session/topology/process identity plus current Product, generation, Action, Attempt, ownership, nonce, endpoint, and process-digest authority.
- One structured semantic completion is acknowledged before asynchronous private-Git checkpoint/export finishes.
- Product-visible export binding and result publication remain fenced to the current Action, Attempt, PhysicalLineage, and generation.
- Mixed-harness private Git, checkpoint/export, and Product Change Set materialization are accepted.

See [`antigravity-sbx.md`](antigravity-sbx.md), [`live-execution-sessions.md`](live-execution-sessions.md), [`execution-environment-backend.md`](execution-environment-backend.md), and [`private-git-sbx.md`](private-git-sbx.md) for the normative boundaries.

## Final paid acceptance

The final acceptance used exactly one Product Run and one paid Attempt:

- authorizations: `1`;
- Product prompts: `1`;
- `pane.send_text`: `1`;
- Enter submissions: `1`;
- native first-message acceptances: `1`;
- retries and replacement Runs/Attempts: `0`.

The generic control authority durably acknowledged `qe_complete_step`, then asynchronous export ran for `42.734` seconds. During export, 20 normal bridge/status requests remained responsive at `0.879–5.401 ms`, with zero `bridge_timeout` results. The checkpoint, private-Git export, Change Set binding, independent final-tree `npm test`, and Product terminal completion all succeeded. Product remained running while export was in progress and terminalized only after the physical export was complete.

The immutable acceptance report remains:

```text
.pi/tmp/phase5-final-paid-antigravity-acceptance-20261003T051433Z-ed3d44ba/evidence/final-stop-report.md
sha256:2f27bc8cb23c5329f3c37cd5c3fb67a636b260d829e065bc005dc1b82de28aac
```

That report is preserved unchanged.

## Separate SBX teardown issue

The sole normal SBX stop after semantic success returned `environment_unhealthy` because authoritative inventory still reported the environment as running. No second stop or manual shim recovery was performed. This remains the separate SBX stop-convergence / teardown lifecycle issue recorded at:

```text
.pi/tmp/phase5-sbx-stop-convergence-lifecycle-issue-20261001.md
```

Do not treat teardown uncertainty as an Antigravity semantic failure, and do not add automatic stop retry as part of the accepted Phase 5 behavior.

## Procedure and evidence hygiene

### Post-completion capability incident

After Product completion, an evidence read inadvertently rendered one terminal/local capability value. The exact value is exposed, inactive, and permanently non-reusable. It must not be rendered, recovered, hashed, compared, or reused. The terminal dispatch, bridge, Worker authority, and Herdr session were stopped. There is no evidence that a provider or GitHub credential was exposed, so this incident does not require provider/GitHub credential rotation.

Only this sanitized incident classification is retained in closure documentation.

### Historical evidence-directory mutation

A helper created one post-manifest artifact in the historical paid-attempt evidence directory. The historical directory must receive no further writes.

| Field | Recorded value |
|---|---|
| Mutation timestamp | `2026-10-03T05:49:11.528286Z` |
| New artifact | `.pi/tmp/phase5-final-paid-antigravity-acceptance-20261002T061703Z-6b738e76/evidence/product-final-database-state.json` |
| Listed in original manifest | no |
| Original manifest entries changed | no |
| Original final report changed | no |
| Original manifest changed | no |

The original 49-entry manifest remains the statement of that evidence set when it was created. The new artifact is explicitly post-manifest material; the manifest is not regenerated to absorb it.

## Historical Attempts and closure boundary

All earlier failed or cancelled paid Attempts remain failed or cancelled historical evidence. The successful final Attempt does not retroactively promote them, and their late/private forensic material does not become Product success.

No additional Phase 5 inference, prompt, Run, Attempt, acceptance proof, or teardown investigation is authorized by this closure. Phase 6 is outside this task.
