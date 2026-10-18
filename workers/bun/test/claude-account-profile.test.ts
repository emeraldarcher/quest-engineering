import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import {
  CLAUDE_2_1_292_LOGIN_SOURCE_MARKERS,
  CLAUDE_SUBSCRIPTION_ENDPOINT_CONTRACT,
  CLAUDE_SUBSCRIPTION_REQUIRED_ACCOUNT_RUNTIME_HOSTS,
} from "../src/execution-environment/claude-subscription-endpoints.ts";
import {
  claudeRuntimeNetworkTargetsForProfile,
  SBX_CLAUDE_ACCOUNT_PROFILE,
  SBX_CLAUDE_ACCOUNT_PROFILE_V1,
  SBX_CLAUDE_ACCOUNT_PROFILE_V1_DEFINITION,
  SBX_CLAUDE_ACCOUNT_PROFILE_V1_EXECUTION,
  SBX_CLAUDE_ACCOUNT_PROFILE_V1_ROOT,
  SBX_CLAUDE_ACCOUNT_PROFILE_V2,
  SBX_CLAUDE_ACCOUNT_PROFILE_V2_DEFINITION,
  SBX_CLAUDE_ACCOUNT_PROFILE_V2_ROOT,
  SBX_CLAUDE_BROKER_RUN_PROFILE_V1,
  SBX_CLAUDE_CODE_VERSION,
  SBX_CLAUDE_RUNTIME_NETWORK_TARGETS,
  SBX_CLAUDE_RUNTIME_NETWORK_TARGETS_V1,
  SBX_PI_INSTALL_NETWORK_TARGET,
  verifySbxProfileAssets,
} from "../src/execution-environment/sbx-profile.ts";

const historicalV1Digest =
  "sha256:b4d5723cdfb6269b405a576f9907d6722042e70353441985064da9b170a0791e";
const correctedV2Digest =
  "sha256:29d3f1aace792402b6d7f34e7ac7b66c97f2348656ed7e307672cf6cce7325a2";

const v1SpecSha256 =
  "04622d39b0687b8a7cccac7c31b874f6b293b67cb98e17734df339c86760796c";
const v2SpecSha256 =
  "cb94093b1e9e8224aa329c050bfe20592f6dc90682a69bd36cc7c172b8b08a8f";

test("Claude account v1 remains immutable while current provisioning selects v2", async () => {
  expect(SBX_CLAUDE_ACCOUNT_PROFILE_V1).toEqual({
    id: "qe-claude-account-v1",
    digest: historicalV1Digest,
  });
  expect(SBX_CLAUDE_ACCOUNT_PROFILE_V2).toEqual({
    id: "qe-claude-account-v2",
    digest: correctedV2Digest,
  });
  expect(SBX_CLAUDE_ACCOUNT_PROFILE.identity).toEqual(
    SBX_CLAUDE_ACCOUNT_PROFILE_V2,
  );
  expect(SBX_CLAUDE_ACCOUNT_PROFILE.nativeAgent).toBe("qe-claude-account-v2");
  expect(SBX_CLAUDE_BROKER_RUN_PROFILE_V1).toEqual({
    id: "qe-claude-broker-run-v1",
    digest:
      "sha256:876fead36f50dd1377f5d8ad8b2cc22b46203358d996c8659698785be92a865e",
  });

  expect(profileDigest(SBX_CLAUDE_ACCOUNT_PROFILE_V1_DEFINITION)).toBe(
    historicalV1Digest,
  );
  expect(profileDigest(SBX_CLAUDE_ACCOUNT_PROFILE_V2_DEFINITION)).toBe(
    correctedV2Digest,
  );
  expect(profileDigest(SBX_CLAUDE_ACCOUNT_PROFILE_V2_DEFINITION)).toBe(
    profileDigest(SBX_CLAUDE_ACCOUNT_PROFILE_V2_DEFINITION),
  );

  await expect(
    verifySbxProfileAssets(SBX_CLAUDE_ACCOUNT_PROFILE_V1_EXECUTION),
  ).resolves.toBeUndefined();
  await expect(
    verifySbxProfileAssets(SBX_CLAUDE_ACCOUNT_PROFILE),
  ).resolves.toBeUndefined();
});

test("v2 changes only immutable profile identity, version, spec attestation, and the exact missing host", async () => {
  const [v1Files, v2Files] = await Promise.all([
    regularFiles(SBX_CLAUDE_ACCOUNT_PROFILE_V1_ROOT),
    regularFiles(SBX_CLAUDE_ACCOUNT_PROFILE_V2_ROOT),
  ]);
  expect(v2Files).toEqual(v1Files);

  for (const relativePath of v1Files.filter((path) => path !== "spec.yaml")) {
    const [v1, v2] = await Promise.all([
      readFile(resolve(SBX_CLAUDE_ACCOUNT_PROFILE_V1_ROOT, relativePath)),
      readFile(resolve(SBX_CLAUDE_ACCOUNT_PROFILE_V2_ROOT, relativePath)),
    ]);
    expect(v2).toEqual(v1);
  }

  const [v1Spec, v2Spec] = await Promise.all([
    readFile(resolve(SBX_CLAUDE_ACCOUNT_PROFILE_V1_ROOT, "spec.yaml"), "utf8"),
    readFile(resolve(SBX_CLAUDE_ACCOUNT_PROFILE_V2_ROOT, "spec.yaml"), "utf8"),
  ]);
  expect(sha256(v1Spec)).toBe(v1SpecSha256);
  expect(sha256(v2Spec)).toBe(v2SpecSha256);
  expect(
    v2Spec
      .replace("name: qe-claude-account-v2", "name: qe-claude-account-v1")
      .replace('version: "2.0.0"', 'version: "1.0.0"')
      .replace("      - platform.claude.com\n", ""),
  ).toBe(v1Spec);
});

