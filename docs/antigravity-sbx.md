# Antigravity in the Run-owned SBX architecture

## Decision

Antigravity is an `AgentHarness` in the same immutable Run environment as Pi. The selected profile is `qe-coding-execution-v1`; it composes lockfile-pinned Pi 0.85.1 and digest-pinned Antigravity 1.2.7. `qe-pi-execution-v2` remains unchanged for historical provenance. A harness change never means one VM per harness.

Phase 5 Product semantics and phase-aware structured completion are accepted. The asynchronous private-Git export completed successfully while normal bridge status remained responsive, and Product terminalized only after Change Set binding. SBX stop convergence and post-completion evidence hygiene remain independent deviations; see [`phase-5-closure.md`](phase-5-closure.md).

The production topology is:

```text
Worker authority
  -> Herdr agent.explicit_launch
  -> absolute QE SBX launcher
  -> exact Run VM / PhysicalLineage workspace and HOME
  -> attested guest launcher
  -> /opt/qe/antigravity/agy TUI
       -> profile-owned qe MCP child -> guest mailbox -> Worker authority
       -> lineage-private Stop hook -> guest bridge -> same authority
```

There is no production host-native Antigravity execution fallback. The unavailable `preserve/host-native-antigravity-archive` ref was not merged or reconstructed.

## Preservation classification

| Classification | Content |
|---|---|
| KEEP | native authenticated model/effort discovery; generic `AgentHarness` lifecycle; Herdr observation/attachment; structured completion; HumanAttention; cancellation; generic control authority; private-Git checkpoint/export |
| REWORK | launch through the Run lease; MCP and bridge packaging; Stop-hook installation/readiness; logs; attestation; HOME and conversation state; restart adoption |
| REMOVE | autonomous host launch; host workspace hook mutation; host credential/state scraping for execution; host permission-command policy; `.git` mounts; `unbash`; adapter path-containment logic |
| DIAGNOSTIC ONLY | historical manual host strategy probes and their paid-probe evidence |

## Runtime and compatibility

The profile installs the official Linux ARM64 1.2.7 archive only after SHA-256 verification. The executable is root-owned, non-writable, and addressed by absolute path. Admission is capability-based and requires the interactive TUI, exact model selection, model and effort discovery, conversation identity, MCP, Stop hooks, structured completion, deterministic retained state, autonomous guest mode, optional-inner-sandbox capability, external credentials, and disabled guest refresh. The immutable profile separately verifies exact version, executable, binary digest, and platform provenance.

Creation permits npm and release hosts. Runtime policy revokes registry, GitHub, and release-asset access, so the root-owned runtime cannot self-update. Runtime egress contains only the Pi and Antigravity subscription hosts.

Model discovery is metadata-only and submits no prompt. IDs that encode `low`, `medium`, or `high` are published with that exact singleton reasoning capability. Models without native effort metadata publish `unsupported`; conflicting ID/display metadata remains visible but unschedulable. Selection is exact and has no fallback.

## Credentials

Native host `agy models` owns login selection, token refresh, and keyring rotation. QE neither implements Google OAuth nor copies the long-lived refresh or ID token into the VM. It derives nonsecret account/auth-generation hashes and registers an SBX dynamic resolver that emits only the current access token. The guest file contains:

- a deterministic, cryptographically invalid account marker;
- a provider-host-scoped access placeholder;
- `qe-sbx-host-managed-no-refresh` instead of refresh authority;
- nonsecret account/auth-generation hashes.

SBX substitutes the access token only for the two exact Antigravity 1.2.7 credential consumers: `daily-cloudcode-pa.googleapis.com` for subscription/model APIs and `www.googleapis.com` for `GET /oauth2/v2/userinfo`. The latter is the native interactive startup's access-token validation; it is not an inference request. Runtime policy also permits the exact public image host `lh3.googleusercontent.com`, because 1.2.7 treats a denied profile-picture download as an eligibility failure; no credential is substituted or sent there. Google OAuth refresh remains unreachable. Tokens are absent from QE durable state, guest files, launch argv, diagnostics, and retained secret metadata.

