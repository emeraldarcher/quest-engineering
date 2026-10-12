# Claude Code Mod harness spike

This is a **zero-inference, non-production** fixture for the Claude harness
reassessment. It targets the Mods API embedded in Claude Code `2.1.292` and is
kept because it records executable evidence that a Mod can:

- register QE completion and HumanAttention tools;
- mediate tool calls and permission decisions fail-closed;
- refuse a model or effort mismatch at `turn.step`, before a mocked provider request;
- disable subagents;
- invoke QE's existing `qe-harness-bridge local-control` transport for
  structured completion;
- block native Stop with a QE correction;
- map lifecycle facts to current generic QE harness event shapes and preserve an
  opaque native session reference without a terminal identity; and
- hold a tool call open while a streamed local helper waits for a mocked human
  response.

The tests run under `claude plugin test`, which Anthropic documents as running
without a session, sign-in, or network. They never invoke a model.

## Deliberate gap

`local-control-wait` and the
`request_human_assistance_and_wait` operation are a proposed generic control
bridge extension, not current production behavior. The current bridge can
create a HumanAttention request but cannot keep a Mod call waiting and return
the eventual structured human response. A production Mod architecture would
need that provider-neutral operation (including cancellation and process-loss
semantics) before it could claim structured-attention parity.

No production adapter or bridge code is changed by this spike.

## Validate

Using the exact pinned Claude Code binary:

```sh
claude plugin validate spikes/claude-mod-harness
workers/bun/node_modules/.bin/tsc -p spikes/claude-mod-harness/tsconfig.json
claude plugin test spikes/claude-mod-harness
```

The expected test result is `10 pass, 0 fail` with Claude Code `2.1.292`.
