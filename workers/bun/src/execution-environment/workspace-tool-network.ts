import type { StreamedProcessCommand } from "./types.ts";

const NETWORK_ISOLATION_SUPERVISOR = [
  "import json,os,signal,subprocess,sys",
  "environment_names=json.loads(sys.argv[1]);target=sys.argv[2:]",
  "if not target or not target[0].startswith('/') or any(not isinstance(item,str) for item in environment_names): sys.exit(64)",
  "environment=['%s=%s'%(name,os.environ[name]) for name in environment_names]",
  "argv=['/usr/bin/sudo','-n','/usr/bin/unshare','--net','--','/usr/bin/setpriv','--reuid=1000','--regid=1000','--clear-groups','--no-new-privs','--bounding-set=-all','--inh-caps=-all','--ambient-caps=-all','--','/usr/bin/env','-i',*environment,*target]",
  "child=subprocess.Popen(argv,stdin=sys.stdin.buffer,stdout=sys.stdout.buffer,stderr=sys.stderr.buffer,start_new_session=True,close_fds=True)",
  "def forward(number,frame):",
  " try: os.killpg(child.pid,number)",
  " except ProcessLookupError: pass",
  "for number in (signal.SIGTERM,signal.SIGINT,signal.SIGHUP): signal.signal(number,forward)",
  "sys.exit(child.wait())",
].join("\n");

/**
 * Fixed supervisor that gives each broker endpoint a fresh Linux network
 * namespace. The observed streamed-process executable remains python while its
 * fixed child retains only Worker-attached stdio and no generic network route.
 */
export function networkIsolatedWorkspaceToolCommand(
  command: StreamedProcessCommand,
): StreamedProcessCommand {
  const environmentNames = Object.keys(command.environment).sort();
  return {
    executable: "/usr/bin/python3",
    args: [
      "-u",
      "-c",
      NETWORK_ISOLATION_SUPERVISOR,
      JSON.stringify(environmentNames),
      command.executable,
      ...command.args,
    ],
    cwd: command.cwd,
    environment: command.environment,
  };
}