## Human onboarding-state contract

Terms/Data Use choices are human-only. QE does not select controls, call Antigravity's acceptance RPC, or infer acceptance fields. For the pinned 1.2.7 profile, a human completed the native flow once in a disposable HOME. The resulting `.gemini/antigravity-cli/cache/onboarding.json` was copied byte-for-byte into the immutable profile with SHA-256 `1aa3e7b17067c259f56b1c7feb17094172729c977d4a7fcbea030f9247c0bbe4`. It is the only onboarding seed copied into each fresh lineage HOME.

The captured file contains exactly the native coarse booleans `consumerOnboardingComplete=true`, `enterpriseOnboardingComplete=false`, and `onboardingComplete=true`. No separate Terms revision, Data Use selection, privacy choice, credential, installation identity, settings, logs, caches, or post-onboarding progress are present. Accordingly, QE treats this as a 1.2.7 startup-state reproduction—not as independent evidence of legal text, revision, or option semantics. Any Antigravity version change requires a new human review and fresh capture; code and tests must never synthesize or mutate this file.

Credential eligibility is a separate boundary. The initial isolated startup persisted this onboarding state before failing the user-info check because `www.googleapis.com` lacked both the runtime grant and dynamic-secret scope. A same-credential host probe returned 200, and an exact guest-host grant/substitution probe then returned 200. That exposed one further 1.2.7 startup dependency: the user-info response's public profile picture on `lh3.googleusercontent.com`, which returned 200 on the host but was denied in the guest. The narrow fix adds access-token substitution only to `www.googleapis.com` and adds credential-free runtime egress only to the exact image host. It does not change the human-created onboarding state.

## Permission and state decisions

Antigravity launches with `--dangerously-skip-permissions` **inside the outer SBX only**. The optional native `--sandbox` is deliberately disabled. This avoids two conflicting isolation models and makes root-owned read-only/read-write workspace permissions, private Git, private HOME, exact network grants, disabled ambient credentials, and Worker control authority decisive. The protocol retains `native_permissions` as the compatibility marker because Antigravity has no stable low-level tool catalog; it is not a claim that host command parsing is authoritative.

Each PhysicalLineage gets a deterministic private HOME under `/qe/state/antigravity-lineages/`. Only profile-owned nonsecret credential markers, MCP registration, and the exact human-captured 1.2.7 onboarding file are seeded into it. All runtime parents—including `.gemini/config/projects`, `.gemini/antigravity`, and `.gemini/antigravity-cli/cache`—are created and assigned to the guest agent before any seed file is copied. This ordering is required: when the privileged seed copy implicitly created `cache`, Antigravity's agent process could not write `default_project_id.txt`; 1.2.7 logged `failed to resolve project`, displayed its input loop anyway, and later entered the new-conversation branch without materializing an active conversation. The native runtime, rather than QE, creates the default project marker and matching project configuration.

QE also writes the exact Run-private workspace into Antigravity's `trustedWorkspaces`; this is a mechanical consequence of the already-attested outer SBX/private-workspace boundary, not a Terms/Data Use choice, and no host or arbitrary workspace is trusted. QE does not seed host editor settings or keybindings. The fresh lineage therefore requires Antigravity's default editor mode, no custom keybinding file, and the native `prompt.submit` Enter binding. Native conversation and other retained state survive Attempt and Worker recovery without becoming shared mutable host state. The Stop hook lives in that HOME, not in source, so read-only source stays physically read-only.

## Local Herdr context and Open Session

