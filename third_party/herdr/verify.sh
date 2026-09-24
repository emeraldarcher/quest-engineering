#!/bin/sh
set -eu

usage() {
  echo "usage: $0 BUILD_ROOT" >&2
  exit 64
}

fail() {
  echo "Herdr verification failed: $*" >&2
  exit 1
}

[ "$#" -eq 1 ] || usage

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
# shellcheck disable=SC1091
. "$SCRIPT_DIR/upstream.txt"
PATCH="$SCRIPT_DIR/patches/0001-explicit-managed-agent-launch.patch"
BUILD_ROOT=$(CDPATH= cd -- "$1" && pwd)
SOURCE="$BUILD_ROOT/source"
BINARY="$BUILD_ROOT/bin/herdr"
MANIFEST="$BUILD_ROOT/build-provenance.json"
VERIFY_HOME="$BUILD_ROOT/vh"
VERIFY_BIN_DIR="$BUILD_ROOT/verify-bin"
SESSION=v
SERVER_LOG="$BUILD_ROOT/verify-server.log"
SCHEMA="$BUILD_ROOT/api-schema.json"
PING="$BUILD_ROOT/ping.json"
RECORD="$BUILD_ROOT/explicit-launch-record.txt"
PATH_TRAP_MARKER="$BUILD_ROOT/path-trap-invoked"
SHELL_MARKER="$BUILD_ROOT/shell-restored"
EXPLICIT_AGENT="$BUILD_ROOT/explicit-agent.sh"
PATH_TRAP="$VERIFY_BIN_DIR/pi"
ZIG_BIN="$BUILD_ROOT/toolchains/zig-$HERDR_ZIG_TARGET-$HERDR_ZIG_VERSION/zig"

sha256_file() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  else
    shasum -a 256 "$1" | awk '{print $1}'
  fi
}

[ -x "$BINARY" ] || fail "built Herdr binary is missing or not executable: $BINARY"
[ -x "$ZIG_BIN" ] && [ "$($ZIG_BIN version)" = "$HERDR_ZIG_VERSION" ] || \
  fail "pinned Zig toolchain is missing or incompatible: $ZIG_BIN"
[ -f "$MANIFEST" ] || fail "build provenance is missing: $MANIFEST"
[ "$(sha256_file "$PATCH")" = "$HERDR_PATCH_SHA256" ] || \
  fail "committed Herdr patch digest changed"
[ "$(git -C "$SOURCE" rev-parse HEAD)" = "$HERDR_PATCH_COMMIT" ] || \
  fail "reconstructed Herdr source is not at the accepted patch commit"
[ "$(git -C "$SOURCE" rev-parse 'HEAD^{tree}')" = "$HERDR_PATCH_TREE" ] || \
  fail "reconstructed Herdr source tree differs from the accepted patched tree"
[ -z "$(git -C "$SOURCE" status --short)" ] || \
  fail "reconstructed Herdr source is dirty before verification"
[ "$(sha256_file "$SOURCE/Cargo.lock")" = "$HERDR_CARGO_LOCK_SHA256" ] || \
  fail "reconstructed Herdr Cargo.lock changed"

binary_sha=$(sha256_file "$BINARY")
BINARY_SHA="$binary_sha" \
MANIFEST="$MANIFEST" \
HERDR_UPSTREAM_COMMIT="$HERDR_UPSTREAM_COMMIT" \
HERDR_PATCH_COMMIT="$HERDR_PATCH_COMMIT" \
HERDR_PATCH_SHA256="$HERDR_PATCH_SHA256" \
python3 - <<'PY'
import json
import os
from pathlib import Path

value = json.loads(Path(os.environ["MANIFEST"]).read_text())
expected = {
    "upstreamCommit": os.environ["HERDR_UPSTREAM_COMMIT"],
    "patchCommit": os.environ["HERDR_PATCH_COMMIT"],
    "patchSha256": os.environ["HERDR_PATCH_SHA256"],
    "binarySha256": os.environ["BINARY_SHA"],
}
for key, wanted in expected.items():
    if value.get(key) != wanted:
        raise SystemExit(f"build provenance {key} mismatch: {value.get(key)!r}")
