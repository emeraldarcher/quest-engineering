import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import {
  SBX_ANTIGRAVITY_AUTH_PATH,
  SBX_ANTIGRAVITY_PROXY_REFRESH_SENTINEL,
} from "../src/execution-environment/sbx-antigravity-credential.ts";
import { SbxExecutionEnvironmentBackend } from "../src/execution-environment/sbx-backend.ts";
import { CliSbxClient } from "../src/execution-environment/sbx-client.ts";
import {
  SBX_ANTIGRAVITY_EXECUTABLE,
  SBX_ANTIGRAVITY_RUNTIME_PROBE,
  SBX_ANTIGRAVITY_VERSION,
  SBX_CODING_EXECUTION_PROFILE_V1,
  SBX_CODING_PROFILE,
  SBX_DISPOSABLE_RESOURCE_POLICY,
  SBX_MIXED_RUNTIME_NETWORK_TARGETS,
} from "../src/execution-environment/sbx-profile.ts";
import type { EnvironmentSpec } from "../src/execution-environment/types.ts";

const enabled = process.env.QE_RUN_SBX_ANTIGRAVITY_LIVE === "1";
const sbxBin = process.env.QE_SBX_BIN ?? "/opt/homebrew/bin/sbx";

test.skipIf(!enabled)(
  "live mixed profile proves Antigravity auth, catalog, MCP registration, and restart without inference",
  async () => {
    const parent = join(process.cwd(), ".pi", "tmp");
    await mkdir(parent, { recursive: true });
    const dataRoot = await mkdtemp(join(parent, "sbx-antigravity-live-"));
    const runId = `antigravity-live-${randomUUID()}`;
    const workerId = `antigravity-live-worker-${randomUUID()}`;
    const backend = new SbxExecutionEnvironmentBackend({
      workerId,
      dataRoot,
      client: new CliSbxClient(sbxBin),
      executionProfile: SBX_CODING_PROFILE,
    });
    const spec: EnvironmentSpec = {
      workerId,
      runId,
      workspace: {
        workspaceId: `workspace-${runId}`,
        access: "none",
        materialization: {
          kind: "disposable_fixture",
          sourceIdentity: "qe-antigravity-live-no-inference",
          frozenBase: { kind: "fixture", value: "none" },
        },
      },
      profile: SBX_CODING_EXECUTION_PROFILE_V1,
      resourcePolicy: SBX_DISPOSABLE_RESOURCE_POLICY.identity,
      networkRequirements: [
        {
          capability: "model_provider",
          targets: SBX_MIXED_RUNTIME_NETWORK_TARGETS,
        },
      ],
      credentialGrants: [
        {
          grantId: "host-openai-oauth",
          kind: "openai-codex-oauth",
          scope: "subscription",
        },
        {
          grantId: "host-antigravity-oauth",
          kind: "antigravity-oauth",
          scope: "subscription",
        },
      ],
      controlChannels: [{ kind: "worker_file_mailbox_v1", required: true }],
      requiredCapabilities: [
        { kind: "filesystem_namespace", mode: "isolated" },
        { kind: "home", mode: "private" },
        { kind: "host_filesystem", mode: "unexposed" },
        { kind: "container_runtime", mode: "isolated" },
        { kind: "harness_runtime", mode: "pi_native_extensions" },
        {
          kind: "harness_runtime",
          mode: "antigravity_capability_contract_v1",
        },
        {
          kind: "credentials",
          mode: "host_mixed_oauth_dynamic_proxies",
        },
        {
          kind: "network_policy",
          mode: "mixed_subscription_providers_only",
        },
        { kind: "control_channel", mode: "worker_file_mailbox_v1" },
        { kind: "pty_launcher", mode: "available" },
      ],
    };
    let ref: Awaited<ReturnType<typeof backend.ensure>>["ref"] | null = null;
    try {
      let lease = await backend.ensure(spec);
      ref = lease.ref;
      const auth = new TextDecoder().decode(
        await lease.readFile({
          path: SBX_ANTIGRAVITY_AUTH_PATH,
          maxBytes: 64_000,
        }),
      );
      expect(auth).toContain("qe-sbx-antigravity-access-");
      expect(auth).toContain(SBX_ANTIGRAVITY_PROXY_REFRESH_SENTINEL);

      const version = await lease.exec({
        executable: SBX_ANTIGRAVITY_EXECUTABLE,
        args: ["--version"],
        environment: { HOME: "/home/agent", BROWSER: "/bin/false" },
        timeoutMs: 30_000,
      });
      expect(version.exitCode).toBe(0);
      expect(version.stdout.trim()).toBe(SBX_ANTIGRAVITY_VERSION);
      const userInfo = await lease.exec({
        executable: "/usr/bin/python3",
        args: [
          "-c",
          `import json,pathlib,subprocess,urllib.parse
credential=json.loads(pathlib.Path('/home/agent/.gemini/antigravity-cli/antigravity-oauth-token').read_text())
result=subprocess.run(['/usr/bin/curl','--silent','--show-error','--header','Authorization: Bearer '+credential['token']['access_token'],'https://www.googleapis.com/oauth2/v2/userinfo','--write-out','\\n%{http_code}'],text=True,capture_output=True,timeout=30)
payload,_,code=result.stdout.rpartition('\\n')
response={}
try: response=json.loads(payload)
except Exception: pass
picture=response.get('picture') if isinstance(response,dict) else None
picture_result=subprocess.run(['/usr/bin/curl','--silent','--show-error','--output','/dev/null','--write-out','%{http_code}',picture],text=True,capture_output=True,timeout=30) if isinstance(picture,str) else None
print(json.dumps({'schemaVersion':1,'exitCode':result.returncode,'httpStatus':int(code) if code.isdigit() else None,'responseTopLevelKeys':sorted(response.keys()),'pictureHostname':urllib.parse.urlparse(picture).hostname if isinstance(picture,str) else None,'pictureHttpStatus':int(picture_result.stdout) if picture_result and picture_result.stdout.isdigit() else None,'credentialSentToPictureHost':False,'credentialRecorded':False},separators=(',',':')))`,
        ],
        environment: { HOME: "/home/agent" },
        timeoutMs: 30_000,
      });
      expect(JSON.parse(userInfo.stdout)).toMatchObject({
        schemaVersion: 1,
        exitCode: 0,
        httpStatus: 200,
        credentialRecorded: false,
        responseTopLevelKeys: expect.arrayContaining(["email", "id"]),
        pictureHostname: "lh3.googleusercontent.com",
        pictureHttpStatus: 200,
        credentialSentToPictureHost: false,
      });
      const models = await lease.exec({
        executable: SBX_ANTIGRAVITY_EXECUTABLE,
        args: ["models"],
        environment: { HOME: "/home/agent", BROWSER: "/bin/false" },
        timeoutMs: 60_000,
      });
      expect(models.exitCode, `${models.stdout}\n${models.stderr}`).toBe(0);
      expect(models.stdout).toMatch(/^\S+\t[^\t]+/m);
      const mcp = await lease.exec({
        executable: SBX_ANTIGRAVITY_EXECUTABLE,
        args: ["mcp", "list"],
        environment: { HOME: "/home/agent", BROWSER: "/bin/false" },
        timeoutMs: 30_000,
      });
      expect(mcp.exitCode).toBe(0);
      expect(mcp.stdout).toMatch(/^qe\s.*\bstdio\b.*\benabled\b/m);
      const contract = await lease.exec({
        executable: "/usr/bin/node",
        args: [SBX_ANTIGRAVITY_RUNTIME_PROBE],
        environment: { HOME: "/home/agent", BROWSER: "/bin/false" },
        timeoutMs: 60_000,
      });
      expect(contract.exitCode, contract.stderr).toBe(0);
      expect(JSON.parse(contract.stdout)).toMatchObject({
        schemaVersion: 1,
        compatible: true,
        provenance: { version: SBX_ANTIGRAVITY_VERSION },
      });

      await backend.stop(ref);
      lease = await backend.recover(ref, spec);
      const afterRestart = await lease.exec({
        executable: SBX_ANTIGRAVITY_EXECUTABLE,
        args: ["--version"],
        environment: { HOME: "/home/agent", BROWSER: "/bin/false" },
      });
      expect(afterRestart.stdout.trim()).toBe(SBX_ANTIGRAVITY_VERSION);
      console.log(
        JSON.stringify({
          event: "sbx_antigravity_no_inference",
          profile: SBX_CODING_EXECUTION_PROFILE_V1,
          modelVariants: models.stdout.trim().split("\n").length,
          prompts: 0,
          providerCycles: 0,
        }),
      );
    } finally {
      if (ref) await backend.remove(ref);
      backend.close();
      await rm(dataRoot, { recursive: true, force: true });
    }
  },
  15 * 60_000,
);
