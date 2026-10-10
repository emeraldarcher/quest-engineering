import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import {
  profileSupportsHarness,
  resolveRunExecutionProfile,
} from "../src/execution-environment/profile-resolution.ts";
import type { SbxClient } from "../src/execution-environment/sbx-client.ts";
import { SbxMixedCredentialProvisioner } from "../src/execution-environment/sbx-mixed-credential.ts";
import {
  SBX_ANTIGRAVITY_EXECUTABLE,
  SBX_ANTIGRAVITY_LINUX_ARM64_ARCHIVE_SHA256,
  SBX_ANTIGRAVITY_LINUX_ARM64_BINARY_SHA256,
  SBX_ANTIGRAVITY_VERSION,
  SBX_CLAUDE_AGENT_SDK_VERSION,
  SBX_CLAUDE_CODE_VERSION,
  SBX_CODING_EXECUTION_PROFILE_V1,
  SBX_CODING_EXECUTION_PROFILE_V1_DEFINITION,
  SBX_CODING_EXECUTION_PROFILE_V2,
  SBX_CODING_EXECUTION_PROFILE_V2_DEFINITION,
  SBX_CODING_PROFILE,
  SBX_CODING_PROFILE_ROOT,
  SBX_CODING_PROFILE_V1_ROOT,
  SBX_MIXED_INSTALL_NETWORK_TARGETS,
  SBX_MIXED_RUNTIME_NETWORK_TARGETS,
  SBX_PI_EXECUTION_PROFILE_V2,
  verifySbxProfileAssets,
} from "../src/execution-environment/sbx-profile.ts";

test("Pi, Antigravity, Claude, and mixed Runs resolve one composable immutable profile", () => {
  for (const harnesses of [
    ["pi"],
    ["antigravity"],
    ["claude_agent_sdk"],
    ["pi", "antigravity", "claude_agent_sdk"],
  ]) {
    const resolved = resolveRunExecutionProfile(harnesses);
    expect(resolved.profile.identity).toEqual(SBX_CODING_EXECUTION_PROFILE_V2);
    expect(resolved.harnesses).toEqual([
      "antigravity",
      "claude_agent_sdk",
      "pi",
    ]);
  }
  expect(SBX_CODING_EXECUTION_PROFILE_V1.digest).toBe(
    "sha256:09dc17e0b2270441ba4af01d3e59f803c0514bfedb82356f8849017a76e2cc2b",
  );
  expect(SBX_CODING_EXECUTION_PROFILE_V2.digest).toBe(
    "sha256:a515a987b33f6b4bae64f7c2d3107a7094b967d17cd99559824083659c7086b4",
  );
  expect(profileSupportsHarness(SBX_CODING_EXECUTION_PROFILE_V1.id, "pi")).toBe(
    true,
  );
  expect(
    profileSupportsHarness(SBX_CODING_EXECUTION_PROFILE_V1.id, "antigravity"),
  ).toBe(true);
  expect(
    profileSupportsHarness(
      SBX_CODING_EXECUTION_PROFILE_V1.id,
      "claude_agent_sdk",
    ),
  ).toBe(false);
  expect(
    profileSupportsHarness(
      SBX_CODING_EXECUTION_PROFILE_V2.id,
      "claude_agent_sdk",
    ),
  ).toBe(true);
  expect(SBX_PI_EXECUTION_PROFILE_V2.id).toBe("qe-pi-execution-v2");
});

test("qe-coding-execution-v1 remains byte-for-byte immutable", async () => {
  const paths = await Array.fromAsync(
    new Bun.Glob("**/*").scan({
      cwd: SBX_CODING_PROFILE_V1_ROOT,
      onlyFiles: true,
    }),
  );
  paths.sort();
  const digest = createHash("sha256");
  for (const path of paths) {
    digest.update(path);
    digest.update("\0");
    digest.update(await readFile(`${SBX_CODING_PROFILE_V1_ROOT}/${path}`));
    digest.update("\0");
  }
  expect(digest.digest("hex")).toBe(
    "c72c11d5430ab02f0eaab9901116572b5b158497c095ccc13b84358c71305c8d",
  );
});