PY

[ "$($BINARY --version)" = "herdr 0.9.0" ] || \
  fail "reconstructed Herdr version output is unexpected"

# Compile and run focused unit coverage through the patched API schema and app
# paths. Exact process transport is exercised against the release binary below.
# This deliberately avoids Herdr's socket-before-app-ready integration-test race.
(
  cd "$SOURCE"
  ZIG="$ZIG_BIN" cargo test --locked --bin herdr \
    api::schema::tests::agent_start_and_prompt_requests_round_trip -- --exact
  ZIG="$ZIG_BIN" cargo test --locked --bin herdr \
    app::tests::unavailable_agent_start_does_not_mutate_topology -- --exact
  ZIG="$ZIG_BIN" cargo test --locked --bin herdr \
    app::tests::failed_agent_start_input_rolls_back_and_can_retry -- --exact
)

rm -rf "$VERIFY_HOME" "$VERIFY_BIN_DIR"
mkdir -p "$VERIFY_HOME" "$VERIFY_BIN_DIR"
rm -f "$RECORD" "$PATH_TRAP_MARKER" "$SHELL_MARKER" "$BUILD_ROOT/shell-injection"

cat >"$PATH_TRAP" <<EOF
#!/bin/sh
printf '%s\n' invoked >'$PATH_TRAP_MARKER'
exit 99
EOF
chmod 0755 "$PATH_TRAP"

cat >"$EXPLICIT_AGENT" <<EOF
#!/bin/sh
{
  printf 'cwd=<%s>\\n' "\$PWD"
  printf 'env=<%s>\\n' "\$QE_LITERAL"
  printf 'managed-kind=<%s>\\n' "\$HERDR_AGENT"
  index=0
  for arg in "\$@"; do
    printf 'arg[%s]=<%s>\\n' "\$index" "\$arg"
    index=\$((index + 1))
  done
} >'$RECORD'
"\$HERDR_BIN_PATH" pane report-agent "\$HERDR_PANE_ID" \
  --source qe:herdr-reproduction --agent pi --state idle >/dev/null
while IFS= read -r line; do :; done
EOF
chmod 0755 "$EXPLICIT_AGENT"

SOCKET="$VERIFY_HOME/.config/herdr/sessions/$SESSION/herdr.sock"
CLIENT_SOCKET="$VERIFY_HOME/.config/herdr/sessions/$SESSION/herdr-client.sock"
SOCKET="$SOCKET" CLIENT_SOCKET="$CLIENT_SOCKET" BUILD_ROOT="$BUILD_ROOT" python3 - <<'PY'
import os

root = os.fsencode(os.environ["BUILD_ROOT"] + os.sep)
for name in ("SOCKET", "CLIENT_SOCKET"):
    path = os.fsencode(os.environ[name])
    if not path.startswith(root):
        raise SystemExit(f"{name} escapes the disposable build root: {os.environ[name]}")
    # macOS sockaddr_un includes the terminating byte. Match QE's conservative
    # production Herdr path bound and fail before endpoint setup does.
    if len(path) >= 104:
        raise SystemExit(f"{name} is too long ({len(path)} bytes): {os.environ[name]}")
PY

HOME="$VERIFY_HOME" HERDR_CONFIG_PATH="$VERIFY_HOME/config.toml" \
  PATH="$VERIFY_BIN_DIR:$PATH" \
  "$BINARY" --session "$SESSION" server >"$SERVER_LOG" 2>&1 &
SERVER_PID=$!
server_stopped=0
stop_server() {
  if [ "$server_stopped" -eq 0 ]; then
    HOME="$VERIFY_HOME" HERDR_CONFIG_PATH="$VERIFY_HOME/config.toml" \
      "$BINARY" --session "$SESSION" session stop --json "$SESSION" >/dev/null 2>&1 || true
    wait "$SERVER_PID" 2>/dev/null || true
    server_stopped=1
  fi
}
trap stop_server EXIT HUP INT TERM

