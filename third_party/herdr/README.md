# QE Herdr explicit-launch dependency

Quest Engineering requires Herdr's generic `agent.explicit_launch` capability for environment-backed Pi and Antigravity sessions. Upstream Herdr `v0.9.0` does not provide it, so QE currently carries one additive, upstream-quality patch. QE selects Herdr by capability—not by a permanent custom version check—so a future upstream binary with the same contract can replace this build.

## Pinned provenance

- upstream: <https://github.com/herdrdev/herdr.git>
- tag: `v0.9.0`
- upstream commit: `b99002ac99b09e00b4ca692436cb15a6b0d676f1`
- QE patch commit: `75bfefe8546df7ec0313d65a700eb3d0f6bee115`
- format-patch SHA-256: `154213d2f00d919ab502006e89b5bb3a4f04ca6d88b682e4828ad7f731031b3a`
- accepted macOS ARM64 binary SHA-256: `37d8fa93f49cac3487105179e91a57d22f4185ca228ae3f6dc2b610a9de4b563`

`upstream.txt` is the machine-readable authority. The patch file is the exact `git format-patch` output for the accepted patch commit. The scripts verify the annotated tag object, upstream commit/tree, patch digest, recreated patch commit/tree, Cargo lock, and toolchain before accepting a build.

## Clean reconstruction

Use a new empty directory. QE agent workflows keep scratch state inside the repository:

```sh
build_root="$(mktemp -d "$PWD/.pi/tmp/herdr-reconstruct.XXXXXX")"
third_party/herdr/reconstruct.sh "$build_root"
```

The reconstruction performs, in order:

1. a fresh fetch of the exact upstream tag and commit;
2. upstream tag, commit, tree, `Cargo.lock`, and toolchain verification;
3. exact patch digest verification and `git am` application;
4. exact patched commit/tree verification;
5. a digest-verified, build-local Zig `0.15.2` toolchain fetch;
6. `cargo build --locked --release` with Rust `1.96.1`;
7. focused API schema and agent-lifecycle unit tests;
8. a disposable release-binary server test proving `ping.capabilities.agent_explicit_launch=true`, absolute executable resolution, literal argv/env/cwd, managed identity, and `PATH` bypass;
9. a release-binary failure test proving a typed launch error and pane-shell restoration;
10. API-schema verification proving `agent.start.params.command` and its executable/args/cwd/env shape; and
11. local binary and Apple toolchain provenance in `BUILD_ROOT/build-provenance.json`.

The release-binary tests use inert local shell fixtures. They do not invoke Pi, Antigravity, or any provider. Herdr publishes its socket before its application request loop is ready, so the verifier explicitly waits across that upstream startup edge instead of relying on the racy upstream PTY test helper.

The scripts never install, unlink, overwrite, or configure a global Herdr binary. Point the Worker at the verified candidate explicitly:

```sh
export QE_HERDR_BIN="$build_root/bin/herdr"
```

Worker startup canonicalizes this absolute path and applies its normal live capability/schema checks. There is no `PATH` fallback. `/opt/homebrew/bin/herdr` remains an intentionally incompatible negative fixture while it lacks `agent.explicit_launch`.

## Toolchain and binary reproducibility

The accepted candidate was built for `aarch64-apple-darwin` with:

- `rustc 1.96.1 (31fca3adb 2026-06-26)`;
- `cargo 1.96.1 (356927216 2026-06-26)`;
- LLVM `22.1.2`;
- Zig `0.15.2`, fetched from the pinned official macOS ARM64 artifact with SHA-256 `3cc2bab367e185cdfb27501c4b30b1b0653c28d9f73df8dc91488e66ece5fa6b`;
- Xcode `16.4` build `16F6`;
- Apple SDK `15.5` build `24F74` with pinned `SDKSettings.json` digest;
- Apple clang `17.0.0 (clang-1700.0.13.5)`;
- Apple linker `ld-1167.5`;
- macOS deployment target `11.0`; and
- the upstream locked dependency graph.

`rust-toolchain.toml` pins Rust/Cargo. `upstream.txt` pins the accepted Apple and Zig toolchain identities, and the build script verifies and records them before compiling.

The clean verification recorded in `verification.json` produced SHA-256 `2a118542ed2d21aabec0b269c79dd0cb8319f1970f517a93b8079eea6a5d7016`, not the accepted artifact hash. A byte comparison found identical size and only 47 differing bytes: the Mach-O `LC_UUID` region and the derived linker ad-hoc code-signature digest. Code, data, source commit/tree, dependency lock, and pinned toolchains were otherwise identical; a second independent clean build produced the same new hash. This is recorded as a non-bit-identical native-link result, never silently treated as the accepted binary.

Rust's source and dependency graph are reproducible across supported hosts, but native linking remains platform/toolchain-specific. Any candidate is accepted for QE use only after exact source/patch/tree/toolchain verification, focused tests, live process/capability/schema probes, and recording its local binary hash. The repository scripts currently fail closed outside the reviewed macOS ARM64 toolchain rather than claiming cross-platform artifact reproducibility.

## Patch contract

The additive `agent.start.command` object carries an absolute executable, literal argv, optional absolute cwd, and environment additions. Herdr executes it without a shell or `PATH` lookup while retaining `kind` as managed integration identity. Invalid paths, NUL-containing values, mixed legacy args, and launch failures fail with typed errors; the pane lifecycle restores its shell. Legacy callers that omit `command` retain upstream behavior.
