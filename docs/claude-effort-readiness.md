# Exact Claude effort readiness

## Decision and scope

**Obtain authoritative native applied-configuration evidence.** QE already
supplies the correct effort. Requiring a populated `system/init.effort` is the
deterministic defect; it is **not** the earlier protocol-frame timeout's cause.
Neither increasing the timeout nor changing Claude, the Mod or immutable settings
is necessary.

The pinned runtime is Claude Code **2.1.292**, SDK **0.3.292**. The supported QE
combination remains exactly `anthropic/claude-opus-4-6` / `high`. Other effort
strings, aliases, numeric budgets, null and `unsupported` capabilities fail
closed. There is no default, downgrade, nearest-value conversion, fallback model
or provider-selected effort in QE's mapping.

## Configuration trace

1. `Product.Loadout` (`apps/quest_engineering_core/lib/quest_engineering/core/product/model.ex`)
   owns authored `model` and `reasoning: String.t() | nil`.
   `product/repository.ex` persists/reconstructs that selection unchanged.
2. Server `execution_options.ex` projects Worker-advertised model capabilities;
   it preserves `unsupported` versus `enumerated`, sorting enumeration values
   without translating them. Claude discovery advertises only `high`.
3. Core `ResolvedExecution.build` copies the Run's snapshotted member Loadout
   into `Configuration`. Its validation requires selected string membership for
   `enumerated`; `nil` is valid only for an unsupported capability. That generic
   unsupported case is not valid for this managed Claude profile.
4. Server `worker_protocol.ex` encodes both `reasoning` and
   `reasoning_capability` without semantic conversion. Client and Worker
   contracts use the same discriminated `ReasoningCapability`; reasoning is an
   opaque string, not a newly introduced provider enum. Worker Protocol remains 19.
5. `ClaudeCodeHarness` checks the exact provider/model and independently checks
   `supportsClaudeReasoning(reasoning, capability)`: selected `high`, enumerated,
   and advertised membership are all mandatory **before launch**. It does not
   use the capability list to select a default.
6. `claudeCodeCommand()` emits exactly `--model claude-opus-4-6 --effort high`.
   The existing environment passes `QE_CLAUDE_EFFORT=high` to the immutable Mod's
   guard; that value is **not** native applied-effort evidence.
7. Native startup parses `--effort`, installs the explicit session effort into
   engine state, and resolves effective effort against native overrides/caps.
   Native `system/init` attests the existing identity/model/tool/auth fences.
   A separate read-only native configuration response proves current effort.
8. Only after **both** validations does preparation set `initialized=true` and
   allow `ready()`. The existing dispatcher can then stage `needs_confirmation`
   before any paid input. Continuation reacquires current account/broker
   authority and repeats the applied model/effort readback before becoming ready.

## Pinned native evidence (static, not Claude execution)

The installed artifact test verifies package/manifest versions and binary SHA-256
against the platform manifest, then checks the actual embedded source contract.
Minified import aliases vary by platform; the test derives the effective resolver
from the getter's call rather than assuming Linux symbols on macOS.

The investigation's Linux 2.1.292 artifact SHA-256 is
`24caa9e6ff13bf227049a2626f1c816fc895023050f0ec3b12dbf14d897367e0`.
Its embedded functions establish:

- CLI registration in `segment-0706`: `--effort` uses `ynt`; engine construction
  spreads `Snt(o.effort)`. `Snt` (segment-0176) parses the value and stores
  `sessionEffort: {kind:"level", value:"high"}` plus the settings effort table.
  `rc(engineState)` returns that explicit selected level.
- Native `ynt` accepts its broader native domain/aliases and can warn then ignore
  an unknown value. **QE never depends on that permissive behavior**: only exact
  `high` reaches the constructor. Native representability is checked again by the
  applied readback; unsupported models produce null effort there.