ready=0
attempt=0
while [ "$attempt" -lt 200 ]; do
  if [ -S "$SOCKET" ]; then
    ready=1
    break
  fi
  if ! kill -0 "$SERVER_PID" 2>/dev/null; then
    break
  fi
  attempt=$((attempt + 1))
  sleep 0.05
done
[ "$ready" -eq 1 ] || fail "Herdr server did not become ready; see $SERVER_LOG"
# Herdr publishes the socket just before its app request loop is ready.
sleep 1

SOCKET="$SOCKET" \
PING="$PING" \
BUILD_ROOT="$BUILD_ROOT" \
BINARY="$BINARY" \
EXPLICIT_AGENT="$EXPLICIT_AGENT" \
RECORD="$RECORD" \
SHELL_MARKER="$SHELL_MARKER" \
python3 - <<'PY'
import json
import os
import shlex
import socket
import time
from pathlib import Path

socket_path = os.environ["SOCKET"]
build_root = os.environ["BUILD_ROOT"]


def request(request_id, method, params=None):
    payload = {"id": request_id, "method": method, "params": params or {}}
    client = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    client.settimeout(10)
    client.connect(socket_path)
    client.sendall((json.dumps(payload) + "\n").encode())
    line = client.makefile("rb").readline()
    client.close()
    if not line:
        raise AssertionError(f"Herdr closed the connection for {method}")
    return json.loads(line)


ping = request("qe-reproduction-ping", "ping")
Path(os.environ["PING"]).write_text(json.dumps(ping, indent=2) + "\n")
result = ping.get("result", {})
capabilities = result.get("capabilities", {})
assert result.get("version") == "0.9.0", ping
assert result.get("protocol") == 22, ping
assert capabilities.get("endpoint_protocol_generation") == 1, ping
assert capabilities.get("agent_explicit_launch") is True, ping

workspace = request(
    "qe-explicit-workspace",
    "workspace.create",
    {"cwd": build_root, "label": "QE explicit launch verification", "focus": False, "env": {}},
)
pane_id = workspace["result"]["root_pane"]["pane_id"]

invalid = request(
    "qe-invalid-explicit-command",
    "agent.start",
    {
        "name": "invalid-explicit",
        "kind": "pi",
        "pane_id": pane_id,
        "command": {"executable": "relative-command"},
    },
)
assert invalid.get("error", {}).get("code") == "invalid_agent_command", invalid

literal_args = ["argument with spaces", "$(touch shell-injection)", ""]
started = request(
    "qe-explicit-start",
    "agent.start",
    {
        "name": "qe-explicit",
        "kind": "pi",
        "pane_id": pane_id,
        "command": {
            "executable": os.environ["EXPLICIT_AGENT"],
            "args": literal_args,
            "cwd": build_root,
            "env": {
                "HERDR_BIN_PATH": os.environ["BINARY"],
                "QE_LITERAL": "literal environment value",
            },
        },
        "timeout_ms": 30_000,
    },
)
assert started.get("result", {}).get("type") == "agent_started", started
assert started["result"].get("argv") == [os.environ["EXPLICIT_AGENT"], *literal_args], started

deadline = time.monotonic() + 10
while True:
    agent = request("qe-explicit-get", "agent.get", {"target": "qe-explicit"})
    if agent.get("result", {}).get("agent", {}).get("agent_status") == "idle":
        break
    if time.monotonic() >= deadline:
        raise AssertionError(f"explicit managed agent did not become idle: {agent}")
    time.sleep(0.05)

record = Path(os.environ["RECORD"]).read_text()
expected_lines = [
    f"cwd=<{build_root}>",
    "env=<literal environment value>",
    "managed-kind=<pi>",
    "arg[0]=<argument with spaces>",
    "arg[1]=<$(touch shell-injection)>",
    "arg[2]=<>",
]
for expected in expected_lines:
    assert expected in record.splitlines(), (expected, record)

