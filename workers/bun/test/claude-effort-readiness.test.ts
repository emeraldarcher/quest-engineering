import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { StreamedProcess } from "../src/execution-environment/types.ts";
import {
  attestClaudeEffort,
  attestClaudeEffortResponse,
  CLAUDE_CODE_EFFORT,
  ClaudeEffortReadinessError,
  supportsClaudeReasoning,
} from "../src/harnesses/claude-code/effort-readiness.ts";
import { AsyncFrameQueue } from "../src/harnesses/claude-code/protocol.ts";

const model = "claude-opus-4-6";
const expected = {
  sessionId: "22222222-2222-4222-8222-222222222222",
  model,
  effort: CLAUDE_CODE_EFFORT,
};
const requestId = "11111111-1111-4111-8111-111111111111";
function reply(applied: unknown, id = requestId) {
  return {
    type: "control_response",
    response: { subtype: "success", request_id: id, response: { applied } },
  };
}

test("QE reasoning mapping is exact, capability-bound and has no default/fallback", () => {
  expect(
    supportsClaudeReasoning("high", { kind: "enumerated", values: ["high"] }),
  ).toBe(true);
  for (const reasoning of [
    null,
    "",
    "low",
    "medium",
    "xhigh",
    "max",
    "off",
    "High",
    "provider-default",
  ])
    expect(
      supportsClaudeReasoning(reasoning, {
        kind: "enumerated",
        values: ["high"],
      }),
    ).toBe(false);
  expect(supportsClaudeReasoning("high", { kind: "unsupported" })).toBe(false);
  expect(
    supportsClaudeReasoning("high", { kind: "enumerated", values: [] }),
  ).toBe(false);
});

test("authoritative native applied model/high proof passes without an init effort field", () => {
  expect(() =>
    attestClaudeEffortResponse(
      reply({ model, effort: "high" }),
      requestId,
      expected,
    ),
  ).not.toThrow();
});

for (const effort of [
  undefined,
  null,
  "low",
  "medium",
  "xhigh",
  "max",
  "unsupported",
  "High",
  10,
  { requested: "high" },
]) {
  test(`missing/wrong/unsupported native effort fails closed: ${JSON.stringify(effort)}`, () => {
    expect(() =>
      attestClaudeEffortResponse(reply({ model, effort }), requestId, expected),
    ).toThrow(ClaudeEffortReadinessError);
  });
}

test("model and effort remain independent exact readiness fences", () => {
  expect(() =>
    attestClaudeEffortResponse(
      reply({ model, effort: "low" }),
      requestId,
      expected,
    ),
  ).toThrow();
  expect(() =>
    attestClaudeEffortResponse(
      reply({ model: "claude-sonnet-4-6", effort: "high" }),
      requestId,
      expected,
    ),
  ).toThrow();
  expect(() =>
    attestClaudeEffortResponse(reply({ effort: "high" }), requestId, expected),
  ).toThrow();
  expect(() =>
    attestClaudeEffortResponse(reply({ model, effort: "low" }), requestId, {
      model,
      effort: "low",
    } as never),
  ).toThrow();
});

test("requested/managed/echoed effort does not substitute for applied native effort", () => {
  for (const extra of [
    { effort: "high" },
    { effortLevel: "high", maxEffortLevel: "high" },
    { settings: { effortLevel: "high" } },
    { applied: { model, effort_level: "high" } },
  ]) {
    const response = reply({ model });
    Object.assign(response.response.response, extra);
    expect(() =>
      attestClaudeEffortResponse(response, requestId, expected),
    ).toThrow();
  }
});

test("foreign, error, malformed and policy-error responses cannot establish readiness", () => {
  const valid = reply({ model, effort: "high" });
  for (const change of [
    { type: "result" },
    { response: { ...valid.response, request_id: "foreign" } },
    {
      response: {
        ...valid.response,
        subtype: "error",
        error: "SENSITIVE_PROVIDER_ERROR_CANARY",
      },
    },
    {
      response: {
        ...valid.response,
        response: {
          applied: { model, effort: "high" },
          errors: ["SECRET_CONFIG_CANARY"],
        },
      },
    },
    {
      response: {
        ...valid.response,
        response: { applied: { model, effort: "high" }, errors: null },
      },
    },
  ]) {
    const error = (() => {
      try {
        attestClaudeEffortResponse(
          { ...valid, ...change },
          requestId,
          expected,
        );
      } catch (error) {
        return error;
      }
    })();
    expect(error).toBeInstanceOf(ClaudeEffortReadinessError);
    expect(String(error)).not.toMatch(/CANARY/);
  }
});

test("read-only get_settings query carries no requested value and ignores stale replies", async () => {
  const frames = new AsyncFrameQueue();
  const requests: Record<string, unknown>[] = [];
  const process = {
    write: async (data: Uint8Array) => {
      const request = JSON.parse(new TextDecoder().decode(data));
      requests.push(request);
      expect(request).toEqual({
        type: "control_request",
        request_id: expect.any(String),
        request: { subtype: "get_settings" },
      });
      expect(request.request).not.toHaveProperty("effort");
      frames.push(reply({ model, effort: "low" }, "stale-id"));
      frames.push({
        type: "result",
        subtype: "success",
        is_error: false,
        num_turns: 0,
        modelUsage: {},
      });
      frames.push(reply({ model, effort: "high" }, request.request_id));
      return {
        certainty: "acknowledged",
        byteLength: data.length,
        writeId: crypto.randomUUID(),
      };
    },
  } as unknown as StreamedProcess;
  await attestClaudeEffort(process, frames, expected, Date.now() + 1000);
  expect(requests).toHaveLength(1);
});

