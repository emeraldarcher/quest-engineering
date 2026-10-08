# Generic QE streamed-process relay. Protocol payloads are bytes; only relay
# identity/exit control records are JSON. The target is launched with literal
# argv and shell=False.
import ctypes
import hashlib
import json
import os
import signal
import struct
import subprocess
import sys
import threading

READY = 1
STDOUT = 2
STDERR = 3
STDOUT_EOF = 4
STDERR_EOF = 5
WRITE_ACK = 6
WRITE_REJECTED = 7
WRITE_AMBIGUOUS = 8
CANCEL_ACK = 9
CANCEL_REJECTED = 10
EXIT = 11
RELAY_ERROR = 12
CLOSE_ACK = 13
WRITE = 20
CLOSE_STDIN = 21
CANCEL = 22
MAX_FRAME = 1024 * 1024 + 64

output = sys.stdout.buffer
output_lock = threading.Lock()
process = None
terminating = threading.Event()


def send(frame_type, payload=b""):
    with output_lock:
        output.write(struct.pack(">BI", frame_type, len(payload)))
        output.write(payload)
        output.flush()


def send_json(frame_type, value):
    send(frame_type, json.dumps(value, separators=(",", ":")).encode("utf-8"))


def read_exact(stream, size):
    chunks = []
    remaining = size
    while remaining:
        chunk = stream.read(remaining)
        if not chunk:
            return None
        chunks.append(chunk)
        remaining -= len(chunk)
    return b"".join(chunks)


def start_identity(pid):
    stat = open(f"/proc/{pid}/stat", "rb").read().decode("ascii")
    close = stat.rfind(")")
    fields_from_state = stat[close + 2 :].split()
    return fields_from_state[19]


def terminate_target():
    global process
    if terminating.is_set():
        return
    terminating.set()
    if process is not None and process.poll() is None:
        try:
            process.terminate()
        except ProcessLookupError:
            pass


def relay_output(stream, frame_type, eof_type):
    try:
        while True:
            chunk = stream.read(16384)
            if not chunk:
                break
            send(frame_type, chunk)
        send(eof_type)
    except (BrokenPipeError, OSError):
        terminate_target()


def input_loop():
    source = sys.stdin.buffer
    try:
        while True:
            header = read_exact(source, 5)
            if header is None:
                terminate_target()
                return
            frame_type, size = struct.unpack(">BI", header)
            if size > MAX_FRAME:
                terminate_target()
                return
            payload = read_exact(source, size)
            if payload is None:
                terminate_target()
                return
            if frame_type == WRITE:
                request_id = payload[:36]
                data = payload[36:]
                written = 0
                try:
                    if process.poll() is not None or process.stdin is None:
                        send(WRITE_REJECTED, request_id)
                        continue
                    while written < len(data):
                        count = process.stdin.write(data[written:])
                        if count is None:
                            count = 0
                        if count <= 0:
                            raise BrokenPipeError("target stdin accepted no bytes")
                        written += count
                    process.stdin.flush()
                    send(WRITE_ACK, request_id)
                except (BrokenPipeError, OSError, ValueError):
                    send(
                        WRITE_REJECTED if written == 0 else WRITE_AMBIGUOUS,
                        request_id,
                    )
            elif frame_type == CLOSE_STDIN:
                request_id = payload
                try:
                    if process.poll() is not None or process.stdin is None:
                        send(WRITE_REJECTED, request_id)
                        continue
                    process.stdin.close()
                    send(CLOSE_ACK, request_id)
                except (BrokenPipeError, OSError, ValueError):
                    send(WRITE_AMBIGUOUS, request_id)
            elif frame_type == CANCEL:
                request_id = payload
                if process.poll() is not None:
                    send(CANCEL_REJECTED, request_id)
                    continue
                try:
                    process.terminate()
                    send(CANCEL_ACK, request_id)
                except ProcessLookupError:
                    send(CANCEL_REJECTED, request_id)
                except OSError:
                    # The signal outcome cannot be proven and is deliberately
                    # not retried or escalated by this relay.
                    return
            else:
                terminate_target()
                return
    except (BrokenPipeError, OSError):
        terminate_target()


def on_relay_signal(_signum, _frame):
    terminate_target()


def main():
    global process
    if len(sys.argv) < 4 or sys.argv[2] != "--":
        send_json(RELAY_ERROR, {"code": "invalid_argv"})
        return 125
    marker_path = sys.argv[1]
    target_argv = sys.argv[3:]
    if not os.path.isabs(target_argv[0]):
        send_json(RELAY_ERROR, {"code": "executable_not_absolute"})
        return 125

    # If the SBX exec parent disappears, request one SIGTERM for the relay.
    try:
        libc = ctypes.CDLL(None)
        libc.prctl(1, signal.SIGTERM)
    except Exception:
        pass
    signal.signal(signal.SIGTERM, on_relay_signal)
    signal.signal(signal.SIGINT, on_relay_signal)

    try:
        process = subprocess.Popen(
            target_argv,
            shell=False,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            bufsize=0,
            close_fds=True,
        )
        observed = os.readlink(f"/proc/{process.pid}/exe")
        started = start_identity(process.pid)
        marker_sha256 = hashlib.sha256(open(marker_path, "rb").read()).hexdigest()
    except Exception:
        terminate_target()
        send_json(RELAY_ERROR, {"code": "spawn_failed"})
        return 126

    send_json(
        READY,
        {
            "pid": str(process.pid),
            "startIdentity": started,
            "observedExecutable": observed,
            "environmentMarkerSha256": marker_sha256,
        },
    )
    stdout_thread = threading.Thread(
        target=relay_output, args=(process.stdout, STDOUT, STDOUT_EOF), daemon=True
    )
    stderr_thread = threading.Thread(
        target=relay_output, args=(process.stderr, STDERR, STDERR_EOF), daemon=True
    )
    stdin_thread = threading.Thread(target=input_loop, daemon=True)
    stdout_thread.start()
    stderr_thread.start()
    stdin_thread.start()

    return_code = process.wait()
    stdout_thread.join()
    stderr_thread.join()
    if return_code < 0:
        try:
            signal_name = signal.Signals(-return_code).name
        except ValueError:
            signal_name = f"SIGNAL_{-return_code}"
        send_json(EXIT, {"kind": "signaled", "signal": signal_name})
    else:
        send_json(EXIT, {"kind": "exited", "exitCode": return_code})
    return 0


try:
    raise SystemExit(main())
except (BrokenPipeError, OSError):
    terminate_target()
    raise SystemExit(127)
