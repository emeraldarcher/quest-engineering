#!/bin/sh
set -eu

usage() {
  echo "usage: $0 BUILD_ROOT" >&2
  echo "BUILD_ROOT must be absent or an empty directory." >&2
  exit 64
}

[ "$#" -eq 1 ] || usage

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
# shellcheck disable=SC1091
. "$SCRIPT_DIR/upstream.txt"
PATCH="$SCRIPT_DIR/patches/0001-explicit-managed-agent-launch.patch"
BUILD_ROOT=$1
SOURCE="$BUILD_ROOT/source"
OUTPUT="$BUILD_ROOT/bin/herdr"
MANIFEST="$BUILD_ROOT/build-provenance.json"

sha256_file() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  else
    shasum -a 256 "$1" | awk '{print $1}'
  fi
}

if [ -e "$BUILD_ROOT" ]; then
  [ -d "$BUILD_ROOT" ] || {
    echo "build root is not a directory: $BUILD_ROOT" >&2
    exit 1
  }
  [ -z "$(find "$BUILD_ROOT" -mindepth 1 -maxdepth 1 -print -quit)" ] || {
    echo "build root is not empty; refusing to reuse or delete it: $BUILD_ROOT" >&2
    exit 1
  }
else
  mkdir -p "$BUILD_ROOT"
fi
BUILD_ROOT=$(CDPATH= cd -- "$BUILD_ROOT" && pwd)
SOURCE="$BUILD_ROOT/source"
OUTPUT="$BUILD_ROOT/bin/herdr"
MANIFEST="$BUILD_ROOT/build-provenance.json"
ZIG_ARCHIVE="$BUILD_ROOT/toolchains/zig.tar.xz"
ZIG_ROOT="$BUILD_ROOT/toolchains/zig-$HERDR_ZIG_TARGET-$HERDR_ZIG_VERSION"
ZIG_BIN="$ZIG_ROOT/zig"

actual_patch_sha=$(sha256_file "$PATCH")
[ "$actual_patch_sha" = "$HERDR_PATCH_SHA256" ] || {
  echo "Herdr patch digest mismatch: $actual_patch_sha" >&2
  exit 1
}
actual_toolchain_sha=$(sha256_file "$SCRIPT_DIR/rust-toolchain.toml")
[ "$actual_toolchain_sha" = "$HERDR_RUST_TOOLCHAIN_SHA256" ] || {
  echo "Herdr toolchain metadata digest mismatch: $actual_toolchain_sha" >&2
  exit 1
}

mkdir -p "$SOURCE"
git -C "$SOURCE" init --quiet
git -C "$SOURCE" remote add origin "$HERDR_UPSTREAM_URL"
git -C "$SOURCE" fetch --quiet --depth=1 --no-tags origin "$HERDR_UPSTREAM_COMMIT"
git -C "$SOURCE" fetch --quiet --depth=1 origin "refs/tags/$HERDR_UPSTREAM_TAG:refs/tags/$HERDR_UPSTREAM_TAG"

actual_tag_object=$(git -C "$SOURCE" rev-parse "refs/tags/$HERDR_UPSTREAM_TAG")
actual_tag_commit=$(git -C "$SOURCE" rev-parse "refs/tags/$HERDR_UPSTREAM_TAG^{commit}")
[ "$actual_tag_object" = "$HERDR_UPSTREAM_TAG_OBJECT" ] || {
  echo "Herdr tag object mismatch: $actual_tag_object" >&2
  exit 1
}
[ "$actual_tag_commit" = "$HERDR_UPSTREAM_COMMIT" ] || {
  echo "Herdr tag commit mismatch: $actual_tag_commit" >&2
  exit 1
}

git -C "$SOURCE" checkout --quiet --detach "$HERDR_UPSTREAM_COMMIT"
actual_upstream_tree=$(git -C "$SOURCE" rev-parse 'HEAD^{tree}')
[ "$actual_upstream_tree" = "$HERDR_UPSTREAM_TREE" ] || {
  echo "Herdr upstream tree mismatch: $actual_upstream_tree" >&2
  exit 1
}
actual_lock_sha=$(sha256_file "$SOURCE/Cargo.lock")
[ "$actual_lock_sha" = "$HERDR_CARGO_LOCK_SHA256" ] || {
  echo "Herdr Cargo.lock digest mismatch: $actual_lock_sha" >&2
  exit 1
}
cmp -s "$SOURCE/rust-toolchain.toml" "$SCRIPT_DIR/rust-toolchain.toml" || {
  echo "Herdr upstream rust-toolchain.toml differs from QE's recorded copy." >&2
  exit 1
}

