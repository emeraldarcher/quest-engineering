# v0.7 POC reuse report

Source repository inspected at implementation time: `/Users/kylec/quest-engineering` at commit `a597a6b`, with a pre-existing uncommitted `agent.start` response-race fix in `packages/executor-herdr/src/client.ts` and its test.

The source path is provenance only and is not referenced by Worker runtime code.

| POC source | Production destination | Treatment | Reason |
|---|---|---|---|
| `packages/executor-herdr/src/client.ts` | `workers/bun/src/session-host/herdr/client.ts` | Extracted/adapted | Retains verified protocols 19/20, typed snapshots, shell readiness, socket requests, exact discovery, and omitted-start-response adoption without POC SDK types. |
| `packages/executor-herdr/src/executor.ts` named-session provider | `workers/bun/src/session-host/herdr/connection.ts` | Extracted/adapted | Preserves explicit non-default named sessions, headless server startup, protocol allowlist, and no ambient socket fallback. |
| `packages/executor-herdr/src/executor.ts` execution lifecycle | `workers/bun/src/providers/pi/provider.ts` and `src/dispatch/executor.ts` | Behavior retained; code rewritten | The POC class mixed Herdr, Pi, product orchestration, workspace, and fixed result contracts. Production separates SessionHost, provider, and durable dispatch lifecycle. |
| `packages/executor-herdr/src/artifacts.ts` | `workers/bun/src/providers/pi/result-envelope.ts` | Adapted | Preserves nonce-bound identity, exactly-one validation, exclusive temporary creation, and atomic rename while replacing fixed Stage/Verification payloads with Runtime declared outputs. |
| `packages/executor-herdr/src/pi-stage-result-extension.ts` | `workers/bun/src/providers/pi/step-result-extension.ts` | Adapted | Preserves a final terminating Pi tool and atomic external artifact, with a lineage-stable control file and Action-scoped result identity. |
| `packages/executor-herdr/src/pi-verifier-extension.ts` | None | Rejected | Fixed POC verifier schema, semantic verdict policy, and read-only Loadout behavior do not define a generic Worker. |
| `packages/executor-herdr/src/pi-permission-extension.ts` | None | Deferred | Loadout and permission products are post-v0.7. |
| `packages/executor-pi/src/index.ts` | None | Rejected | Direct in-process Pi cannot preserve active execution across Worker restart. |
| `packages/workspace-git/src/index.ts` | `workers/bun/src/workspace/configured-workspace.ts` | Small validation behavior retained | v0.7 validates one configured Git worktree; provisioning, cleanup, fingerprints, GitHub handoff, and product permissions remain outside the Worker. |
| `packages/core/src/prompt.ts` | `workers/bun/src/providers/pi/provider.ts` | Safety ideas adapted | Keeps workspace and input-as-data boundaries without Class, Member, Assignment, or graph concepts. |
| `packages/core/src/orchestration.ts`, `quest-executor.ts`, `storage.ts` | None | Product architecture rejected | Scheduling, graph retries, Members, Squads, Attention, and POC session routing belong neither in the Worker nor in Herdr. |
| `scripts/integration-herdr-pi.ts` | `workers/bun/scripts/integration-herdr-pi.ts` | Harness behavior adapted | Proves fresh execution, same-lineage continuation, structured completion, independent review, and native attachment. |
| `scripts/integration-herdr-isolation.ts` | Worker named-session tests and restart harness | Behavior adapted | Preserves named server survival and reconnect assumptions. |
| `packages/daemon`, `packages/web`, `packages/tui`, `packages/client-sdk` | None | Rejected | Elysia and UI/client/product contracts are unrelated to a control-plane client Worker. |