failure_workspace = request(
    "qe-failure-workspace",
    "workspace.create",
    {"cwd": build_root, "label": "QE failure verification", "focus": False, "env": {}},
)
failure_pane = failure_workspace["result"]["root_pane"]["pane_id"]
missing = os.path.join(build_root, "missing-explicit-agent")
failure_started = request(
    "qe-failure-start",
    "agent.start",
    {
        "name": "qe-failed-explicit",
        "kind": "pi",
        "pane_id": failure_pane,
        "command": {"executable": missing, "args": [], "cwd": build_root},
        "timeout_ms": 8_000,
    },
)
assert failure_started.get("result", {}).get("type") == "agent_started", failure_started

deadline = time.monotonic() + 10
while True:
    failure = request(
        "qe-failure-reconcile",
        "agent.start",
        {
            "name": "qe-failed-explicit",
            "kind": "pi",
            "pane_id": failure_pane,
            "timeout_ms": 8_000,
        },
    )
    code = failure.get("error", {}).get("code")
    if code == "agent_explicit_launch_failed":
        break
    assert code in {"agent_name_taken", "agent_pane_busy"}, failure
    if time.monotonic() >= deadline:
        raise AssertionError(f"explicit launch failure stayed ambiguous: {failure}")
    time.sleep(0.05)

deadline = time.monotonic() + 10
shell_command = "/usr/bin/touch " + shlex.quote(os.environ["SHELL_MARKER"])
while True:
    sent = request(
        "qe-restored-shell-text",
        "pane.send_text",
        {"pane_id": failure_pane, "text": shell_command},
    )
    if sent.get("result", {}).get("type") == "ok":
        entered = request(
            "qe-restored-shell-enter",
            "pane.send_keys",
            {"pane_id": failure_pane, "keys": ["Enter"]},
        )
        assert entered.get("result", {}).get("type") == "ok", entered
        break
    if time.monotonic() >= deadline:
        raise AssertionError(f"pane shell was not restored: {sent}")
    time.sleep(0.05)
while not os.path.exists(os.environ["SHELL_MARKER"]):
    if time.monotonic() >= deadline:
        raise AssertionError("restored shell command did not run")
    time.sleep(0.05)
PY

[ ! -e "$PATH_TRAP_MARKER" ] || fail "explicit launch resolved managed kind through PATH"
[ ! -e "$BUILD_ROOT/shell-injection" ] || fail "explicit launch interpreted an argument as shell text"

HOME="$VERIFY_HOME" HERDR_CONFIG_PATH="$VERIFY_HOME/config.toml" \
  "$BINARY" --session "$SESSION" api schema --json >"$SCHEMA"
SCHEMA="$SCHEMA" python3 - <<'PY'
import json
import os
from pathlib import Path

schema = json.loads(Path(os.environ["SCHEMA"]).read_text())
defs = schema["schemas"]["request"]["$defs"]
params = defs["AgentStartParams"]
command = defs["AgentStartCommand"]
if "command" not in params.get("properties", {}):
    raise SystemExit("agent.start schema omits params.command")
if "executable" not in set(command.get("required", [])):
    raise SystemExit("AgentStartCommand does not require executable")
for key in ("executable", "args", "cwd", "env"):
    if key not in command.get("properties", {}):
        raise SystemExit(f"AgentStartCommand omits {key}")
PY

stop_server
trap - EXIT HUP INT TERM

[ -z "$(git -C "$SOURCE" status --short)" ] || \
  fail "reconstructed Herdr source became dirty during verification"

printf '%s\n' "Herdr verification passed"
printf '  upstream commit: %s\n' "$HERDR_UPSTREAM_COMMIT"
printf '  patch commit: %s\n' "$HERDR_PATCH_COMMIT"
printf '  patch sha256: %s\n' "$HERDR_PATCH_SHA256"
printf '  binary sha256: %s\n' "$binary_sha"
printf '  accepted binary match: %s\n' "$([ "$binary_sha" = "$HERDR_ACCEPTED_BINARY_SHA256" ] && echo yes || echo no)"
printf '  live capability: agent_explicit_launch=true\n'
printf '  live launch: absolute executable, literal argv/env/cwd, PATH bypass\n'
printf '  live failure: typed error with pane shell restoration\n'
printf '  schema: agent.start.command present\n'