- The `kv` caller (segment-1705) does not pass effort to `p5e` (segment-0513).
  `p5e` adds the optional field only if supplied. Thus this shipped producer path
  omits effort even though the CLI and engine know it. This proves actual wire
  behavior, not vendor design intent. Presence/schema symmetry is not promised.
- The standard `get_settings` control handler (segment-1705) reads current engine
  state and current model, then computes
  `Bv(model) ? Lw(model, rc(engineState)) : undefined`. It emits
  `applied: {model, effort: typeof effective === "string" ? effective : null}`.
  This is an **effective resolver output**, not the launch flag or settings echo.
  The CLI's returned top-level settings are not used as effort authority.
- `Lw` resolves native environment/turn/selected/default sources and normalizes
  against model support and policy caps. `CLAUDE_CODE_EFFORT_LEVEL` can outrank
  the selected effort; `auto`/`unset` can remove explicit effort. Caps can lower
  it. Such outcomes cannot pass QE unless the actual applied value is exactly high.
- This is supported on QE's direct stdio connection. `zF` creates `lue` without
  `sdkUrl`; that transport is not hosted and does not persist outbound frames.
  The `kf` restriction applies to diskless/hosted/persisted bridge connections,
  not this local launch (diskless defaults false). `get_settings` is present in
  the native control-request allowlists. QE passes no hosted/SDK/bridge flags or
  environment selectors. A future unsupported connection fails closed; there is
  no alternate fake handshake.

No native executable, hooks engine, auth command or model request is run to obtain
this source evidence. Existing vendor bytes remain unmodified.

## Readiness authority and cross-checks

After the unchanged synthetic `shouldQuery:false` probe and matching init:

```json
{"type":"control_request","request_id":"<fresh UUID>","request":{"subtype":"get_settings"}}
```

The request contains **no requested model or effort to echo**, no user prompt,
no setting mutation and no inference instruction. The Worker accepts only the
same process's stream, exact fresh request ID, `control_response` / `success`,
`response.applied.model === "claude-opus-4-6"`, and
`response.applied.effort === "high"`. Nonempty/malformed settings errors reject
readiness. Missing/null/numeric/unrecognized effort or model, control errors,
foreign/stale replies and unavailable streams cannot establish readiness. The
readback loop rejects contradictory re-init/assistant frames, foreign session
claims and nonzero-turn/model-usage results instead of silently consuming model
or ownership violations while waiting for configuration. The probe's genuine
zero-turn result is permitted.

The original init model check remains mandatory and separate. If init happens
to contain effort, a contradictory value also rejects it; absence is legitimate
and does not prove effort either way. **Even a present `init.effort:high` never
substitutes for the applied readback.** Correct model with wrong effort fails;
correct effort with wrong model fails, including disagreement between init and
current applied model.

The exact current EnvironmentRef, historical owner/profile, process identity,
reserved native UUID and queue remain attached as before. A control response
without a session-ID field is bound by the exact process and fresh request nonce,
not by a session ID claimed in unrelated output. Current revocable account
and broker authority are checked before and after readback. A failed continuation
is interrupted, not silently reused with its previous ready flag.

The existing `waitForInit(frames, 30_000)` is unchanged. The subsequent readback
uses only the **remaining portion of that same post-probe 30,000 ms budget**;
there is no second initial 30-second wait, startup sleep or timeout increase.
A delayed write ACK cannot extend the budget or hide an already received
correlated response. An ACK alone is never applied-configuration proof.

## Override audit

