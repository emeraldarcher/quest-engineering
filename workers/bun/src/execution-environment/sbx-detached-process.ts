/**
 * Exact Linux detached-process cancellation used by current production SBX
 * supervision and the independently isolated one-time containment tool.
 *
 * The caller must durably cross its own side-effect boundary before invoking
 * this program. The program opens a pidfd, revalidates marker/start/executable,
 * and submits exactly one SIGTERM through that pidfd.
 */
export const DETACHED_PROCESS_CANCELLATION_PROGRAM = [
  "import hashlib,json,os,pathlib,signal,sys",
  "marker=pathlib.Path('/qe/state/environment-ownership.json')",
  "pid_text=os.environ.get('QE_PID','')",
  "cancellation_id=os.environ.get('QE_CANCELLATION_ID','')",
  "def done(status,code): print(json.dumps({'status':status},separators=(',',':'))); raise SystemExit(code)",
  "if not marker.is_file() or hashlib.sha256(marker.read_bytes()).hexdigest()!=sys.argv[1]: done('identity_mismatch',4)",
  "if not cancellation_id: done('identity_mismatch',4)",
  "if not pid_text.isdigit(): done('identity_mismatch',4)",
  "pid=int(pid_text)",
  "try: fd=os.pidfd_open(pid,0)",
  "except ProcessLookupError: done('gone',3)",
  "except Exception: done('unavailable',5)",
  "try:",
  " p=pathlib.Path('/proc')/pid_text",
  " if not p.is_dir(): done('gone',3)",
  " stat=(p/'stat').read_text(); close=stat.rfind(')'); fields=stat[close+2:].split()",
  " start=fields[19]; state=fields[0]; exe=os.readlink(p/'exe') if (p/'exe').exists() else ''",
  " if state=='Z': done('gone',3)",
  " if start!=sys.argv[2] or exe!=sys.argv[3]: done('identity_mismatch',4)",
  " signal.pidfd_send_signal(fd,signal.SIGTERM,None,0)",
  " done('signalled',0)",
  "finally: os.close(fd)",
].join("\n");