for (const contradictory of [
  { type: "assistant", message: { model: "claude-sonnet-4-6" } },
  { type: "assistant", message: { model } },
  { type: "system", subtype: "init", model: "claude-sonnet-4-6" },
  {
    type: "result",
    subtype: "success",
    is_error: false,
    num_turns: 0,
    modelUsage: {},
    session_id: "foreign-session",
  },
  { type: "result", subtype: "success", is_error: false, num_turns: 1 },
  {
    type: "result",
    subtype: "success",
    is_error: false,
    num_turns: 0,
    modelUsage: { "claude-sonnet-4-6": {} },
  },
  {
    type: "result",
    subtype: "success",
    is_error: false,
    num_turns: 0,
    modelUsage: { [model]: {} },
  },
]) {
  test(`native readback cannot hide contradictory/model-turn evidence: ${JSON.stringify(contradictory)}`, async () => {
    const frames = new AsyncFrameQueue();
    const process = {
      write: async (data: Uint8Array) => {
        const request = JSON.parse(new TextDecoder().decode(data));
        frames.push(contradictory);
        frames.push(reply({ model, effort: "high" }, request.request_id));
        return {
          certainty: "acknowledged",
          byteLength: data.length,
          writeId: crypto.randomUUID(),
        };
      },
    } as unknown as StreamedProcess;
    await expect(
      attestClaudeEffort(process, frames, expected, Date.now() + 1000),
    ).rejects.toBeInstanceOf(ClaudeEffortReadinessError);
  });
}

test("a native correlated response proves application even if the write ACK is delayed", async () => {
  const frames = new AsyncFrameQueue();
  const process = {
    write: (data: Uint8Array) => {
      const request = JSON.parse(new TextDecoder().decode(data));
      frames.push(reply({ model, effort: "high" }, request.request_id));
      return new Promise(() => undefined);
    },
  } as unknown as StreamedProcess;
  await attestClaudeEffort(process, frames, expected, Date.now() + 1000);
});

test("ACK without native configuration is insufficient and cannot extend the existing budget", async () => {
  const frames = new AsyncFrameQueue();
  let writes = 0;
  const process = {
    write: async (data: Uint8Array) => {
      writes++;
      return {
        certainty: "acknowledged",
        byteLength: data.length,
        writeId: crypto.randomUUID(),
      };
    },
  } as unknown as StreamedProcess;
  await expect(
    attestClaudeEffort(process, frames, expected, Date.now() + 10),
  ).rejects.toBeInstanceOf(ClaudeEffortReadinessError);
  expect(writes).toBe(1);
  await expect(
    attestClaudeEffort(
      process,
      new AsyncFrameQueue(),
      expected,
      Date.now() - 1,
    ),
  ).rejects.toBeInstanceOf(ClaudeEffortReadinessError);
  expect(writes).toBe(1);
});

test("write failures and native configuration canaries never escape as error prose", async () => {
  for (const synchronous of [false, true]) {
    const frames = new AsyncFrameQueue();
    const process = {
      write: () => {
        if (synchronous) throw new Error("SECRET_AUTH_URL_CODE_CANARY");
        return Promise.reject(new Error("SECRET_AUTH_URL_CODE_CANARY"));
      },
    } as unknown as StreamedProcess;
    const error = await attestClaudeEffort(
      process,
      frames,
      expected,
      Date.now() + 1000,
    ).catch((error: unknown) => error);
    expect(error).toBeInstanceOf(ClaudeEffortReadinessError);
    expect(String(error)).not.toContain("CANARY");
  }
});

test("pinned unmodified 2.1.292 source exposes effective effort via get_settings, not init echo", async () => {
  const sdkRoot = resolve(
    import.meta.dir,
    "../node_modules/@anthropic-ai/claude-agent-sdk",
  );
  const pkg = JSON.parse(
    await readFile(resolve(sdkRoot, "package.json"), "utf8"),
  );
  const manifest = JSON.parse(
    await readFile(resolve(sdkRoot, "manifest.json"), "utf8"),
  );
  expect(pkg).toMatchObject({
    version: "0.3.292",
    claudeCodeVersion: "2.1.292",
  });
  const platform = `${process.platform}-${process.arch}`;
  const artifact = manifest.platforms[platform];
  const binary = await readFile(
    resolve(
      import.meta.dir,
      `../node_modules/@anthropic-ai/claude-agent-sdk-${platform}`,
      artifact.binary,
    ),
  );
  expect(createHash("sha256").update(binary).digest("hex")).toBe(
    artifact.checksum,
  );
  // Static byte/source contract only: no vendor executable, hooks or engine run.
  for (const marker of [
    'x.request.subtype==="get_settings"',
    'applied:{model:ee,effort:typeof le==="string"?le:null',
    "function rc(e,n,{withHold:r=!0}={})",
    "sessionEffort:Me(",
    "settingsEffortTable:fe()",
    "if(e.effort!==void 0)n.effort=e.effort",
  ])
    expect({
      marker,
      present: binary.includes(Buffer.from(marker)),
    }).toMatchObject({ present: true });
  // Minified import aliases differ by platform. Bind the effective resolver to
  // the actual getter call, rather than assuming Linux's Lw symbol everywhere.
  const offset = binary.indexOf(
    Buffer.from('x.request.subtype==="get_settings"'),
  );
  const getter = binary.subarray(offset, offset + 2500).toString();
  const computation = getter.match(
    /le=(\w+)\(ee\)\?(\w+)\(ee,rc\(pe\)\):void 0/,
  );
  expect(computation).not.toBeNull();
  expect(
    binary.includes(
      Buffer.from(
        `function ${computation?.[2]}(e,n,{turnEffort:r,hookEffortValue:s,carriedEffort:d=`,
      ),
    ),
  ).toBe(true);
});