Herdr 0.9.0 has two separate path authorities. `HERDR_CONFIG_PATH` overrides only the TOML config file loaded by `config::config_path()`; it does **not** move named sessions or sockets. On macOS/Linux, `XDG_CONFIG_HOME` selects the configuration directory (falling back to `HOME/.config`), and named `--session <name>` state lives at `<XDG_CONFIG_HOME>/herdr/sessions/<name>` with `herdr.sock` and `herdr-client.sock` beneath it. An explicit named session takes precedence over `HERDR_SOCKET_PATH`; without a named session, `HERDR_SOCKET_PATH` overrides the API socket and determines the client socket, while `HERDR_CLIENT_SOCKET_PATH` is only the legacy client fallback. Herdr state/log paths using `XDG_STATE_HOME` are separate and do not select named-session sockets.

Production Worker startup therefore requires three explicit, canonical local values: `QE_HERDR_BIN`, `XDG_CONFIG_HOME`, and `HERDR_CONFIG_PATH`. The Worker applies the latter two to every pinned Herdr CLI/server process and removes ambient session/socket/pane selectors. The built Tauri process must receive the same three values. It resolves them independently, applies them to `session list`, `agent get`, and the Terminal-owned `agent attach`, and removes the same ambient selectors. Worker and desktop `HOME` values may intentionally differ; neither side uses `HOME` to discover the named session once `XDG_CONFIG_HOME` is explicit.

For a disposable local context, use one short private root (short enough for Unix-domain socket paths) without creating another QE-specific path variable:

```sh
export QE_HERDR_BIN=/absolute/pinned/herdr
export XDG_CONFIG_HOME=/absolute/private/qe-herdr-context
export HERDR_CONFIG_PATH="$XDG_CONFIG_HOME/herdr/config.toml"
mkdir -p "$XDG_CONFIG_HOME/herdr"
# Write the accepted config.toml before starting either process.
```

The Worker reports the canonical executable, config home, config file, and a `sha256:` local-context ID in local diagnostics. Product receives only that digest with the existing session/pane and ownership fences—never executable, config, socket, or other filesystem authority. Tauri recomputes the digest from its own environment before inspecting Herdr. A split context fails closed before attach with an actionable `local_herdr_context_mismatch`; finding no named session in an otherwise matching context reports that the configured namespace lacks the Worker session. There is no alternate-root probe, PATH lookup, descriptor-carried path, or retry.

## Completion, attention, cancellation, and recovery

MCP is only transport. `HarnessControlAuthority` remains the authority for typed completion, HumanAttention, Stop enforcement, stale-context fencing, and idempotency. The guest MCP child must publish startup/liveness evidence for the exact descriptor path; current authority is checked independently. The guest Stop command must be discovered by Antigravity and pass a synthetic zero-inference call before authorization. A real Stop payload reporting a different model fences the PhysicalLineage after Take Control rather than accepting a silent switch.

Process/TUI, MCP, Stop-hook, and initial-input readiness are separate. Preauthorization starts and observes one conversation-free TUI, then waits for ordered Antigravity 1.2.7 evidence covering its input loop, empty-conversation render, authentication, CLI startup, Code Assist/model catalog, post-login experiment/model refresh, and customization reload. That visible-input sequence is only `tuiInputReady`; it is not sufficient for a first turn.

For a fresh lineage, `initialInputReady` additionally means `freshConversationReady`: the lineage-private cache, matching project configuration, and native conversation-store parent are agent-owned and writable, the native default project marker and project configuration exist, startup resolved the exact guest workspace without any project-resolution failure, the empty prompt surface is rendered, default non-Vim editor mode is in force, no custom keybindings are present, and Enter maps to native `prompt.submit`. The state is still conversation-free and has zero user-message/provider activity. Missing or invalid native project state, wrong prompt/editor state, or a changed Enter binding fails before Product authorization. A retained-conversation launch keeps its existing identity-fenced behavior: it may be active rather than conversation-free, but the same TUI/project/prompt prerequisites and exact native conversation identity remain mandatory. No arbitrary stability delay is used, and QE does not use `/new`, `/clear`, empty Enter, or any other submitted local command as a readiness probe.

