#!/bin/sh
set -eu

[ "$#" -eq 1 ] || {
  echo "usage: $0 BUILD_ROOT" >&2
  exit 64
}

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
"$SCRIPT_DIR/build.sh" "$1"
"$SCRIPT_DIR/verify.sh" "$1"
