# Claude ProviderAccount profile v2: exact token-exchange egress

## Proven defect and correction boundary

Claude Code remains pinned, unmodified, at `2.1.292` from
`@anthropic-ai/claude-agent-sdk` `0.3.292`. Static inspection of that exact
vendor artifact proves that the manual subscription-login path posts the
accepted authorization code, state, and locally retained PKCE verifier to
`https://platform.claude.com/v1/oauth/token`.

The failed physical acceptance established this chain without retaining native
sensitive output:

```text
human response
  -> Product commit
  -> exact Worker delivery
  -> UTF8(composite) + LF
  -> Claude readline parser accepts matching shape
  -> Claude begins post-input OAuth/token-exchange path
  -> required host = platform.claude.com
  -> qe-claude-account-v1 denies that host
  -> native Claude exits nonzero
  -> QE projects setup_process_failed
  -> canonical auth remains authentication_required / none
```

The resulting classification is **C — proven local QE/native runtime defect**.
Provider rejection and authorization-code expiry are not the root cause. The
correction changes only the account-cell egress contract. Response framing,
interaction recognition, durable HumanAttention, delivery certainty,
supervision, diagnostic-output handling, and the vendor executable are
unchanged.

## Immutable profile lineage

`qe-claude-account-v1` is retained byte-for-byte with its historical meaning:

```text
profile: qe-claude-account-v1
digest:  sha256:b4d5723cdfb6269b405a576f9907d6722042e70353441985064da9b170a0791e
runtime hosts: api.anthropic.com, claude.ai
```

The corrected profile is a new immutable identity:

```text
profile: qe-claude-account-v2
digest:  sha256:29d3f1aace792402b6d7f34e7ac7b66c97f2348656ed7e307672cf6cce7325a2
runtime hosts: api.anthropic.com, claude.ai, platform.claude.com
```

The repository profile-spec delta is exactly:

1. kit name `qe-claude-account-v1` -> `qe-claude-account-v2`;
2. kit version `1.0.0` -> `2.0.0`; and
3. one exact allowlist entry, `platform.claude.com`.

The TypeScript identity definition correspondingly advances schema/profile/kit
identity, attests the new spec hash, and uses the corrected reviewed runtime
host set. Every non-spec v2 asset is byte-identical to v1. V1 is not deleted,
alias-rewritten, or selected for new account cells.

### V2 repository artifact hashes

| Asset | SHA-256 |
| --- | --- |
| `spec.yaml` | `cb94093b1e9e8224aa329c050bfe20592f6dc90682a69bd36cc7c172b8b08a8f` |
| `files/home/.qe-profile/package.json` | `840ef323a329d91fe6004f003ff18acb9f0d0f421806199f431184008849f148` |
| `files/home/.qe-profile/package-lock.json` | `f42fa3fc374686574f538ec032a44bd2a55889829fadadb9e0f9a68016aefd04` |
| `files/home/.qe-profile/qe-account-cell-bridge.py` | `de6ad713da03942580acad89a56ebc5386cd429e47976145a455301fd05e0f2d` |
| `files/home/.qe-profile/managed/managed-settings.json` | `8892df943a117000b24e716de0884c093ac062dfff5db84ea1754a28acb38ae7` |
| `files/home/.qe-profile/claude-plugins/.claude-plugin/marketplace.json` | `9cd6b7ead0683ce0d14d486e802255eaacc02de131a138ca3e31a108765ad8f0` |
| `files/home/.qe-profile/claude-plugins/plugins/qe-account-cell/.claude-plugin/plugin.json` | `d791ac66f94713a542a1143b5963c27645ec179704fe3a9ef00c8d2e08e35e63` |
| `files/home/.qe-profile/claude-plugins/plugins/qe-account-cell/hooks/hooks.json` | `4c5247cda3cf88eb551c7822a2b386e0654c8b97a8dfb37289a2816073a7d1e0` |
| `files/home/.qe-profile/claude-plugins/plugins/qe-account-cell/hooks/register.ts` | `ca14976dfa66570d0405eeaae853effc63f22493e76316cce6a6c252028fc53a` |
| `files/home/.qe-profile/claude-plugins/plugins/qe-account-cell/tsconfig.json` | `4087cf0ba92fde503ed0e7c56f37bcb26ad0c085873f10219d0336c0f19b5a8f` |

