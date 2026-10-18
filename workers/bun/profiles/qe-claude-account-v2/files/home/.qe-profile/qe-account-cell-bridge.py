#!/usr/bin/python3
"""Fixed account-cell capability bridge. It has no workspace or network client."""
import hashlib
import json
import os
import pathlib
import sys
import time
import uuid

PROTOCOL = "qe_claude_account_cell_bridge_v1"
MAX_INPUT = 1_048_576
MAX_OUTPUT = 65_536


def fail(message: str, code: int = 2) -> None:
    sys.stderr.write(message[:1024] + "\n")
    raise SystemExit(code)


def exact_object(value, label: str):
    if not isinstance(value, dict):
        fail(f"{label} must be an object")
    return value


def main() -> None:
    if len(sys.argv) != 2 or sys.argv[1] not in (
        "bound-operation",
        "bound-human-attention-wait",
    ):
        fail("unsupported bridge invocation")
    raw = sys.stdin.buffer.read(MAX_INPUT + 1)
    if not raw or len(raw) > MAX_INPUT:
        fail("bridge input is missing or too large")
    try:
        operation = exact_object(json.loads(raw), "operation")
    except Exception:
        fail("bridge input is not valid JSON")
    mailbox = os.environ.get("QE_ACCOUNT_CELL_MAILBOX", "")
    token = os.environ.get("QE_ACCOUNT_CELL_BRIDGE_TOKEN", "")
    if not mailbox.startswith("/qe/control/claude/") or len(token) != 64:
        fail("bridge authority is unavailable")
    root = pathlib.Path(mailbox)
    requests = root / "requests"
    responses = root / "responses"
    if not requests.is_dir() or not responses.is_dir():
        fail("bridge mailbox is unavailable")
    request_id = str(uuid.uuid4())
    key = hashlib.sha256(request_id.encode()).hexdigest()
    request_path = requests / f"{key}.json"
    response_path = responses / f"{key}.json"
    envelope = {
        "protocol": PROTOCOL,
        "token": token,
        "requestId": request_id,
        "operation": operation,
    }
    encoded = (json.dumps(envelope, separators=(",", ":")) + "\n").encode()
    temporary = requests / f".{key}.{os.getpid()}.tmp"
    fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    try:
        os.write(fd, encoded)
        os.fsync(fd)
    finally:
        os.close(fd)
    os.replace(temporary, request_path)
    deadline = None if sys.argv[1] == "bound-human-attention-wait" else time.monotonic() + 45
    try:
        while deadline is None or time.monotonic() < deadline:
            try:
                data = response_path.read_bytes()
            except FileNotFoundError:
                time.sleep(0.05)
                continue
            if len(data) > MAX_OUTPUT:
                fail("bridge response is too large")
            try:
                response = exact_object(json.loads(data), "response")
            except Exception:
                fail("bridge response is invalid")
            if (
                set(response) != {"protocol", "requestId", "ok", "result", "error"}
                or response.get("protocol") != PROTOCOL
                or response.get("requestId") != request_id
                or not isinstance(response.get("ok"), bool)
            ):
                fail("bridge response identity is invalid")
            if not response["ok"]:
                error = response.get("error")
                message = error.get("message") if isinstance(error, dict) else None
                fail(message if isinstance(message, str) else "bridge request was rejected", 3)
            sys.stdout.write(json.dumps(response["result"], separators=(",", ":")))
            return
        fail("bridge response timed out", 4)
    finally:
        try:
            request_path.unlink()
        except FileNotFoundError:
            pass
        try:
            response_path.unlink()
        except FileNotFoundError:
            pass


if __name__ == "__main__":
    main()
