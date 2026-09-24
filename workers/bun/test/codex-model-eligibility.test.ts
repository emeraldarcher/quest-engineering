import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  describeCodexModelMetadata,
  getCodexModelMetadata,
  readCodexProxyIdentity,
  // @ts-expect-error The immutable guest profile is plain ESM executed by Node.
} from "../profiles/qe-pi-execution-v2/files/home/.qe-profile/codex-model-eligibility.mjs";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

test("empty authenticated provider metadata is advisory and inconclusive", async () => {
  const { authPath, snapshotPath } = await fixture("account-a", "a");
  const metadata = await getCodexModelMetadata({
    authPath,
    snapshotPath,
    fetch: async () =>
      new Response(JSON.stringify({ models: [] }), { status: 200 }),
  });
  expect(metadata).toMatchObject({
    schemaVersion: 2,
    authority: "advisory",
    conclusive: false,
    authenticated: true,
    status: 200,
    modelCount: 0,
    detail:
      "Provider returned an empty advisory model list; account availability remains unknown.",
  });
  expect(metadata.accountScope).toMatch(/^[a-f0-9]{64}$/);
  expect(metadata.authGeneration).toBe("a".repeat(64));
  expect(JSON.parse(await readFile(snapshotPath, "utf8"))).toEqual(metadata);
  expect(describeCodexModelMetadata(metadata)[0]).toContain(
    "advisory and inconclusive",
  );
});

test("nonempty or malformed provider metadata never becomes availability authority", async () => {
  const { authPath } = await fixture("account-a", "b");
  const nonempty = await getCodexModelMetadata({
    authPath,
    snapshotPath: null,
    fetch: async () =>
      new Response(JSON.stringify({ models: [{ slug: "anything" }] }), {
        status: 200,
      }),
  });
  expect(nonempty).toMatchObject({
    authority: "advisory",
    conclusive: false,
    modelCount: 1,
  });

  const malformed = await getCodexModelMetadata({
    authPath,
    snapshotPath: null,
    fetch: async () => new Response("not-json", { status: 200 }),
  });
  expect(malformed).toMatchObject({
    authority: "advisory",
    conclusive: false,
    status: 200,
    modelCount: null,
  });

  const rejectedMetadata = await getCodexModelMetadata({
    authPath,
    snapshotPath: null,
    fetch: async () => new Response("unauthorized", { status: 401 }),
  });
  expect(rejectedMetadata).toMatchObject({
    authenticated: true,
    authority: "advisory",
    conclusive: false,
    status: 401,
    modelCount: null,
  });
});

test("metadata transport failure is diagnostic and does not invent unavailability", async () => {
  const { authPath } = await fixture("account-a", "c");
  const metadata = await getCodexModelMetadata({
    authPath,
    snapshotPath: null,
    fetch: async () => {
      throw new Error("offline");
    },
  });
  expect(metadata).toMatchObject({
    authority: "advisory",
    conclusive: false,
    authenticated: true,
    status: null,
    modelCount: null,
  });
  expect(metadata.detail).toContain("unavailable");
});

test("proxy identity binds account scope and auth generation without exposing credentials", async () => {
  const { authPath } = await fixture("account-a", "d");
  const identity = await readCodexProxyIdentity(authPath);
  expect(identity.accountId).toBe("account-a");
  expect(identity.accountScope).toMatch(/^[a-f0-9]{64}$/);
  expect(identity.authGeneration).toBe("d".repeat(64));

  await writeAuth(authPath, "account-b", "e".repeat(64));
  const next = await readCodexProxyIdentity(authPath);
  expect(next.accountScope).not.toBe(identity.accountScope);
  expect(next.authGeneration).not.toBe(identity.authGeneration);
});

async function fixture(
  accountId: string,
  generation: string,
): Promise<{ authPath: string; snapshotPath: string }> {
  const parent = join(process.cwd(), ".pi", "tmp");
  await mkdir(parent, { recursive: true });
  const root = await mkdtemp(join(parent, "codex-metadata-"));
  roots.push(root);
  const authPath = join(root, "auth.json");
  await writeAuth(authPath, accountId, generation.repeat(64));
  return { authPath, snapshotPath: join(root, "metadata.json") };
}

async function writeAuth(
  path: string,
  accountId: string,
  authGeneration: string,
): Promise<void> {
  const payload = Buffer.from(
    JSON.stringify({
      "https://api.openai.com/auth": { chatgpt_account_id: accountId },
    }),
  ).toString("base64url");
  await writeFile(
    join(dirname(path), "qe-auth-generation"),
    `${authGeneration}\n`,
  );
  await writeFile(
    path,
    `${JSON.stringify({
      "openai-codex": {
        type: "oauth",
        access: `header.${payload}.signature`,
        accountId,
      },
    })}\n`,
  );
}