test("mixed profile pins Antigravity provenance and revokes installer/updater egress", async () => {
  await expect(
    verifySbxProfileAssets(SBX_CODING_PROFILE),
  ).resolves.toBeUndefined();
  const lock = JSON.parse(
    await readFile(
      `${SBX_CODING_PROFILE_ROOT}/files/home/.qe-profile/package-lock.json`,
      "utf8",
    ),
  );
  expect(
    lock.packages["node_modules/@anthropic-ai/claude-agent-sdk"],
  ).toMatchObject({
    version: "0.3.292",
    integrity:
      "sha512-C5XI/19uArTg3jjgayN9CSQxJilRciBko007AdPmHXwQqbAzdUldaPUQtDp8Pm6QJg5Aw3jI1G1eIJOBrx4xKQ==",
  });
  expect(
    lock.packages["node_modules/@anthropic-ai/claude-agent-sdk-linux-arm64"],
  ).toMatchObject({
    version: "0.3.292",
    integrity:
      "sha512-ziGXVP0Kjjg531fUNZh/1lkT8MQKc77qFinqvQ7N7ZbR7Kr/wVRhs3kSb2s7A1+z/3TNsPiQJManEmbw61U+Hw==",
  });
  expect(
    lock.packages["node_modules/@anthropic-ai/claude-agent-sdk-linux-x64"],
  ).toMatchObject({
    version: "0.3.292",
    integrity:
      "sha512-dnMVyLxpg8mUzEqAtxhv+5oBxdiYjCLIBHLPFM4z7cuk+Se6SwgyHPRGipp8rOociJBS8yyB7QXJh+RO41y+Kg==",
  });
  const wrapperSource = await readFile(
    `${SBX_CODING_PROFILE_ROOT}/files/home/.qe-profile/claude-wrapper.mjs`,
    "utf8",
  );
  expect(createHash("sha256").update(wrapperSource).digest("hex")).toBe(
    "82781ffa4a23f60e6eb5078733554da9484d7db01392d2ac48481470f07cd66b",
  );
  expect(wrapperSource).toContain('"/home/agent/.pi"');
  expect(wrapperSource).toContain('"/home/agent/.gemini"');
  expect(wrapperSource).toContain("failIfUnavailable: true");
  expect(wrapperSource).toContain("allowUnsandboxedCommands: false");
  expect(wrapperSource).not.toContain("ANTHROPIC_API_KEY:");
  expect(
    SBX_CODING_EXECUTION_PROFILE_V1_DEFINITION.harnesses.antigravity,
  ).toEqual({
    version: SBX_ANTIGRAVITY_VERSION,
    artifact:
      "github.com/google-antigravity/antigravity-cli/releases/download/1.2.7/agy_cli_linux_arm64.tar.gz",
    archiveSha256: SBX_ANTIGRAVITY_LINUX_ARM64_ARCHIVE_SHA256,
    binarySha256: SBX_ANTIGRAVITY_LINUX_ARM64_BINARY_SHA256,
  });
  expect(SBX_ANTIGRAVITY_EXECUTABLE).toBe("/opt/qe/antigravity/agy");
  expect(
    SBX_CODING_EXECUTION_PROFILE_V2_DEFINITION.harnesses.claude_agent_sdk,
  ).toMatchObject({
    sdkVersion: SBX_CLAUDE_AGENT_SDK_VERSION,
    claudeCodeVersion: SBX_CLAUDE_CODE_VERSION,
    wrapperVersion: "1.1.0",
  });
  expect(SBX_MIXED_RUNTIME_NETWORK_TARGETS).toEqual([
    "chatgpt.com",
    "daily-cloudcode-pa.googleapis.com",
    "www.googleapis.com",
    "lh3.googleusercontent.com",
    "api.anthropic.com",
    "claude.ai",
  ]);
  expect(SBX_MIXED_RUNTIME_NETWORK_TARGETS).not.toContain(
    "oauth2.googleapis.com",
  );
  expect(SBX_MIXED_INSTALL_NETWORK_TARGETS).toEqual(
    expect.arrayContaining([
      "registry.npmjs.org",
      "github.com",
      "release-assets.githubusercontent.com",
    ]),
  );
  expect(
    SBX_MIXED_RUNTIME_NETWORK_TARGETS.some((target) =>
      /github|release-assets|registry/.test(target),
    ),
  ).toBe(false);
});

test("mixed credential provisioning revokes Pi authority when Antigravity setup fails", async () => {
  const revoked: Array<[string, string]> = [];
  const provisioner = new SbxMixedCredentialProvisioner({} as SbxClient, {
    pi: {
      provision: async () => ({ placeholder: "pi-placeholder" }),
      revoke: async (sandboxName, placeholder) => {
        revoked.push([sandboxName, placeholder]);
      },
    },
    antigravity: {
      provision: async () => {
        throw new Error("Antigravity setup failed");
      },
    },
  });
  await expect(provisioner.provision("sandbox-a")).rejects.toThrow(
    "Antigravity setup failed",
  );
  expect(revoked).toEqual([["sandbox-a", "pi-placeholder"]]);
});

test("profile resolution fails closed without a supported coding harness", () => {
  expect(() => resolveRunExecutionProfile([])).toThrow("at least one harness");
  expect(() => resolveRunExecutionProfile(["host-native"])).toThrow(
    "No immutable execution profile",
  );
});