test("reviewed pinned endpoint manifest, TypeScript contract, and v2 spec are exact", async () => {
  const required = [...CLAUDE_SUBSCRIPTION_REQUIRED_ACCOUNT_RUNTIME_HOSTS];
  expect(CLAUDE_SUBSCRIPTION_ENDPOINT_CONTRACT).toMatchObject({
    schemaVersion: 1,
    claudeCodeVersion: "2.1.292",
  });
  expect(SBX_CLAUDE_CODE_VERSION).toBe("2.1.292");
  expect(required).toEqual([
    "api.anthropic.com",
    "claude.ai",
    "platform.claude.com",
  ]);
  expect([...SBX_CLAUDE_RUNTIME_NETWORK_TARGETS]).toEqual(required);
  expect([
    ...SBX_CLAUDE_ACCOUNT_PROFILE_V2_DEFINITION.network.runtimeAllow,
  ]).toEqual(required);
  expect([
    ...claudeRuntimeNetworkTargetsForProfile(SBX_CLAUDE_ACCOUNT_PROFILE_V2),
  ]).toEqual(required);

  const spec = await readFile(
    resolve(SBX_CLAUDE_ACCOUNT_PROFILE_V2_ROOT, "spec.yaml"),
    "utf8",
  );
  const profileAllows = networkAllows(spec);
  expect(profileAllows).toEqual([...required, SBX_PI_INSTALL_NETWORK_TARGET]);
  expect(
    profileAllows.filter((host) => host !== SBX_PI_INSTALL_NETWORK_TARGET),
  ).toEqual(required);
  expect(profileAllows).not.toContain("*.claude.com");
  expect(profileAllows).not.toContain("*.anthropic.com");
  expect(profileAllows).not.toContain("**");
  expect(profileAllows).not.toContain("0.0.0.0/0");

  expect([...SBX_CLAUDE_RUNTIME_NETWORK_TARGETS_V1]).toEqual([
    "api.anthropic.com",
    "claude.ai",
  ]);
  expect([
    ...SBX_CLAUDE_ACCOUNT_PROFILE_V1_DEFINITION.network.runtimeAllow,
  ]).toEqual([...SBX_CLAUDE_RUNTIME_NETWORK_TARGETS_V1]);
  expect(
    claudeRuntimeNetworkTargetsForProfile(SBX_CLAUDE_ACCOUNT_PROFILE_V1),
  ).toEqual(SBX_CLAUDE_RUNTIME_NETWORK_TARGETS_V1);

  const browserOnly = CLAUDE_SUBSCRIPTION_ENDPOINT_CONTRACT.endpoints.filter(
    (endpoint) => !endpoint.accountCellEgressRequired,
  );
  expect(browserOnly.map((endpoint) => endpoint.host)).toEqual(["claude.com"]);
  expect(required).not.toContain("claude.com");
});

test("installed pinned Claude 2.1.292 artifact statically proves the official token-exchange path", async () => {
  const sdkRoot = resolve(
    import.meta.dir,
    "../node_modules/@anthropic-ai/claude-agent-sdk",
  );
  const sdkPackage = JSON.parse(
    await readFile(resolve(sdkRoot, "package.json"), "utf8"),
  ) as { version: string; claudeCodeVersion: string };
  const manifest = JSON.parse(
    await readFile(resolve(sdkRoot, "manifest.json"), "utf8"),
  ) as {
    version: string;
    platforms: Record<string, { binary: string; checksum: string }>;
  };
  const platform = `${process.platform}-${process.arch}`;
  const artifact = manifest.platforms[platform];
  if (!artifact)
    throw new Error(`Unsupported pinned Claude platform: ${platform}`);
  const binaryPath = resolve(
    import.meta.dir,
    `../node_modules/@anthropic-ai/claude-agent-sdk-${platform}`,
    artifact.binary,
  );
  const binary = await readFile(binaryPath);

  expect(sdkPackage).toMatchObject({
    version: "0.3.292",
    claudeCodeVersion: "2.1.292",
  });
  expect(manifest.version).toBe("2.1.292");
  expect(sha256(binary)).toBe(artifact.checksum);
  for (const marker of CLAUDE_2_1_292_LOGIN_SOURCE_MARKERS)
    expect(binary.includes(Buffer.from(marker))).toBe(true);
  expect(
    binary.includes(Buffer.from("platform.claude.com/v1/oauth/token")),
  ).toBe(true);
});

function profileDigest(value: unknown): string {
  return `sha256:${sha256(JSON.stringify(value))}`;
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function networkAllows(spec: string): string[] {
  const match = spec.match(
    /permissions:\n {2}network:\n {4}allow:\n((?: {6}- [^\n]+\n)+)/,
  );
  if (!match?.[1]) throw new Error("Profile network allowlist is missing.");
  return match[1]
    .trim()
    .split("\n")
    .map((line) => line.replace(/^\s*-\s*/, ""));
}

async function regularFiles(
  root: string,
  relativeRoot = "",
): Promise<string[]> {
  const entries = await readdir(resolve(root, relativeRoot), {
    withFileTypes: true,
  });
  const files: string[] = [];
  for (const entry of entries) {
    const relativePath = relativeRoot
      ? `${relativeRoot}/${entry.name}`
      : entry.name;
    if (entry.isDirectory()) {
      files.push(...(await regularFiles(root, relativePath)));
    } else if (entry.isFile()) {
      files.push(relativePath);
    } else {
      throw new Error(
        `Profile contains non-regular asset: ${basename(relativePath)}`,
      );
    }
  }
  return files.sort();
}
