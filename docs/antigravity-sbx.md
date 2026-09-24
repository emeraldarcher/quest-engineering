# Antigravity in the Run-owned SBX architecture

## Decision

Antigravity is an `AgentHarness` in the same immutable Run environment as Pi. The selected profile is `qe-coding-execution-v1`; it composes lockfile-pinned Pi 0.85.1 and digest-pinned Antigravity 1.2.7. `qe-pi-execution-v2` remains unchanged for historical provenance. A harness change never means one VM per harness.

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

SBX substitutes the access token only for `daily-cloudcode-pa.googleapis.com`. Tokens are absent from QE durable state, guest files, launch argv, diagnostics, and retained secret metadata.

## Permission and state decisions

Antigravity launches with `--dangerously-skip-permissions` **inside the outer SBX only**. The optional native `--sandbox` is deliberately disabled. This avoids two conflicting isolation models and makes root-owned read-only/read-write workspace permissions, private Git, private HOME, exact network grants, disabled ambient credentials, and Worker control authority decisive. The protocol retains `native_permissions` as the compatibility marker because Antigravity has no stable low-level tool catalog; it is not a claim that host command parsing is authoritative.

Each PhysicalLineage gets a deterministic private HOME under `/qe/state/antigravity-lineages/`. Only profile-owned nonsecret credential markers and MCP registration are seeded into it. Native conversation and other retained state survive Attempt and Worker recovery without becoming shared mutable host state. The Stop hook lives in that HOME, not in source, so read-only source stays physically read-only.

## Completion, attention, cancellation, and recovery

MCP is only transport. `HarnessControlAuthority` remains the authority for typed completion, HumanAttention, Stop enforcement, stale-context fencing, and idempotency. The guest MCP child must publish startup/liveness evidence for the exact descriptor path; current authority is checked independently. The guest Stop command must be discovered by Antigravity and pass a synthetic zero-inference call before authorization. A real Stop payload reporting a different model fences the PhysicalLineage after Take Control rather than accepting a silent switch.

The generic completion boundary checkpoints and exports private Git before result acceptance. Cancellation and terminal retirement target the exact Herdr pane and stop the mailbox relay. Restart recovery adopts only the exact surviving environment, pane, ownership tokens, session incarnation, and native conversation identity. If the process is absent, the adapter reports absence and never launches on the host. A separately authorized fresh SBX Attempt may start a new TUI or pass a verified conversation ID to `--conversation`.

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

Before any larger Work Yard acceptance, run a maintenance Worker (`QE_WORKER_DISPATCH_AVAILABILITY=maintenance`) and execute the Product manifest preflight:

```sh
QE_LOCAL_SESSION_ATTACH_ENABLED=true \
bun run workers/bun/scripts/phase5-antigravity-product-preflight.ts \
  workers/bun/.pi/tmp/phase5-antigravity-preflight/manifest.json
```

It requires the exact model to be unavailable for dispatch because of maintenance mode and requires Open Session to resolve the exact idle Antigravity pane. Then stop that Worker and wait for authoritative `disconnected`. Only a human may subsequently authorize an active Worker and paid inference. This change does not perform that acceptance.

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
22. each lineage has private HOME/cache/temp;
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
51. paid mixed-harness Product acceptance remains human-gated and unstarted.