git -C "$SOURCE" apply --check "$PATCH"
# Recreate the accepted patch commit exactly. The committer identity is patch
# provenance, not a runtime credential; the author timestamp comes from the
# format-patch Date header.
GIT_COMMITTER_NAME="$HERDR_PATCH_COMMITTER_NAME" \
GIT_COMMITTER_EMAIL="$HERDR_PATCH_COMMITTER_EMAIL" \
  git -C "$SOURCE" am --quiet --committer-date-is-author-date "$PATCH"
actual_patch_commit=$(git -C "$SOURCE" rev-parse HEAD)
actual_patch_tree=$(git -C "$SOURCE" rev-parse 'HEAD^{tree}')
[ "$actual_patch_commit" = "$HERDR_PATCH_COMMIT" ] || {
  echo "Herdr patch commit mismatch: $actual_patch_commit" >&2
  exit 1
}
[ "$actual_patch_tree" = "$HERDR_PATCH_TREE" ] || {
  echo "Herdr patched tree mismatch: $actual_patch_tree" >&2
  exit 1
}

git -C "$SOURCE" diff --check "$HERDR_UPSTREAM_COMMIT..$HERDR_PATCH_COMMIT"

[ "$(uname -s)" = "Darwin" ] && [ "$(uname -m)" = "arm64" ] || {
  echo "This accepted-binary recipe currently requires Darwin arm64; add reviewed Zig and linker provenance before enabling another target." >&2
  exit 1
}
for tool in xcodebuild xcrun; do
  command -v "$tool" >/dev/null 2>&1 || {
    echo "required Apple toolchain command is missing: $tool" >&2
    exit 1
  }
done
actual_xcode_version=$(xcodebuild -version | awk 'NR == 1 { print; exit }')
actual_xcode_build=$(xcodebuild -version | awk 'NR == 2 { print $3; exit }')
actual_sdk_version=$(xcrun --sdk macosx --show-sdk-version)
actual_sdk_build=$(xcrun --sdk macosx --show-sdk-build-version)
actual_sdk_path=$(xcrun --sdk macosx --show-sdk-path)
actual_sdk_settings_sha=$(sha256_file "$actual_sdk_path/SDKSettings.json")
actual_ld_version=$(xcrun ld -v 2>&1 | awk 'NR == 1 { print; exit }')
actual_clang_version=$(xcrun clang --version | awk 'NR == 1 { print; exit }')
[ "$actual_xcode_version" = "$HERDR_XCODE_VERSION" ] || {
  echo "Xcode version mismatch: $actual_xcode_version" >&2
  exit 1
}
[ "$actual_xcode_build" = "$HERDR_XCODE_BUILD" ] || {
  echo "Xcode build mismatch: $actual_xcode_build" >&2
  exit 1
}
[ "$actual_sdk_version" = "$HERDR_APPLE_SDK_VERSION" ] || {
  echo "Apple SDK version mismatch: $actual_sdk_version" >&2
  exit 1
}
[ "$actual_sdk_build" = "$HERDR_APPLE_SDK_BUILD" ] || {
  echo "Apple SDK build mismatch: $actual_sdk_build" >&2
  exit 1
}
[ "$actual_sdk_settings_sha" = "$HERDR_APPLE_SDK_SETTINGS_SHA256" ] || {
  echo "Apple SDK settings digest mismatch: $actual_sdk_settings_sha" >&2
  exit 1
}
[ "$actual_ld_version" = "$HERDR_APPLE_LD_VERSION" ] || {
  echo "Apple linker version mismatch: $actual_ld_version" >&2
  exit 1
}
[ "$actual_clang_version" = "$HERDR_APPLE_CLANG_VERSION" ] || {
  echo "Apple clang version mismatch: $actual_clang_version" >&2
  exit 1
}

mkdir -p "$(dirname -- "$ZIG_ARCHIVE")"
curl --fail --silent --show-error --location "$HERDR_ZIG_URL" --output "$ZIG_ARCHIVE"
actual_zig_sha=$(sha256_file "$ZIG_ARCHIVE")
[ "$actual_zig_sha" = "$HERDR_ZIG_SHA256" ] || {
  echo "Zig toolchain artifact digest mismatch: $actual_zig_sha" >&2
  exit 1
}
tar -xJf "$ZIG_ARCHIVE" -C "$(dirname -- "$ZIG_ROOT")"
[ -x "$ZIG_BIN" ] || {
  echo "Pinned Zig executable is missing after extraction: $ZIG_BIN" >&2
  exit 1
}
[ "$($ZIG_BIN version)" = "$HERDR_ZIG_VERSION" ] || {
  echo "Pinned Zig executable reported an unexpected version." >&2
  exit 1
}
(
  cd "$SOURCE"
  MACOSX_DEPLOYMENT_TARGET="$HERDR_MACOS_DEPLOYMENT_TARGET" \
    ZIG="$ZIG_BIN" cargo build --locked --release
)
mkdir -p "$(dirname -- "$OUTPUT")"
install -m 0755 "$SOURCE/target/release/herdr" "$OUTPUT"

