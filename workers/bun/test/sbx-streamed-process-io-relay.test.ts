import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

test("relay counts binary bytes before framing, and ioctl/type/fd failures stay diagnostic", async () => {
  const source = await readFile(
    resolve(
      import.meta.dir,
      "../src/execution-environment/sbx-streamed-process-relay.py",
    ),
    "utf8",
  );
  const definitions = source.slice(
    0,
    source.lastIndexOf("try:\n    raise SystemExit(main())"),
  );
  // Exercise only QE's own relay functions, not Claude, with isolated test dependencies.
  // Host OS ioctl semantics are NOT claimed by these portable unit tests.
  const code = `${definitions}
import types,io,errno,fcntl
seen=[]
def framed(kind,data=b''):
    seen.append((kind,len(data),dict(io_counts)))
send=framed
secret=bytes(range(256))
for kind,eof,data in [(STDOUT,STDOUT_EOF,secret),(STDERR,STDERR_EOF,secret[:19]),(STDOUT,STDOUT_EOF,b'abc')]:
    r,w=os.pipe();os.write(w,data);os.close(w)
    with os.fdopen(r,'rb',buffering=0) as stream: relay_output(stream,kind,eof)
assert io_counts[STDOUT]==259 and io_counts[STDERR]==19
assert seen[0][2][STDOUT]==256 and seen[2][2][STDERR]==19 and seen[4][2][STDOUT]==259
r,w=os.pipe();writer=os.fdopen(w,'wb',buffering=0)
process=types.SimpleNamespace(stdin=writer,returncode=None)
x=os.fstat(w);io_pipe_identity=(x.st_dev,x.st_ino)
sys.platform='linux'
import termios
old=fcntl.ioctl
def success(fd,operation,value,mutate):
    assert operation==termios.FIONREAD and mutate is True
    value[0]=37
fcntl.ioctl=success
assert stdin_observation()=={'status':'observed','unreadBytes':37}
for code,reason in [(errno.ENOTTY,'unsupported_ioctl'),(errno.EINVAL,'unsupported_ioctl'),(errno.EBADF,'closed'),(errno.EPERM,'observation_failed')]:
    def fail(*args): raise OSError(code,'MUST_NOT_BE_PERSISTED')
    fcntl.ioctl=fail
    assert stdin_observation()=={'status':'unavailable','reason':reason}
fcntl.ioctl=success
io_pipe_identity=(0,0)
assert stdin_observation()['reason']=='observation_failed'
writer.close();os.close(r)
assert stdin_observation()['reason']=='closed'
process.stdin=open(os.devnull,'wb',buffering=0)
assert stdin_observation()['reason']=='not_pipe'
process.returncode=0
assert stdin_observation()['reason']=='process_exited'
process.stdin.close()
# Overflow is unavailable, never a wrapped/saturated successful counter.
io_counts[STDOUT]=9007199254740991
count_output(STDOUT,1)
assert io_counts_available is False
# A broken observer cannot stop the original byte relay.
io_counts_available=False
r,w=os.pipe();os.write(w,b'abc');os.close(w)
with os.fdopen(r,'rb',buffering=0) as stream: relay_output(stream,STDOUT,STDOUT_EOF)
assert seen[-2][1]==3 and seen[-1][0]==STDOUT_EOF
# Diagnostic exceptions also cannot prevent original stdin ACK or cancellation.
class Target:
    returncode=None
    stdin=io.BytesIO()
    def poll(self): return self.returncode
    def terminate(self): self.returncode=-15
process=Target();io_requested=True
request=b'11111111-1111-4111-8111-111111111111'
def broken_snapshot(): raise RuntimeError('MUST_NOT_BE_PERSISTED')
io_snapshot=broken_snapshot
wire=struct.pack('>BI',WRITE,39)+request+b'abc'+struct.pack('>BI',CANCEL,36)+request
sys.stdin=types.SimpleNamespace(buffer=io.BytesIO(wire))
input_loop()
assert any(x[0]==WRITE_ACK for x in seen) and any(x[0]==CANCEL_ACK for x in seen)
assert process.returncode==-15 and process.stdin.getvalue()==b'abc'
# Diagnostic delivery never waits for a held normal-output lock or pipe space.
import select
r,w=os.pipe();output=os.fdopen(w,'wb',buffering=0)
io_snapshot=lambda: {'status':'unavailable','reason':'observation_failed'}
output_lock.acquire();send_io(request.decode());output_lock.release()
assert not select.select([r],[],[],0)[0]
original_select=select.select
select.select=lambda *args: ([],[],[])
send_io(request.decode())
select.select=original_select
assert not select.select([r],[],[],0)[0]
send_io(request.decode())
packet=os.read(r,4096)
assert packet[0]==IO_SNAPSHOT and json.loads(packet[5:])['observation']['reason']=='observation_failed'
output.close();os.close(r)
print(json.dumps({'counterPlacement':True,'binaryCounts':[259,19],'failureCategories':True,'originalRelayUnaffected':True,'nonblockingDiagnosticSend':True}))
`;
  const child = Bun.spawn(["/usr/bin/python3", "-B", "-c", code], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const result = await new Response(child.stdout).text();
  // Do not copy subprocess error text into diagnostic evidence/assertion output.
  await new Response(child.stderr).arrayBuffer();
  expect(await child.exited).toBe(0);
  expect(JSON.parse(result)).toEqual({
    counterPlacement: true,
    binaryCounts: [259, 19],
    failureCategories: true,
    originalRelayUnaffected: true,
    nonblockingDiagnosticSend: true,
  });
});
