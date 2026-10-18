import type { ProviderAccountSetupRuntimeIdentity } from "../../src/execution-environment/provider-account.ts";
import {
  CLAUDE_LOGIN_INTERACTION_IDENTITY,
  immutableSetupLaunchSpec,
  type ProviderAccountSetupLaunchContext,
  type ProviderAccountSetupLauncher,
  type ProviderAccountSetupLaunchSpec,
} from "../../src/execution-environment/provider-account-setup-launcher.ts";
import type { EnvironmentLease } from "../../src/execution-environment/types.ts";
import type {
  ProviderAuthenticationMethod,
  ProviderAuthenticationState,
} from "../../src/provider-auth.ts";

export const PHYSICAL_ACCEPTANCE_SETUP_LAUNCHER_IDENTITY =
  "qe-physical-claude-login-fixture-v1";
export const PHYSICAL_ACCEPTANCE_FIXTURE_EXECUTABLE =
  "/usr/bin/qe-fake-provider-login";

export type PhysicalAcceptanceFixtureMode =
  | "short"
  | "fragmented"
  | "delayed"
  | "silent"
  | "nonzero";

const FIXTURE_PROGRAM = String.raw`import os,re,signal,sys,time,urllib.parse
mode=sys.argv[1]
secret=os.environ.get("QE_FIXTURE_INTERACTION_SECRET","")
state="s"*43
params=[
 ("code","true"),
 ("client_id","9d1c250a-e61b-44d9-88ed-5944d1962f5e"),
 ("response_type","code"),
 ("redirect_uri","https://platform.claude.com/oauth/code/callback"),
 ("scope","org:create_api_key user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload user:plugins"),
 ("code_challenge","c"*43),
 ("code_challenge_method","S256"),
 ("state",state),
 ("login_hint",secret),
]
url="https://claude.com/cai/oauth/authorize?"+urllib.parse.urlencode(params)
prompt="Opening browser to sign in…\nIf the browser didn't open, visit: "+url+"\nPaste code here if prompted > "
def emit(value):
 sys.stdout.buffer.write(value.encode("utf-8"));sys.stdout.buffer.flush()
if mode=="silent":
 signal.pause()
 sys.exit(90)
if mode=="delayed": time.sleep(1.0)
if mode=="fragmented":
 cuts=[16,55,93,len(prompt)-29,len(prompt)]
 start=0
 for end in cuts:
  emit(prompt[start:end]);start=end;time.sleep(0.05)
else: emit(prompt)
if mode=="nonzero": sys.exit(23)
line=sys.stdin.buffer.readline(4097)
if len(line)>4096: sys.exit(24)
value=line.decode("utf-8","strict").strip()
parts=value.split("#")
if len(parts)!=2 or not re.fullmatch(r"[A-Za-z0-9._~-]+",parts[0]) or parts[1]!=state:
 emit("Invalid code. Please make sure the full code was copied.\n")
 sys.exit(25)
emit("Login successful.\n")
sys.exit(0)
`;
const FIXTURE_BOOTSTRAP = `import base64;exec(base64.b64decode('${Buffer.from(
  FIXTURE_PROGRAM,
).toString("base64")}'))`;

/** Test-only policy. It is imported only by test support and never by Worker startup. */
export class PhysicalAcceptanceSetupLauncher
  implements ProviderAccountSetupLauncher
{
  readonly providerKey = "anthropic";
  readonly executable = PHYSICAL_ACCEPTANCE_FIXTURE_EXECUTABLE;
  readonly interactionRecognizerIdentity = CLAUDE_LOGIN_INTERACTION_IDENTITY;

  constructor(
    readonly mode: PhysicalAcceptanceFixtureMode,
    readonly interactionSecret: string,
    readonly identity = PHYSICAL_ACCEPTANCE_SETUP_LAUNCHER_IDENTITY,
  ) {
    if (
      !/^QE_FAKE_CLAUDE_LOGIN_INTERACTION_SECRET_[A-Za-z0-9_-]+$/.test(
        interactionSecret,
      )
    )
      throw new Error("Physical acceptance interaction secret is invalid.");
  }

  specification(
    context: ProviderAccountSetupLaunchContext,
  ): ProviderAccountSetupLaunchSpec {
    if (context.providerKey !== this.providerKey)
      throw new Error(
        "Physical acceptance launcher requires Anthropic semantics.",
      );
    return immutableSetupLaunchSpec({
      contractVersion: 1,
      launcherIdentity: this.identity,
      providerKey: this.providerKey,
      interactionRecognizerIdentity: this.interactionRecognizerIdentity,
      command: {
        executable: this.executable,
        args: ["-u", "-c", FIXTURE_BOOTSTRAP, this.mode],
        cwd: context.paths.state,
        environment: {
          LANG: "C.UTF-8",
          QE_FIXTURE_INTERACTION_SECRET: this.interactionSecret,
        },
      },
      options: {
        bufferBytes: 64 * 1024,
        acknowledgementTimeoutMs: 30_000,
      },
    });
  }

  async prepare(
    lease: EnvironmentLease,
    spec: ProviderAccountSetupLaunchSpec,
  ): Promise<void> {
    if (
      spec.launcherIdentity !== this.identity ||
      spec.command.executable !== this.executable
    )
      throw new Error("Physical acceptance launch specification is stale.");
    await lease.workerExec({
      executable: "/usr/bin/install",
      args: [
        "-m",
        "0555",
        "-o",
        "0",
        "-g",
        "0",
        "/usr/bin/python3",
        this.executable,
      ],
    });
  }
}

/** Deterministic, provider-free auth inspection: required before launch, ready after exit 0. */
export function physicalAcceptanceAuthentication() {
  const setupInspections = new Map<string, number>();
  return (
    identity: ProviderAccountSetupRuntimeIdentity | null,
  ): {
    state: ProviderAuthenticationState;
    method: ProviderAuthenticationMethod | null;
  } => {
    if (!identity) return { state: "authentication_required", method: "none" };
    const count = setupInspections.get(identity.setupAttemptId) ?? 0;
    setupInspections.set(identity.setupAttemptId, count + 1);
    return count === 0
      ? { state: "authentication_required", method: "none" }
      : { state: "authenticated", method: "provider_account" };
  };
}