Asset verification requires an exact regular-file inventory and exact hashes.
The profile digest is reproducibly derived from the immutable TypeScript
profile definition. Tests hard-pin both v1 and v2 full digests, verify both
asset trees, prove all non-spec files equal, and reduce the v2 spec to the v1
spec using only the three reviewed edits above.

## Reviewed pinned endpoint inventory

The endpoint contract is reviewed source data, not an arbitrary scrape of every
hostname in the vendor bundle.

| Host | Phase | Account-cell egress? |
| --- | --- | --- |
| `claude.com` | Human-browser authorization authority (`/cai/oauth/authorize`) | No. The URL is followed by the human browser outside the cell. |
| `platform.claude.com` | Manual callback/success authority and post-input OAuth token exchange (`/v1/oauth/token`) | Yes. Exact hostname only. |
| `api.anthropic.com` | OAuth profile/role validation and subsequent authenticated account runtime | Yes. Exact hostname only. |
| `claude.ai` | Subscription-login client metadata and authenticated Claude.ai account control | Yes. Exact hostname only. |

The canonical account-runtime set and the v2 profile runtime set are therefore
both exactly:

```text
api.anthropic.com
claude.ai
platform.claude.com
```

`registry.npmjs.org` remains the pre-existing profile-build grant and is
sandbox-scoped denied after installation; it is not a provider runtime host.
The real verifier requires that deny and proves the install target is
unreachable at runtime. The same existing SBX hostname policy supplies ordinary
DNS and TLS connectivity for the three exact runtime names. There is no custom
proxy, TLS interception, wildcard, CIDR grant, unrestricted HTTPS, arbitrary
DNS authority, or dynamically discovered provider host.

`workers/bun/src/execution-environment/claude-subscription-endpoints.ts` owns the
reviewed endpoint manifest. `workers/bun/test/claude-account-profile.test.ts`
checks the installed vendor package version and binary checksum, then requires
exact 2.1.292 source markers for the production endpoint constants, the
manual authorization-code function, its `POST` to `TOKEN_URL`, and the profile
fetch through `BASE_API_URL`. The test reads the binary only; it neither
executes Claude nor performs network traffic.

The contract-completeness tests require parity among the reviewed manifest,
TypeScript runtime set, v2 profile definition, and v2 YAML spec. Inverse tests
permit no provider runtime host beyond that set. Real-verifier fixtures reject
missing `platform.claude.com`, `*.claude.com`, `*.anthropic.com`, an unrelated
host, `**`, and `0.0.0.0/0`.

## Production selection and identity decisions

Fresh production `anthropic` ProviderAccount environment specs select
`qe-claude-account-v2`. Current execution and setup fences require the exact v2
profile ID and digest. No Product or Worker schema changed, and no migration
rewrites historical ProviderAccount rows or environment records. A future
acceptance must use completely fresh Product, Worker, account, environment, and
setup state.

Other immutable identities remain unchanged for deliberate reasons:

- `qe-claude-broker-run-v1` is credential-free, deny-all, and unaffected. Its
  digest remains
  `sha256:876fead36f50dd1377f5d8ad8b2cc22b46203358d996c8659698785be92a865e`.
- `claude-code-2.1.292-subscription-login-v1` identifies the exact executable,
  `auth login` argv, environment, streamed-process options, and recognizer. It
  does not encode the separately fenced SBX profile/network policy, so its
  identity and behavior remain unchanged.
- `claude-code-2.1.292-subscription-v1` identifies subscription invocation and
  status-classification semantics. Profile/network identity is carried by the
  environment evidence, so the auth-configuration identity remains unchanged.
- `claude-subscription-explicit-environment-v1` describes the explicit
  authentication environment-variable allowlist. No environment variable
  changed, so this identity remains unchanged.
- `qe_claude_account_cell_v1`, the managed Mod, bridge, binary hashes, setup
  recognizer, Worker Protocol, Product schema, Worker environment schema, and
  setup ledger schema remain unchanged.

Raw native stderr remains discarded, auth output remains non-persistent, and a
nonzero login process still projects generic `setup_process_failed`. This
correction adds no native-output classifier.

## Validation boundary

All correction validation is provider-free: immutable asset/digest checks,
static pinned-runtime inspection, deterministic profile parity/exactness,
real-verifier policy fixtures, fresh provisioning selection, and existing
setup/HumanAttention/byte/reconnect/supervision regressions. It authorizes no
real Claude login, credential operation, provider request, model turn, or Phase
E activity.
