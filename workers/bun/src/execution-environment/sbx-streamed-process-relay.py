# Generic QE streamed-process relay. Target payloads are bytes; only relay
# identity/exit/I/O control records are JSON. The target is launched with literal
# argv and shell=False.
import base64
import ctypes
import hashlib
import json
import os
import signal
import stat
import struct
import subprocess
import sys
import threading
import time

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
IO_SNAPSHOT = 14
# First versioned relay control extension. No Product/Worker protocol change.
RELAY_PROTOCOL_VERSION = 2
WRITE = 20
CLOSE_STDIN = 21
CANCEL = 22
OBSERVE_IO = 23
MAX_FRAME = 1024 * 1024 + 64

output = sys.stdout.buffer
output_lock = threading.Lock()
process = None
terminating = threading.Event()
io_lock = threading.Lock()
io_sender_lock = threading.Lock()
io_counts = {STDOUT: 0, STDERR: 0}
io_counts_available = True
io_identity = None
io_pipe_identity = None
io_started_ns = time.monotonic_ns()
io_before_cancellation = None
io_requested = False


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


def executable_identity(pid):
    value = os.stat(f"/proc/{pid}/exe")
    return f"{value.st_dev}:{value.st_ino}"


def count_output(frame_type, size):
    # First operation after os.read: no decoding, framing, recognition, or hashing.
    global io_counts_available
    try:
        with io_lock:
            io_counts[frame_type] += size
            if io_counts[frame_type] > 9007199254740991:
                io_counts_available = False
    except Exception:
        io_counts_available = False


def same_live_identity():
    return (
        io_identity is not None
        and start_identity(process.pid) == io_identity["startIdentity"]
        and os.readlink(f"/proc/{process.pid}/exe")
        == io_identity["observedExecutable"]
        and executable_identity(process.pid)
        == io_identity["observedExecutableIdentity"]
    )


def stdin_observation():
    # Use only our retained writer fd. Never reopen a target fd or read its data.
    if sys.platform != "linux":
        return {"status": "unavailable", "reason": "unsupported_ioctl"}
    if process.returncode is not None:
        return {"status": "unavailable", "reason": "process_exited"}
    if process.stdin is None or process.stdin.closed:
        return {"status": "unavailable", "reason": "closed"}
    try:
        import array
        import fcntl
        import termios

        fd = process.stdin.fileno()
        info = os.fstat(fd)
        if not stat.S_ISFIFO(info.st_mode):
            return {"status": "unavailable", "reason": "not_pipe"}
        if io_pipe_identity != (info.st_dev, info.st_ino):
            return {"status": "unavailable", "reason": "observation_failed"}
        unread = array.array("i", [0])
        fcntl.ioctl(fd, termios.FIONREAD, unread, True)
        after = os.fstat(fd)
        if process.stdin.closed:
            return {"status": "unavailable", "reason": "closed"}
        if io_pipe_identity != (after.st_dev, after.st_ino):
            return {"status": "unavailable", "reason": "observation_failed"}
        if unread[0] < 0:
            raise ValueError("invalid pipe count")
        return {"status": "observed", "unreadBytes": unread[0]}
    except (AttributeError, ImportError):
        return {"status": "unavailable", "reason": "unsupported_ioctl"}
    except OSError as error:
        import errno

        reason = (
            "closed" if error.errno == errno.EBADF else
            "unsupported_ioctl" if error.errno in (
                errno.ENOTTY, errno.EINVAL, errno.ENOSYS, errno.EOPNOTSUPP
            ) else "observation_failed"
        )
        return {"status": "unavailable", "reason": reason}
    except Exception:
        return {"status": "unavailable", "reason": "observation_failed"}


def io_snapshot():
    try:
        if io_identity is None:
            return {"status": "unavailable", "reason": "unsupported"}
        # Terminal snapshots use this Popen's retained identity/counters, never a PID lookup.
        terminal = process.returncode is not None
        if not terminal and not same_live_identity():
            return {"status": "unavailable", "reason": "identity_mismatch"}
        stdin = stdin_observation()
        with io_lock:
            if not io_counts_available:
                return {"status": "unavailable", "reason": "observation_failed"}
            sample = {
                "observedAt": time.time_ns() // 1000000,
                "elapsedMs": (time.monotonic_ns() - io_started_ns) // 1000000,
                "stdin": stdin,
                "stdoutBytes": io_counts[STDOUT],
                "stderrBytes": io_counts[STDERR],
                "terminal": "observed" if terminal else "not_observed",
            }
        if not terminal and not same_live_identity():
            return {"status": "unavailable", "reason": "identity_mismatch"}
        return {
            "status": "available", "identity": io_identity,
            "sample": sample, "beforeCancellation": io_before_cancellation,
        }
    except Exception:
        return {"status": "unavailable", "reason": "observation_failed"}