After exact Product authorization and prompt-intent persistence, QE revalidates Worker, launch/Run, Action, StepOccurrence, Attempt, PhysicalLineage, SBX environment incarnation, Herdr endpoint/session generation, workspace/tab/pane/terminal, active metadata, result nonce, and authorization timestamps. `ManagedAgentPhysicalIdentity` retains the immutable environment/session/topology/agent/process target; current `PromptInputAuthority` adds Product authorization, current endpoint/server generation, ownership, and nonce. A pure validator compares these with the current Herdr agent and complete foreground-process observation. Its structured diagnostics contain only field name, classification, presence, equality, and provenance—never compared capability, token, nonce, or credential values. Fields are classified as immutable physical identity, generation-fenced authority, expected dynamic state, or derived identity. The environment digest hashes NUL-framed environment ID and incarnation; the process digest includes pane, shell PID, foreground process group, TTY, and sorted foreground process metadata.

The SBX lifecycle relay reports the actual native integration (`agy` for Antigravity, `pi` for Pi). It must never publish Pi identity into an Antigravity pane: Herdr treats a conflicting detected/reported kind as managed-agent replacement and may clear the deterministic managed name/readiness. Herdr 0.9 may omit the optional presentation name from some projections, so input authority uses deterministic name-targeted lookup plus the immutable `qe_agent_name` token and rejects an explicitly conflicting name. Current native materialization and interactive readiness remain mandatory. Because Herdr bounds managed-agent metadata values to 80 bytes, the active Action token must equal the deterministic 80-byte-bounded Action ID while the separate full Action digest must also match; a shorter prefix or substituted digest fails closed. Open Session observation and Detach do not rotate or rewrite managed-agent, process, ownership, nonce, environment, or generation authority.

Only after that validation does Herdr write one terminal-standard bracketed paste through `pane.send_text` and send one separate `enter` through `pane.send_keys` to that same managed pane. Multiline, Unicode, and shell metacharacters remain literal prompt text; terminal control bytes are rejected before input. This automated harness transport is not human Take Control.

The initial submission state is durably advanced from `not_submitted` through text staging and one submit action. A deterministic local authority rejection before `pane.send_text` becomes `text_stage_rejected` with safe mismatch field names and known `input_side_effect=none`; `text_stage_uncertain` is reserved for a write whose outcome cannot be proven. Once Enter may have been sent, QE never writes or submits the prompt again. Antigravity's append-only native `Sending user message to conversation <id>` evidence is the acceptance and conversation-identity authority; ambiguity remains `agent_prompt_uncertain`. `HandleUserInput` or `Starting new conversation` alone is not acceptance: 1.2.7 may next report `Ignoring user message, no active conversation` and `SendUserMessage failed`. A retained live process uses the same pane transport for a later authorized message. `--conversation <exact-id>` remains only a process-start recovery identity when the retained process must be recreated; it is not message transport. The Stop hook continues the same live native turn through its structured `continue` decision and does not relaunch the CLI.

The generic completion lifecycle validates and accepts one semantic `qe_complete_step` submission before starting the separately tracked private-Git export phase. The tool acknowledgement therefore does not wait on checkpoint/export and cannot inherit their runtime as a bridge request timeout. While export is in progress, control status remains responsive and an authorized Stop may settle the native turn without retiring result authority. A final exact Action/Attempt/lineage/generation fence commits the Product-visible export and atomically publishes the result; cancellation, terminal failure, or authority replacement before that fence permits only non-authoritative forensic checkpoint material, never a late Change Set or Product result. Export failure after semantic acceptance is terminal and a second completion submission is rejected. Antigravity has no wall-clock result timeout while its authorized native/provider turn is active; completion omission is bounded by Stop enforcement, and generic post-settlement grace applies only where authoritative settlement is observable. Cancellation and terminal retirement target the exact Herdr pane and stop the mailbox relay. Restart recovery adopts only the exact surviving environment, pane, ownership tokens, session incarnation, and native conversation identity. If the process is absent, the adapter reports absence and never launches on the host. A separately authorized fresh SBX Attempt may start a new TUI or pass a verified conversation ID to `--conversation`.