| Authority | Existing restriction / readiness outcome |
| --- | --- |
| Authored Loadout / Run | Exact selected `high` plus advertised capability required; no null/default/alias conversion. |
| Worker host environment | Streamed relay reconstructs the target environment from explicit names only. Native effort/model/provider/cloud/bridge selectors are absent; no ambient host inheritance. |
| Native CLI | One exact model/effort pair; no `--settings`, `--managed-settings`, SDK URL, plugin-dir, setting-sources or fallback override. |
| User/project/local settings | `--restricted` ignores these settings; account cwd is the managed empty cwd, not the Run worktree. Project source cannot configure the account runtime. |
| Managed settings | Existing `/etc/claude-code/managed-settings.json` bytes constrain exact model, `effortLevel:high`, `maxEffortLevel:high`, no fallback and managed-only extensions. A cap is **not** proof that high was applied. |
| Enterprise/remote policy, native environment, model capabilities/defaults | Can influence native resolution. Getter returns the effective result; missing/lower/unsupported values fail instead of silently accepting the requested value. QE does not infer effort from policy/defaults. |
| Native control mutation | QE sends only the getter, never `update_settings`, `set_model` or effort-changing requests in readiness. No user content is sent to this channel. |
| Hooks / subsequent turns | Immutable managed-only extension restrictions and the existing Mod's actual model/effort turn guard remain in force; no native/provider tool escape or override grant is added. |

This fix does **not** rely on immutable requested settings as sole applied-state
authority. They, the constructor and native state-consumption trace establish an
explicit configuration; the independent runtime response establishes its effective
result. An override that lowers/removes effort is rejected, not repaired.

## Identity, diagnostics and persistence

No embedded profile/settings/Mod/bridge bytes change. No new immutable profile,
Mod version, Mod protocol or migration is justified. Historical account v1/v2 and
broker-Run identities/digests remain byte-identical. Auth configuration, credential
generation semantics, physical owner generation, environment policy, Worker
Protocol, Product/Core schema and Worker SQLite schema are unchanged.

The PR #54 lifecycle implementation, protocol parser/queue/timeout machinery and
session-store schema remain byte-identical. No effort milestone, diagnostic
channel, readiness claim from missing evidence, or native/Mod marker is added.
Validation is still recorded only after the authoritative preparation fences pass;
missing diagnostic writes do not affect that result. Existing last-proven-stage,
frozen timeout evidence and unknown/unobservable native intervals are preserved.

Full native settings/output exist only in bounded transient parser memory. No
raw frames, settings/env payload, provider errors, URLs/codes or auth material are
persisted/logged. Only the existing configured model/effort/session fields and
closed existing lifecycle metadata persist; configured session fields alone are
not evidence of successful readiness. Failures expose constant categories/prose.

## Validation and physical proof boundary

- Deterministic mapping, constructor/policy isolation, optional-init consistency,
  independent model/effort, applied readback, missing/unsupported/malformed/foreign
  response, error-canary, delayed ACK and remaining-budget tests.
- Real `ClaudeCodeHarness.start/continue/ready` tests, including wrong/missing
  applied state and rejection before native launch for unsupported authored effort.
- Existing profile-byte verification and PR #54 diagnostic-loss/frozen-stage tests.
- `QE_LIVE_SBX=1 bun test test/claude-effort-readiness-sbx-live.test.ts` exercises
  real immutable account and broker-Run cells, ownership/private Git, runtime
  lookup, credential-generation-2 / physical-owner-1 authority, real broker
  admission, relay/stream/parser and **production harness preparation/readiness**.
  Fixture Product dispatch/admission is scheduled after the real Run context is
  ready; auth-status and the native executable are explicit deterministic runtime
  boundaries. The fixture emits the native probe's zero-turn result as well as
  init without effort. The request never supplies the fixture's applied value. High passes;
  wrong/missing/unsupported effort and wrong-model/high-effort reject before input.
  Native execution and credential-operation guards must remain zero; all cells
  are removed. It is not a claim that real Claude or a real accepted Run passed.

No retained account/Run/acceptance state is retried, repaired or rebound. No login,
Claude credential operation, real Claude execution, provider request, Product
prompt or model turn is authorized by this change. An actual post-merge zero-query
Run, and any later inference, require separate authorization. The unresolved native
frame timeout remains a separate diagnostic question.