def send_io(request_id=None, value=None):
    # Never wait for output_lock or channel space. On Linux, writable readiness
    # of an ordinary pipe guarantees PIPE_BUF space. Under our sole-writer lock,
    # one <= PIPE_BUF os.write is atomic/nonblocking without changing fd flags.
    # Any other channel/type/size/readiness loses only this diagnostic snapshot.
    locked = False
    try:
        import select

        snapshot = io_snapshot() if value is None else value
        payload = json.dumps(
            {"protocolVersion": RELAY_PROTOCOL_VERSION,
             "requestId": request_id, "observation": snapshot},
            separators=(",", ":"),
        ).encode("utf-8")
        frame = struct.pack(">BI", IO_SNAPSHOT, len(payload)) + payload
        fd = output.fileno()
        if (
            sys.platform != "linux" or not stat.S_ISFIFO(os.fstat(fd).st_mode)
            or len(frame) > os.fpathconf(fd, "PC_PIPE_BUF")
        ):
            return
        locked = output_lock.acquire(blocking=False)
        if locked and select.select([], [fd], [], 0)[1]:
            os.write(fd, frame)
    except Exception:
        pass
    finally:
        if locked:
            output_lock.release()


def request_io(payload):
    global io_requested
    # One bounded diagnostic sender, separate from the stdin/cancellation loop.
    # Backpressure can lose a snapshot, never gate a later CANCEL command.
    try:
        request = json.loads(payload)
        request_id = request.get("requestId")
        if not isinstance(request_id, str) or len(request_id) != 36:
            return
        io_requested = True
        if not io_sender_lock.acquire(blocking=False):
            return

        def reply():
            try:
                if (
                    request.get("protocolVersion") != RELAY_PROTOCOL_VERSION
                    or request.get("identity") != io_identity
                ):
                    send_io(request_id, {
                        "status": "unavailable", "reason": "identity_mismatch"
                    })
                else:
                    send_io(request_id)
            finally:
                io_sender_lock.release()

        try:
            threading.Thread(target=reply, daemon=True).start()
        except Exception:
            io_sender_lock.release()
    except Exception:
        pass


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
            # BufferedReader.read(size) may wait for the whole size while the
            # long-lived target is waiting for input. os.read returns the bytes
            # currently available, so short prompts are supervised immediately.
            chunk = os.read(stream.fileno(), 16384)
            if not chunk:
                break
            count_output(frame_type, len(chunk))
            send(frame_type, chunk)
        send(eof_type)
    except (BrokenPipeError, OSError):
        terminate_target()


def input_loop():
    global io_before_cancellation
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
                # Fixed existing checkpoint, not a monitor or wait for an observer.
                if io_requested:
                    try:
                        before = io_snapshot()
                        if before.get("status") == "available":
                            io_before_cancellation = before["sample"]
                    except Exception:
                        pass
                try:
                    process.terminate()
                    send(CANCEL_ACK, request_id)
                except ProcessLookupError:
                    send(CANCEL_REJECTED, request_id)
                except OSError:
                    # The signal outcome cannot be proven and is deliberately
                    # not retried or escalated by this relay.
                    return
            elif frame_type == OBSERVE_IO:
                request_io(payload)
            else:
                terminate_target()
                return
    except (BrokenPipeError, OSError):
        terminate_target()


def on_relay_signal(_signum, _frame):
    terminate_target()


def main():
    global process, io_identity, io_pipe_identity
    if (
        len(sys.argv) < 8
        or sys.argv[2] != "--environment-names-base64"
        or sys.argv[4] != "--process-generation"
        or sys.argv[6] != "--"
    ):
        send_json(RELAY_ERROR, {"code": "invalid_argv"})
        return 125
    marker_path = sys.argv[1]
    target_argv = sys.argv[7:]
    try:
        encoded_environment_names = sys.argv[3]
        padding = "=" * (-len(encoded_environment_names) % 4)
        environment_names = json.loads(
            base64.b64decode(encoded_environment_names + padding, validate=True)
        )
        if (
            not isinstance(environment_names, list)
            or len(environment_names) != len(set(environment_names))
            or any(
                not isinstance(name, str)
                or not name
                or name not in os.environ
                for name in environment_names
            )
        ):
            raise ValueError("invalid target environment")
        target_environment = {
            name: os.environ[name] for name in environment_names
        }
    except Exception:
        send_json(RELAY_ERROR, {"code": "invalid_environment"})
        return 125
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
            env=target_environment,
        )
    except Exception:
        send_json(RELAY_ERROR, {"code": "spawn_not_started"})
        return 126
    try:
        observed = os.readlink(f"/proc/{process.pid}/exe")
        started = start_identity(process.pid)
        marker_sha256 = hashlib.sha256(open(marker_path, "rb").read()).hexdigest()
    except Exception:
        terminate_target()
        send_json(RELAY_ERROR, {"code": "spawn_identity_unavailable"})
        return 126

    # Additional diagnostic identity is best-effort, not a new spawn prerequisite.
    observed_executable_identity = None
    try:
        observed_executable_identity = executable_identity(process.pid)
        pipe = os.fstat(process.stdin.fileno())
        io_pipe_identity = (pipe.st_dev, pipe.st_ino)
        io_identity = {
            "pid": str(process.pid), "startIdentity": started,
            "observedExecutable": observed,
            "observedExecutableIdentity": observed_executable_identity,
            "processGeneration": sys.argv[5],
            "environmentMarkerSha256": marker_sha256,
        }
    except Exception:
        pass
    send_json(
        READY,
        {
            "protocolVersion": RELAY_PROTOCOL_VERSION,
            "observedExecutableIdentity": observed_executable_identity,
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
    if io_requested:
        send_io()  # Bounded final counters plus the pre-cancellation sample, if any.
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
