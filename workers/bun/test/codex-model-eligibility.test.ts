import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  decodeCodexModelEligibility,
  fetchCodexModelEligibility,
  getCodexModelEligibility,
  intersectCodexModelCatalog,
  // @ts-expect-error The immutable guest profile is plain ESM executed by Node.
} from "../profiles/qe-pi-execution-v1/files/home/.qe-profile/codex-model-eligibility.mjs";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

test("account catalog decodes explicit API, visibility, rollout, and reasoning eligibility", () => {
  const decoded = decodeCodexModelEligibility({
    models: [
      {
        slug: "eligible",
        display_name: "Eligible",
        supported_in_api: true,
        visibility: "list",
        default_reasoning_level: "medium",
        supported_reasoning_levels: [
          { effort: "low", description: "fast" },
          { effort: "medium", description: "balanced" },
        ],
      },
      {
        slug: "hidden",
        supported_in_api: true,
        visibility: "hide",
        supported_reasoning_levels: ["medium"],
      },
      {
        slug: "not-api",
        supported_in_api: false,
        visibility: "list",
        supported_reasoning_levels: ["medium"],
      },
      {
        slug: "not-rolled-out",
        supported_in_api: true,
        visibility: "list",
        rollout_eligible: false,
        supported_reasoning_levels: ["medium"],
      },
    ],
  });

  expect(decoded.models).toEqual([
    {
      provider: "openai-codex",
      model: "eligible",
      displayName: "Eligible",
      reasoning: ["low", "medium"],
      defaultReasoning: "medium",
    },
  ]);
  expect(decoded.excluded).toEqual([
    { model: "hidden", reason: "not_visible" },
    { model: "not-api", reason: "not_supported_in_api" },
    { model: "not-rolled-out", reason: "rollout_ineligible" },
  ]);
});

test("empty authenticated account catalog is known eligibility, not a bundled fallback", () => {
  expect(decodeCodexModelEligibility({ models: [] })).toEqual({
    models: [],
    excluded: [],
  });
  expect(
    intersectCodexModelCatalog(
      [
        {
          provider: "openai-codex",
          model: "gpt-5.3-codex-spark",
          displayName: "Spark",
          reasoning: ["medium"],
        },
      ],
      [],
    ),
  ).toEqual([]);
});

test("harness and account catalogs intersect model identity and reasoning without substitutions", () => {
  const models = intersectCodexModelCatalog(
    [
      {
        provider: "openai-codex",
        model: "eligible",
        displayName: "Harness Name",
        reasoning: ["low", "medium", "high"],
      },
      {
        provider: "openai-codex",
        model: "harness-only",
        displayName: "Harness Only",
        reasoning: ["medium"],
      },
    ],
    [
      {
        provider: "openai-codex",
        model: "eligible",
        displayName: "Provider Name",
        reasoning: ["medium", "high", "xhigh"],
        defaultReasoning: "medium",
      },
      {
        provider: "openai-codex",
        model: "provider-only",
        displayName: "Provider Only",
        reasoning: ["medium"],
        defaultReasoning: "medium",
      },
    ],
  );
  expect(models).toEqual([
    {
      provider: "openai-codex",
      model: "eligible",
      displayName: "Harness Name",
      reasoning: ["medium", "high"],
    },
  ]);
});

test("account-scoped cache is reused briefly and refreshes after invalidation", async () => {
  const parent = join(process.cwd(), ".pi", "tmp");
  await mkdir(parent, { recursive: true });
  const root = await mkdtemp(join(parent, "codex-eligibility-"));
  roots.push(root);
  const authPath = join(root, "auth.json");
  const snapshotPath = join(root, "eligibility.json");
  await writeAuth(authPath, "account-a");
  let requests = 0;
  const request = async () => {
    requests += 1;
    return new Response(JSON.stringify({ models: [] }), { status: 200 });
  };

  const first = await fetchCodexModelEligibility({
    authPath,
    snapshotPath,
    fetch: request,
  });
  const cached = await getCodexModelEligibility({
    authPath,
    snapshotPath,
    fetch: async () => {
      throw new Error("fresh request should not run");
    },
  });
  expect(cached.accountScope).toBe(first.accountScope);
  expect(requests).toBe(1);

  await rm(snapshotPath);
  const refreshed = await getCodexModelEligibility({
    authPath,
    snapshotPath,
    fetch: request,
  });
  expect(refreshed.accountScope).toBe(first.accountScope);
  expect(requests).toBe(2);

  await writeAuth(authPath, "account-b");
  const nextAccount = await getCodexModelEligibility({
    authPath,
    snapshotPath,
    fetch: request,
  });
  expect(nextAccount.accountScope).not.toBe(first.accountScope);
  expect(requests).toBe(3);
});

test("unknown provider eligibility schema fails closed", () => {
  expect(() => decodeCodexModelEligibility({ data: {} })).toThrow(
    "no models array",
  );
  expect(() =>
    decodeCodexModelEligibility({
      models: [
        {
          slug: "unknown",
          supported_in_api: true,
          visibility: "new-state",
          supported_reasoning_levels: [],
        },
      ],
    }),
  ).toThrow("unknown visibility");
});

async function writeAuth(path: string, accountId: string): Promise<void> {
  const payload = Buffer.from(
    JSON.stringify({
      "https://api.openai.com/auth": { chatgpt_account_id: accountId },
    }),
  ).toString("base64url");
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
