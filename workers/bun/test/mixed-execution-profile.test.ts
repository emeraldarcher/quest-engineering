import { expect, test } from "bun:test";
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
  SBX_CODING_EXECUTION_PROFILE_V1,
  SBX_CODING_EXECUTION_PROFILE_V1_DEFINITION,
  SBX_CODING_PROFILE,
  SBX_MIXED_INSTALL_NETWORK_TARGETS,
  SBX_MIXED_RUNTIME_NETWORK_TARGETS,
  SBX_PI_EXECUTION_PROFILE_V2,
  verifySbxProfileAssets,
} from "../src/execution-environment/sbx-profile.ts";

test("Pi, Antigravity, and mixed Runs resolve one composable immutable profile", () => {
  for (const harnesses of [["pi"], ["antigravity"], ["pi", "antigravity"]]) {
    const resolved = resolveRunExecutionProfile(harnesses);
    expect(resolved.profile.identity).toEqual(SBX_CODING_EXECUTION_PROFILE_V1);
    expect(resolved.harnesses).toEqual(["antigravity", "pi"]);
  }
  expect(profileSupportsHarness(SBX_CODING_EXECUTION_PROFILE_V1.id, "pi")).toBe(
    true,
  );
  expect(
    profileSupportsHarness(SBX_CODING_EXECUTION_PROFILE_V1.id, "antigravity"),
  ).toBe(true);
  expect(SBX_PI_EXECUTION_PROFILE_V2.id).toBe("qe-pi-execution-v2");
});

test("mixed profile pins Antigravity provenance and revokes installer/updater egress", async () => {
  await expect(
    verifySbxProfileAssets(SBX_CODING_PROFILE),
  ).resolves.toBeUndefined();
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
  expect(SBX_MIXED_RUNTIME_NETWORK_TARGETS).toEqual([
    "chatgpt.com",
    "daily-cloudcode-pa.googleapis.com",
    "www.googleapis.com",
    "lh3.googleusercontent.com",
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
