# SBX stop-convergence report

This is the requested 42-item report for the corrective branch. It describes new behavior only; it does not mutate or re-credit any historical environment, PID, stop, Attempt, or Phase-5 result.

1. **Baseline.** The branch started from `origin/main` at `a5b000dcb558f39b675cb39533cc333bc48c85b4`; required ancestors `e6c6927913b218900b59795dbc1f62ed58c6e353` and `df6fa31a62895ddb8075f94f7c8d346f7204566b` were present.
2. **Branch isolation.** Work was performed on `fix/sbx-stop-convergence`; no Phase-5 branch was checked out or modified.
3. **Historical integrity.** Historical SBX environments and PIDs were read as evidence only. Historical cleanup-only second stops were not counted as successful first-stop convergence.
4. **Scope exclusions.** No Phase 6 work, Pi execution, Antigravity execution, harness execution, prompt, provider cycle, paid inference, shim signal, daemon restart, or automatic merge was performed.
5. **Pinned native build.** The installed client and server are SBX `v0.43.0`, revision `79805a6e3c6667520dc2da4f6bdeddae9b700969`, API `0.31.0`, at `/opt/homebrew/bin/sbx`.
6. **Version policy.** Repository profile constants remain pinned to that tested build; the implementation did not alter profile identity or silently upgrade SBX.
7. **Available upgrade.** Homebrew reports `v0.46.0` available. No upgrade was performed because lifecycle correctness cannot depend on changing the audited environment.
8. **Upgrade relevance.** The v0.46.0 release notes include a shutdown fix for dash-based templates: SIGTERM is forwarded correctly instead of waiting five seconds for forced shutdown. That can improve latency, but cannot supply QE's durable intent, exactly-once claim, crash recovery, identity fence, or Product/cleanup separation.
9. **Upstream visibility.** `docker/sbx-releases` publishes release artifacts and notes, not the implementation source. Exact claims here are therefore bounded to the pinned binary's supported CLI/help, embedded service surface, repository client code, and physical behavior; undocumented internals are not treated as contracts.
10. **Supported stop semantics.** `sbx stop --help` says local stop stops without removing, retains state, and permits restart with `sbx run`.
11. **Observed blocking behavior.** On the pinned build, successful local name-targeted stop calls block for about 5.36–5.53 seconds and return before a separate inventory read confirms `stopped` about 5.69–5.94 seconds after invocation.
12. **No supported wait primitive.** The CLI exposes no local wait or operation-status command. The binary contains an internal operation service symbol, but QE does not bind to an undocumented RPC.
13. **Target identity constraint.** Local v0.43 stop targets the deterministic human name, not the retained UUID. A disposable UUID-target experiment returned a CLI error and was not retried; the environment later reached stopped through its independent idle lifecycle and was removed only after stopped confirmation.
14. **Timeout ownership.** QE owns the child-process deadline for its one `sbx stop` CLI process. SBX owns the daemon-side lifecycle operation. Killing or timing out the CLI does not prove cancellation of daemon work.
15. **Inventory ownership.** `sbx ls --json` is a separate read-only command. Its timeout is observation unavailability and is never reclassified as destructive stop failure.
16. **Repeated native stop.** Native repeated-stop idempotency was deliberately not assumed or physically probed. QE's own repeated `stop` API calls are made safe by durable suppression, not by issuing another provider stop.
17. **Historical failure modes.** Read-only historical evidence contained both “first stop returned while inventory still said running” and “first stop followed by unavailable/timed-out inventory.” The correction models both without guessing.
18. **Old contract defect.** `stop(ref): Promise<void>` combined request outcome and final observed state, so an inventory timeout or lag looked like destructive failure and encouraged unsafe retry reasoning.
19. **New contract.** `stop` and `reconcileStop` return `EnvironmentStopResult`; inspection optionally exposes `EnvironmentStopStatus`.
20. **Orthogonal axes.** Results independently project durable intent (`recorded`), invocation knowledge (`not_invoked`, `acknowledged`, or `ambiguous`), observation (`running`, `stopping`, `stopped`, `absent`, `identity_mismatch`, or `unavailable`), and aggregate lifecycle state.
21. **Provider neutrality.** Generic Fake and HostNative backends implement the same projection without importing SBX command or daemon concepts.
22. **Durable schema.** SQLite migration 2 adds append-only `execution_environment_stop_events`, keyed to the durable environment record and stop-cycle UUID.
23. **Intent-before-effect.** `stop_intent_recorded` commits with `synchronous=FULL` before any destructive provider request may spawn.
24. **Exactly-once boundary.** `stop_invocation_started` is an atomic durable claim made in the CLI's pre-spawn callback. Only the claimant may invoke the provider command for that cycle.
25. **Outcome-after-effect.** Return or error appends `stop_invocation_acknowledged`, `stop_invocation_ambiguous`, or `stop_invocation_not_started`.
26. **Crash semantics.** A process lost after claiming but before recording an outcome is conservatively recovered as ambiguous. QE never guesses that it was unsent and never replays it.
27. **Known-unsent semantics.** Failure before the pre-spawn claim remains explicitly `not_invoked`; it is distinguishable from response loss or timeout.
28. **Existing-intent behavior.** Any later `stop` call finding an unresolved cycle skips the client stop path and performs only read-only reconciliation.
29. **First identity fence.** Before intent, inventory must contain exactly one sandbox matching durable UUID, deterministic name, and profile-selected agent in running state.
30. **Boundary identity fence.** After intent and immediately before the invocation claim, QE repeats the exact read-only identity check. A visible same-name replacement or stale incarnation cannot be stopped.
31. **Provider race limitation.** SBX v0.43 lacks an exposed compare-and-stop-by-UUID primitive, so QE documents rather than conceals the final provider-side name-resolution race. Reconciliation itself always uses UUID+name+agent.
32. **Read-only convergence.** Reconciliation can list inventory and append observations only. It cannot call stop, signal a shim, remove resources, restart a daemon, or fabricate a terminal state.
33. **Bounded ownership.** After the initiating caller returns, the backend observes at a configured one-second cadence until a 120-second per-generation scheduling deadline; an inventory call admitted before that deadline remains independently capped at five seconds.
34. **Worker-generation survival.** Stop state is in SQLite, not a caller promise. Backend construction resumes every unresolved durable cycle with a fresh bounded read-only budget.
35. **Execution fence.** A recorded unresolved stop makes old leases unusable even when inventory still says running.
36. **Resource fence.** Removal is refused while a stop cycle is unresolved, preserving UUID/incarnation authority. Exact stopped or authoritative absence permits cleanup.
37. **Explicit restart.** Recovery is allowed only after stop confirmation, restarts and re-verifies the same incarnation, then appends `stop_cycle_reopened`; a later intentional stop receives a new cycle ID.
38. **Observability.** Structured durable events cover intent, boundary claim, invocation outcome, reconciliation start, running/transitional readback, inventory unavailability, identity mismatch, absence, confirmation, and explicit reopen.
39. **Semantic independence.** Product success and verified private-Git export remain authoritative regardless of teardown lag or observation failure. Active execution that loses its environment still follows existing infrastructure-failure semantics.
40. **Deterministic matrix.** Fake-clock/scheduler tests cover pre-invocation failure, acknowledged+stopped, acknowledged+running, inventory timeout, ambiguous response, post-caller background convergence, Worker restart, repeated reconcile/stop, stale ref, same-name replacement, disappearance, and explicit recovery. They assert one invocation claim and no destructive replay.
41. **Physical proof.** Five native baseline environments and one final changed-QE-path environment each received exactly one stop and zero second stops/signals. The final QE path recorded intent, claimed one invocation, received acknowledgement after 5,397 ms, confirmed exact stopped after 5,712 ms from the claim, and removed only after confirmation. See [`sbx-stop-convergence-physical-proof.json`](sbx-stop-convergence-physical-proof.json).
42. **Outcome.** The corrective path converges without converting observation failure into destructive failure, survives caller/process lifetime through durable read-only ownership, preserves Product semantics, and does not require an SBX upgrade. Repository gates and review results are recorded in the final delivery summary.