## Gates and acceptance boundary

Deterministic gates:

```sh
cd workers/bun
bun run check
bun test
```

Opt-in physical no-inference profile gate:

```sh
QE_RUN_SBX_ANTIGRAVITY_LIVE=1 \
QE_SBX_BIN=/absolute/sbx \
bun test test/sbx-antigravity-live.test.ts
```

The gate performs host-native credential readiness, mixed-profile creation, capability/provenance verification, guest placeholder inspection, authenticated `models`, `mcp list`, stop-free restart, and cleanup. It submits no prompt and must print `prompts: 0` and `providerCycles: 0`.

Before any future Work Yard acceptance, run a maintenance Worker (`QE_WORKER_DISPATCH_AVAILABILITY=maintenance`) and execute the Product manifest preflight:

```sh
QE_LOCAL_SESSION_ATTACH_ENABLED=true \
bun run workers/bun/scripts/phase5-antigravity-product-preflight.ts \
  workers/bun/.pi/tmp/phase5-antigravity-preflight/manifest.json
```

It requires the exact model to be unavailable for dispatch because of maintenance mode and requires Open Session to resolve the exact idle Antigravity pane. Then stop that Worker and wait for authoritative `disconnected`. Only a human may subsequently authorize an active Worker and paid inference. Phase 5 followed this boundary and is now closed; its acceptance is not authorization to run another Attempt.

## 51-point implementation gate

1. branch starts from merged `main`;
2. historical Pi profile remains present;
3. one Run profile composes both harnesses;
4. one Run maps to one immutable VM;
5. Antigravity artifact URL is fixed;
6. archive digest is fixed;
7. runtime binary digest is verified;
8. runtime is root-owned/non-writable;
9. updater endpoints are absent at runtime;
10. compatibility is capability-based;
11. model discovery is metadata-only;
12. reasoning discovery is deterministic;
13. exact model selection has no fallback;
14. exact effort selection has no fallback;
15. Herdr uses explicit managed launch;
16. guest executable provenance is absolute;
17. hostile `PATH` cannot select an executable;
18. real interactive TUI remains attachable;
19. guest launch attests environment identity;
20. guest launch attests PhysicalLineage;
21. guest launch attests workspace/cwd;
22. each lineage has private HOME/cache/temp, with every runtime parent agent-owned before seed copies;
23. private Git remains lineage-scoped;
24. `read_only` remains physically non-writable;
25. `read_write` remains private and exportable;
26. source `.git` is never mounted;
27. guest Docker remains Run-private;
28. host filesystem remains unexposed;
29. host native Antigravity execution has no fallback;
30. host command-policy parsing is absent;
31. host state scraping is absent from execution;
32. no `unbash` or adapter containment policy is added;
33. long-lived refresh authority stays host-side;
34. guest ID authority is synthetic/nonsecret;
35. guest refresh is disabled;
36. access substitution is provider-host scoped;
37. static QE MCP registration is profile-owned;
38. MCP child liveness is proven per descriptor;
39. current bridge binding is independently proven;
40. Stop hook is lineage-private;
41. native hook discovery is proven;
42. synthetic Stop readiness performs no inference;
43. structured completion remains generic;
44. HumanAttention remains generic/native-state correlated;
45. Take Control model switching is fenced;
46. cancellation targets exact owned execution;
47. retained recovery requires exact identity;
48. fresh recovery never host-launches;
49. checkpoint/export ordering is unchanged;
50. opt-in live gate reports zero prompts/provider cycles;
51. one human-authorized paid Antigravity Product Attempt proved exactly-once live-TUI input, phase-aware semantic acknowledgement, asynchronous private-Git export, Change Set binding, independent final-tree validation, and Product terminal success without retry.
