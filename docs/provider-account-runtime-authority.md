# ProviderAccount runtime authority: independent credential and physical identities

## Invariants

| Identity | Authority and meaning |
| --- | --- |
| ProviderAccount ID | Stable Product account identity. It is not a bearer capability. |
| `ProviderAccount.credential_generation` | Current semantic authentication epoch. Successful explicit authentication advances N to N+1; stale admission for N must fail. Routine provider refresh does not advance it. |
| ProviderAccount EnvironmentRef | Exact Worker/backend/account owner, environment ID, incarnation, and immutable profile. Product's `provider_account_environments` row is the authoritative account-to-physical-cell relationship. |
| Environment incarnation | Exact lifetime of that physical cell. An old/replaced incarnation cannot be adopted merely because credentials are current. |
| Environment operation ID | Product's current desired-state/reconciliation request. It changes on a new operation or Worker re-registration; it is neither credential authority nor physical identity. Setup separately retains its immutable invocation operation. |
| Environment owner generation | Immutable ownership/provisioning epoch. The existing environment row's `credential_generation`, EnvironmentRef owner's `credentialGeneration`, setup's `environment_generation`, and broker's `account_environment_generation` carry this physical provenance. They do **not** mean current credential freshness. |
| Worker connection generation | Current Product routing/admission authority. Registration changes routing, invalidates readiness, and requires physical/auth reconciliation. It does not rewrite invocation ownership or physical provenance. |

Successful authentication may therefore produce **credential generation 2 with
the same authenticated cell owned at generation 1**. This is expected, not stale
physical state. Neither number is rewritten to make them equal. Explicit
replacement/rotation is a distinct lifecycle and may replace the cell.

No protocol or schema change is needed: Worker Protocol v19 and both current
stores already carry the independent semantic and physical identities. There
are no compatibility aliases, migrations, old-row conversions, or inferred
fallbacks in this fix. Persisted field names stay exact; the formerly ambiguous
runtime `credentialGeneration -> owner` conversion is removed. The local broker
resolver parameter is explicitly named `environmentOwnerGeneration`.

## Phase-E failure and correction

Final fresh Phase E authenticated once, advanced the semantic epoch 1 -> 2,
recovered the same account cell after a Worker restart, and prepared a fresh
credential-free Run with a validated schema-v2 ownership marker. Preparation
then failed with `stale_environment_ref`, before native Claude execution.

The chain was:

1. Product `WorkspaceToolBrokers.authority` admitted semantic credential 2,
   physical owner generation 1, and the exact current account environment.
2. Worker independently checked setup authentication and physical broker
   ownership, then admitted the local broker.
3. `ClaudeCodeHarness.prepare` passed `binding.credentialGeneration` to
   `ProviderAccountEnvironmentManager.claudeCodeRuntime`.
4. The latter synthesized `providerAccountOwner(accountId, 2)` and called
   `store.current`. The real row was owned at generation 1, so lookup failed.

Runtime acquisition now receives a **live admitted account authority** from
`WorkspaceToolBroker.boundClientForAction`: current semantic credential epoch,
exact physical EnvironmentRef, and a revocable `assertCurrent` callback.
`claudeCodeRuntime` compares the requested account/credential epoch separately,
then resolves the exact ref with `store.byRef`. It requires the correct account,
Worker, backend, current non-retired/running row, incarnation, and exact account
profile. Recovery must return that same ref; authority is rechecked across the
await and after local runtime preparation, and remains checked for later use.
Recovery specs retain the ref's actual physical owner generation. Compatible
continuation reacquires the newly admitted broker authority after exact session
binding validation, rather than retaining the previous Action's revoked
capability. Authority is also rechecked inside account serialization, after
canonical status inspection, and immediately before native process launch.

The broker callback checks admitted-session liveness and the independently
resolved account and Run authorities. Existing Worker setup validation rejects
credential 1 after success at 2; Product admission re-reads current account,
authentication, environment, lifecycle, Worker routing/readiness, and execution
authority. Closing the session, changing credentials, replacing/stopping the
cell, or disconnecting the Worker revokes runtime authority. IDs alone grant
nothing. The provider CLI's canonical authentication inspection and all managed
runtime, model/effort, tool, control, and prompt gates remain downstream.

## Focused audit

| Path | Result |
| --- | --- |
| Product account creation, setup success, lifecycle, restart reconstruction | Semantic epoch and physical owner epoch already independent; retained unchanged and regression-tested. |
| Product Run/broker admission and prompt gate | Reads current authenticated semantic epoch and explicit current physical row; authorization digest includes both. Stale credential or physical binding fails. |
| Worker broker prepare/admit/operations | Setup ledger checks semantic epoch; physical resolver uses owner epoch plus exact environment/incarnation; live callback preserves both. |
| Claude runtime preparation/continuation/recovery | Bad synthesized owner lookup removed; acquisition uses live broker authority/ref, and native-session matching still compares semantic credentials and physical environment separately. |
| HarnessControl | Action/Attempt/lineage authority, independent of account provisioning epochs; unchanged. |
| Environment reconcile/auth inspection | Physical commands carry the environment row's owner epoch; canonical evidence is tied to that exact cell/configuration. No semantic-to-physical substitution added. |
| Setup supervision/cancellation/reconnect | Uses durable `environment_generation`/exact ref for physical ownership and separately retains credential and immutable invocation/routing fences; unchanged. |
| Cleanup | Run-only ownership checks and exact account lifecycle checks unchanged. |

## Validation boundaries

Deterministic regressions cover credential-2/owner-1 acquisition and adapter
readiness, stale credentials, wrong account/ref/incarnation/Worker/profile,
replacement E1 -> E2 at the same semantic epoch, stop/start without rollover,
Worker reconstruction, cross-await revocation, and broker closure. Product
tests exercise successful setup 1 -> 2 with the same environment, fresh-process
PostgreSQL reconstruction, and broker wire admission with 2/1 plus stale
credential/incarnation negatives. Product authority is reconstructed from the
repository, not an account cache.

The opt-in physical test is:

```sh
cd workers/bun
QE_LIVE_SBX=1 bun test test/provider-account-runtime-sbx-live.test.ts
```

It uses wholly separate fixture IDs/state and real production account/Run SBX
profiles. Authentication evidence and the semantic transition are **synthetic**;
no credential is created and no native auth command is allowed. It provisions
E at owner epoch 1, advances the fixture's semantic epoch to 2, reconstructs the
Worker manager, prepares a real isolated Run/PhysicalLineage/ownership binding,
admits the broker, and acquires the exact same account runtime at credential 2.
It rejects credential 1 and stops at the next local canonical-auth-inspection
boundary, before any native Claude model process. It does not claim real
subscription authentication or `needs_confirmation` in this provider-free
fixture. Only disposable proof resources are cleaned up.

The authenticated Phase-E account, its historical ownership, and the failed Run
are not opened, changed, retried, or upgraded during implementation. After human
merge, normal current-main reconciliation can reuse the same authenticated
account without migration, followed by a wholly fresh Run acceptance. This PR
does not authorize that acceptance, any new login, or inference.
