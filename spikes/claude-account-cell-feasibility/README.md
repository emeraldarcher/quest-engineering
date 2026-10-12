# Claude account-cell feasibility spike

This is a **zero-auth, zero-inference, non-production** fixture for
[`docs/claude-account-cell-feasibility.md`](../../docs/claude-account-cell-feasibility.md).
It targets the exact Claude Code `2.1.292` binary bundled through
`@anthropic-ai/claude-agent-sdk@0.3.292`.

The retained Mod demonstrates a broker-only model surface:

- eight QE-owned workspace/control tools are registered under new names;
- native `Read`, `Write`, `Edit`, `Bash`, search, agent, web, MCP, and other
  account-cell tools are not delegated to core;
- every workspace operation reaches one fixed bridge executable as bounded JSON
  on stdin, never as model-selected account-cell argv;
- the Mod contains no `$.fs`, `$.http`, `$.model`, `$.tool.call`,
  `$.agent.spawn`, or `$.prompt.submit` call;
- subagents, unapproved Mods, unknown local commands, unknown tools, malformed
  broker input, and policy failures fail closed; and
- completion and durable HumanAttention remain semantic control operations.

The fake Worker/account/Run model demonstrates workspace and symlink
containment, shell namespace separation on macOS, exact pre-bound routing,
native-session ownership, generation and Run-recovery fencing, logout
quiescence, restart/cleanup separation, a one-way network topology, and
serialized canonical fake credential mutation. The credential fixture is an
explicit canary and is not a provider credential.

## Validate

Using the exact retained Claude Code binary:

```sh
.pi/tmp/claude-mods-reassessment/packages/darwin/claude \
  plugin validate spikes/claude-account-cell-feasibility

workers/bun/node_modules/.bin/tsc \
  -p spikes/claude-account-cell-feasibility/tsconfig.json --noEmit

.pi/tmp/claude-mods-reassessment/packages/darwin/claude \
  plugin test spikes/claude-account-cell-feasibility

workers/bun/node_modules/.bin/tsc \
  -p spikes/claude-account-cell-feasibility/proof-tsconfig.json --noEmit

bun test ./spikes/claude-account-cell-feasibility/proof.check.ts
```

Expected results for the pinned fixture are **12 Mod tests** and **12 fake
architecture tests** with no failures. `claude plugin test` uses mocked engine
events and operations and does not sign in or contact a model.

The safe local startup sequence first sends a fixed synthetic stream-input
message with `shouldQuery: false`, validates `system/init` and its zero-turn
result, and only then sends `/qe_account_cell_probe` to the already validated
Mod. With an empty disposable `CLAUDE_CONFIG_DIR`, `--restricted`, and an exact
`--tools` list, both stages reported `num_turns: 0`, `total_cost_usd: 0`, empty
`modelUsage`, the eight registered tools, and matching Mod/CLI session IDs while
the process remained alive. Sending the slash command before proving that the
Mod loaded is unsafe. The report records the exact evidence and production
constraints.

## Deliberate limits

This fixture does not implement ProviderAccount state, a real broker, Claude
v4, a profile, a protocol, authentication, or provider inference. The network
boundary and restart model are deterministic fakes; physical two-SBX lifecycle
and firewall acceptance remain later gates. Broker shell streaming,
cancellation, output persistence, and side-effect certainty also remain Phase C
work.
