# Provider credential context proof fixture

This is a deterministic, non-production fixture for
[`docs/provider-credential-context.md`](../../docs/provider-credential-context.md).
It uses a conspicuous fake credential only. It does not import Claude Code, open
provider endpoints, authenticate, or submit a model request.

The fixture models the selected split-cell architecture:

- a persistent provider-account cell owns canonical mutable credential state;
- concurrent provider consumers take one exclusive account lease;
- a Run receives only a generation-fenced context reference;
- workspace filesystem/search tools are rooted in the Run workspace; and
- `terminal.shell` executes in a kernel-enforced namespace that has no read
  capability for the account fixture.

On macOS, the shell proof uses `sandbox-exec` with default-deny file access and
an allowlist for the Run workspace and operating-system runtime files. The
account path and a workspace symlink to it are deliberately supplied to the
adversarial `cat` command but are not named in the sandbox policy; both reads
fail. This is a local analogue of
the stronger production requirement that the account cell and Run be separate
SBX VMs. Other platforms retain the deterministic broker/generation/restart
proofs but skip this macOS-specific physical shell assertion.

Run:

```sh
bun test spikes/provider-credential-context/proof.test.ts
```

The restart test reconstructs Worker/Product/host-process objects over the same
fake account-cell disk and proves the Product projection contains no credential
bytes. It is a contract proof, not a live SBX host-restart acceptance test.