binary_sha=$(sha256_file "$OUTPUT")
rustc_verbose=$(cd "$SOURCE" && rustc -vV)
cargo_verbose=$(cd "$SOURCE" && cargo -vV)
RUSTC_VERBOSE="$rustc_verbose" \
CARGO_VERBOSE="$cargo_verbose" \
ZIG_VERSION="$($ZIG_BIN version)" \
ZIG_SHA256="$actual_zig_sha" \
XCODE_VERSION="$actual_xcode_version" \
XCODE_BUILD="$actual_xcode_build" \
SDK_VERSION="$actual_sdk_version" \
SDK_BUILD="$actual_sdk_build" \
SDK_SETTINGS_SHA256="$actual_sdk_settings_sha" \
LD_VERSION="$actual_ld_version" \
CLANG_VERSION="$actual_clang_version" \
MACOSX_DEPLOYMENT_TARGET="$HERDR_MACOS_DEPLOYMENT_TARGET" \
BINARY_SHA="$binary_sha" \
BUILD_ROOT="$BUILD_ROOT" \
OUTPUT="$OUTPUT" \
MANIFEST="$MANIFEST" \
HERDR_UPSTREAM_COMMIT="$HERDR_UPSTREAM_COMMIT" \
HERDR_UPSTREAM_TAG="$HERDR_UPSTREAM_TAG" \
HERDR_PATCH_COMMIT="$HERDR_PATCH_COMMIT" \
HERDR_PATCH_SHA256="$HERDR_PATCH_SHA256" \
HERDR_ACCEPTED_TARGET="$HERDR_ACCEPTED_TARGET" \
HERDR_ACCEPTED_BINARY_SHA256="$HERDR_ACCEPTED_BINARY_SHA256" \
python3 - <<'PY'
import json
import os
import platform
from pathlib import Path

manifest = {
    "schemaVersion": 1,
    "upstreamTag": os.environ["HERDR_UPSTREAM_TAG"],
    "upstreamCommit": os.environ["HERDR_UPSTREAM_COMMIT"],
    "patchCommit": os.environ["HERDR_PATCH_COMMIT"],
    "patchSha256": os.environ["HERDR_PATCH_SHA256"],
    "binary": str(Path(os.environ["OUTPUT"])),
    "binarySha256": os.environ["BINARY_SHA"],
    "acceptedTarget": os.environ["HERDR_ACCEPTED_TARGET"],
    "acceptedBinarySha256": os.environ["HERDR_ACCEPTED_BINARY_SHA256"],
    "matchesAcceptedBinary": os.environ["BINARY_SHA"] == os.environ["HERDR_ACCEPTED_BINARY_SHA256"],
    "platform": platform.platform(),
    "machine": platform.machine(),
    "rustc": os.environ["RUSTC_VERBOSE"].splitlines(),
    "cargo": os.environ["CARGO_VERBOSE"].splitlines(),
    "zig": {
        "version": os.environ["ZIG_VERSION"],
        "archiveSha256": os.environ["ZIG_SHA256"],
    },
    "appleToolchain": {
        "xcodeVersion": os.environ["XCODE_VERSION"],
        "xcodeBuild": os.environ["XCODE_BUILD"],
        "sdkVersion": os.environ["SDK_VERSION"],
        "sdkBuild": os.environ["SDK_BUILD"],
        "sdkSettingsSha256": os.environ["SDK_SETTINGS_SHA256"],
        "linker": os.environ["LD_VERSION"],
        "clang": os.environ["CLANG_VERSION"],
        "deploymentTarget": os.environ["MACOSX_DEPLOYMENT_TARGET"],
    },
}
Path(os.environ["MANIFEST"]).write_text(json.dumps(manifest, indent=2) + "\n")
PY

printf '%s\n' "Herdr build complete"
printf '  source: %s\n' "$SOURCE"
printf '  binary: %s\n' "$OUTPUT"
printf '  sha256: %s\n' "$binary_sha"
printf '  accepted binary match: %s\n' "$([ "$binary_sha" = "$HERDR_ACCEPTED_BINARY_SHA256" ] && echo yes || echo no)"
printf '  provenance: %s\n' "$MANIFEST"
