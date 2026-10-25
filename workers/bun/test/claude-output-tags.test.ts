import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import ts from "typescript";
import {
  ClaudeOutputCensus,
  MAX_CLAUDE_CENSUS_BUCKETS,
  MAX_CLAUDE_CENSUS_COUNT,
} from "../src/harnesses/claude-code/output-census.ts";
import {
  CLAUDE_COMMAND_LIFECYCLE_STATES,
  CLAUDE_NATIVE_PRIVATE_RESULT_SUBTYPES,
  CLAUDE_NATIVE_PRIVATE_ROOT_CATALOG,
  CLAUDE_NATIVE_PRIVATE_ROOT_TYPES,
  CLAUDE_NATIVE_PRIVATE_SYSTEM_REVIEW,
  CLAUDE_NATIVE_PRIVATE_SYSTEM_SUBTYPES,
  CLAUDE_OUTPUT_RESULT_SUBTYPES,
  CLAUDE_OUTPUT_SIMPLE_TYPES,
  CLAUDE_OUTPUT_SYSTEM_SUBTYPES,
  decodeClaudeOutputTag,
  hasClaudeRoot,
  isClaudeInit,
  isClaudeResultSuccess,
} from "../src/harnesses/claude-code/output-tags.ts";

const session = "11111111-1111-4111-8111-111111111111";
const probe = "22222222-2222-4222-8222-222222222222";
const other = "33333333-3333-4333-8333-333333333333";
for (const [value, kind, valueKind] of [
  [null, "non_object", "null"],
  [false, "non_object", "boolean"],
  [42, "non_object", "number"],
  ["sensitive-value", "non_object", "string"],
  [[], "non_object", "array"],
  [{}, "missing_type", undefined],
  [{ type: null }, "non_string_type", "null"],
  [{ type: 42 }, "non_string_type", "number"],
  [{ type: false }, "non_string_type", "boolean"],
  [{ type: [] }, "non_string_type", "array"],
  [{ type: {} }, "non_string_type", "object"],
  [{ type: "sensitive-type" }, "unknown_string_root", undefined],
  [{ type: "System", subtype: "init" }, "unknown_string_root", undefined],
] as const)
  test(`pure structural root: ${kind}/${valueKind ?? "none"}/${JSON.stringify(value)}`, () => {
    const tag = decodeClaudeOutputTag(value);
    expect(tag).toEqual(valueKind ? { kind, valueKind } : { kind });
    expect(isClaudeInit(tag)).toBe(false);
    expect(hasClaudeRoot(tag, "result")).toBe(false);
  });

for (const type of [...CLAUDE_OUTPUT_SIMPLE_TYPES, "system", "result"] as const)
  test(`public root classification does not validate payload: ${type}`, () => {
    const tag = decodeClaudeOutputTag({ type });
    expect(tag.kind).toBe("known_public_root");
    expect(hasClaudeRoot(tag, type)).toBe(true);
    expect(isClaudeInit(tag)).toBe(false);
  });
for (const type of CLAUDE_NATIVE_PRIVATE_ROOT_TYPES)
  test(`raw private root classification does not enable mode: ${type}`, () => {
    const tag = decodeClaudeOutputTag({ type });
    expect(tag).toEqual({ kind: "known_native_private_root", type });
    expect(isClaudeInit(tag)).toBe(false);
    expect(isClaudeResultSuccess(tag)).toBe(false);
    expect(CLAUDE_NATIVE_PRIVATE_ROOT_CATALOG[type].publicSdkSchema).toBe(
      false,
    );
  });

test("public/raw membership and current-invocation reachability remain separate", () => {
  expect(CLAUDE_OUTPUT_SIMPLE_TYPES.length + 2).toBe(16);
  expect(Object.keys(CLAUDE_NATIVE_PRIVATE_ROOT_CATALOG)).toEqual([
    ...CLAUDE_NATIVE_PRIVATE_ROOT_TYPES,
  ]);
  expect(
    CLAUDE_OUTPUT_SIMPLE_TYPES.length +
      2 +
      CLAUDE_NATIVE_PRIVATE_ROOT_TYPES.length,
  ).toBe(19);
  expect(
    CLAUDE_OUTPUT_SYSTEM_SUBTYPES.length +
      CLAUDE_NATIVE_PRIVATE_SYSTEM_SUBTYPES.length,
  ).toBe(51);
  expect(CLAUDE_OUTPUT_RESULT_SUBTYPES.length).toBe(5);
  expect(CLAUDE_NATIVE_PRIVATE_RESULT_SUBTYPES).toEqual([]);
  expect(
    CLAUDE_NATIVE_PRIVATE_ROOT_CATALOG.command_lifecycle.qeInvocation,
  ).toBe("local_stdio_source_supported");
  expect(
    CLAUDE_NATIVE_PRIVATE_ROOT_CATALOG.transcript_mirror.qeInvocation,
  ).toBe("not_configured_session_mirror");
  expect(
    CLAUDE_NATIVE_PRIVATE_ROOT_CATALOG.autocompact_state.qeInvocation,
  ).toBe("not_configured_remote_mode");
  expect(CLAUDE_NATIVE_PRIVATE_SYSTEM_REVIEW.qeInvocation).toBe(
    "producer_conditions_not_established",
  );
  expect(MAX_CLAUDE_CENSUS_BUCKETS).toBe(79);
});

for (const [type, names, privateNames] of [
  [
    "system",
    CLAUDE_OUTPUT_SYSTEM_SUBTYPES,
    CLAUDE_NATIVE_PRIVATE_SYSTEM_SUBTYPES,
  ],
  [
    "result",
    CLAUDE_OUTPUT_RESULT_SUBTYPES,
    CLAUDE_NATIVE_PRIVATE_RESULT_SUBTYPES,
  ],
] as const) {
  for (const name of names)
    test(`public ${type}/${name}`, () => {
      expect<unknown>(decodeClaudeOutputTag({ type, subtype: name })).toEqual({
        kind: "known_public_root",
        type,
        subtype: { kind: "known_public_subtype", value: name },
      });
    });
  for (const name of privateNames)
    test(`native-private ${type}/${name}`, () => {
      const tag = decodeClaudeOutputTag({ type, subtype: name });
      expect<unknown>(tag).toEqual({
        kind: "known_public_root",
        type,
        subtype: { kind: "known_native_private_subtype", value: name },
      });
      expect(isClaudeInit(tag)).toBe(false);
    });
  for (const value of [null, false, 1, [], {}])
    test(`non-string ${type} subtype ${JSON.stringify(value)}`, () => {
      const tag = decodeClaudeOutputTag({ type, subtype: value });
      expect(tag).toMatchObject({
        kind: "known_public_root",
        type,
        subtype: { kind: "non_string_subtype" },
      });
      expect(isClaudeInit(tag)).toBe(false);
    });
  test(`missing/unknown ${type} subtype is not a recognized candidate`, () => {
    expect(decodeClaudeOutputTag({ type })).toEqual({
      kind: "known_public_root",
      type,
      subtype: { kind: "missing_subtype" },
    });
    expect(
      decodeClaudeOutputTag({ type, subtype: "unreviewed-sensitive" }),
    ).toEqual({
      kind: "known_public_root",
      type,
      subtype: { kind: "unknown_string_subtype" },
    });
  });
}

test("parsed-JSON candidate/success predicates preserve the exact pre-refactor semantics", () => {
  const roots = [
    undefined,
    null,
    false,
    42,
    [],
    {},
    "System",
    "unreviewed",
    ...CLAUDE_OUTPUT_SIMPLE_TYPES,
    "system",
    "result",
    ...CLAUDE_NATIVE_PRIVATE_ROOT_TYPES,
  ];
  const subs = [
    undefined,
    null,
    false,
    42,
    [],
    {},
    "Init",
    "unreviewed",
    ...CLAUDE_OUTPUT_SYSTEM_SUBTYPES,
    ...CLAUDE_NATIVE_PRIVATE_SYSTEM_SUBTYPES,
    ...CLAUDE_OUTPUT_RESULT_SUBTYPES,
  ];
  for (const type of roots)
    for (const subtype of subs) {
      const frame = JSON.parse(JSON.stringify({ type, subtype })) as Record<
        string,
        unknown
      >;
      const tag = decodeClaudeOutputTag(frame);
      expect(isClaudeInit(tag)).toBe(
        frame.type === "system" && frame.subtype === "init",
      );
      expect(isClaudeResultSuccess(tag)).toBe(
        frame.type === "result" && frame.subtype === "success",
      );
      for (const root of ["assistant", "result", "control_response"] as const)
        expect(hasClaudeRoot(tag, root)).toBe(frame.type === root);
    }
});

test("fixed root structure and JSON-kind aggregates separate formerly conflated unknowns", () => {
  const c = new ClaudeOutputCensus();
  for (const value of [
    {},
    { type: null },
    { type: false },
    { type: 42 },
    { type: [] },
    { type: {} },
    { type: "keep_alive" },
    { type: "command_lifecycle" },
    { type: "unreviewed" },
    null,
    false,
    42,
    "secret",
    [],
  ])
    c.observe({ kind: "json", value }, session);
  const s = c.snapshot(true);
  expect(s.structure.roots).toEqual({
    non_object: 5,
    missing_type: 1,
    non_string_type: 5,
    known_public_root: 1,
    known_native_private_root: 1,
    unknown_string_root: 1,
  });
  expect(s.structure.nonStringTypeKinds).toEqual({
    null: 1,
    boolean: 1,
    number: 1,
    array: 1,
    object: 1,
    string: 0,
    not_json: 0,
  });
  expect(s.structure.nonObjectKinds).toEqual({
    null: 1,
    boolean: 1,
    number: 1,
    array: 1,
    string: 1,
    object: 0,
    not_json: 0,
  });
  expect(s.categories.unknown?.count).toBe(7);
});
for (const state of [
  ...CLAUDE_COMMAND_LIFECYCLE_STATES,
  "unreviewed",
  undefined,
  null,
  42,
  {},
  [],
])
  test(`lifecycle state aggregate: ${JSON.stringify(state)}`, () => {
    const c = new ClaudeOutputCensus();
    c.observe(
      { kind: "json", value: { type: "command_lifecycle", state } },
      session,
    );
    const s = c.snapshot(true);
    expect(s.commandLifecycle.total).toBe(1);
    const key =
      CLAUDE_COMMAND_LIFECYCLE_STATES.find((x) => x === state) ??
      "unknown_or_malformed";
    expect(s.commandLifecycle.states[key]).toBe(1);
    expect(
      Object.values(s.commandLifecycle.states).reduce((a, b) => a + b, 0),
    ).toBe(1);
    expect(s.counters.systemInitCandidateCount).toBe(0);
  });
for (const [id, expected] of [
  [probe, "match"],
  [other, "mismatch"],
  [undefined, "missing_or_invalid"],
  [null, "missing_or_invalid"],
  [42, "missing_or_invalid"],
  [{}, "missing_or_invalid"],
  ["bad-id", "missing_or_invalid"],
] as const)
  test(`ephemeral owned probe comparison: ${expected}/${JSON.stringify(id)}`, () => {
    const c = new ClaudeOutputCensus(),
      secret = `extra-${crypto.randomUUID()}`;
    c.observe(
      {
        kind: "json",
        value: {
          type: "command_lifecycle",
          command_uuid: id,
          uuid: secret,
          session_id: secret,
          extra: { secret },
        },
      },
      session,
      probe,
    );
    const s = c.snapshot(true),
      encoded = JSON.stringify(s);
    expect(s.commandLifecycle.probeCorrelation[expected]).toBe(1);
    expect(
      Object.values(s.commandLifecycle.probeCorrelation).reduce(
        (a, b) => a + b,
        0,
      ),
    ).toBe(1);
    for (const value of [probe, other, secret, "bad-id"])
      expect(encoded.includes(value)).toBe(false);
  });
test("no owned probe means unavailable comparison, not mismatch", () => {
  const c = new ClaudeOutputCensus();
  c.observe(
    { kind: "json", value: { type: "command_lifecycle", command_uuid: other } },
    session,
  );
  expect(c.snapshot(true).commandLifecycle.probeCorrelation).toEqual({
    match: 0,
    mismatch: 0,
    missing_or_invalid: 0,
    unavailable: 1,
  });
});

test("decoder and snapshot discard canaries and do not keep references or unwrap envelopes", () => {
  const secret = `sensitive-${crypto.randomUUID()}`,
    c = new ClaudeOutputCensus();
  const inputs = [
    { type: secret },
    { type: { secret } },
    { type: "system", subtype: secret },
    { type: "result", subtype: secret },
    { message: { type: "system", subtype: "init", session_id: secret } },
    { type: "event", data: { type: "system", subtype: "init" } },
    {
      type: "command_lifecycle",
      state: secret,
      command_uuid: secret,
      uuid: secret,
      session_id: secret,
      extra: secret,
    },
  ];
  for (const value of inputs) {
    const tag = decodeClaudeOutputTag(value);
    expect(JSON.stringify(tag).includes(secret)).toBe(false);
    c.observe({ kind: "json", value }, session, probe);
  }
  expect(JSON.stringify(c.snapshot(true)).includes(secret)).toBe(false);
  const copy = c.snapshot(true);
  copy.structure.roots.missing_type = 123;
  expect(c.snapshot(true).structure.roots.missing_type).not.toBe(123);
  expect(c.snapshot(true).counters.systemInitCandidateCount).toBe(0);
});

test("complete reviewed catalog stays at 79 buckets and 60 fixed aggregate counters", () => {
  const c = new ClaudeOutputCensus();
  for (const type of [
    ...CLAUDE_OUTPUT_SIMPLE_TYPES,
    ...CLAUDE_NATIVE_PRIVATE_ROOT_TYPES,
    "unreviewed",
  ])
    c.observe({ kind: "json", value: { type } }, session);
  for (const subtype of [
    ...CLAUDE_OUTPUT_SYSTEM_SUBTYPES,
    ...CLAUDE_NATIVE_PRIVATE_SYSTEM_SUBTYPES,
    "unreviewed",
  ])
    c.observe({ kind: "json", value: { type: "system", subtype } }, session);
  for (const subtype of [...CLAUDE_OUTPUT_RESULT_SUBTYPES, "unreviewed"])
    c.observe({ kind: "json", value: { type: "result", subtype } }, session);
  c.observe({ kind: "json", value: null }, session);
  c.observe({ kind: "empty" }, session);
  c.observe({ kind: "non_json", decodedUtf8Bytes: 1 }, session);
  const s = c.snapshot(true);
  expect(Object.keys(s.categories)).toHaveLength(79);
  const count = (x: unknown): number =>
    typeof x === "number"
      ? 1
      : Object.values(x as Record<string, unknown>).reduce<number>(
          (n, v) => n + count(v),
          0,
        );
  expect(
    count(s.counters) + count(s.structure) + count(s.commandLifecycle),
  ).toBe(60);
  expect(s.observation).toBe("observing");
});

test("new aggregate overflow fails closed diagnostically, without retaining values", () => {
  for (const which of ["root", "state", "correlation", "total"]) {
    const c = new ClaudeOutputCensus();
    // Controlled Worker fixture counter seeding avoids billions of iterations.
    const internal = c as unknown as {
      structure: { roots: Record<string, number> };
      commandLifecycle: {
        total: number;
        states: Record<string, number>;
        probeCorrelation: Record<string, number>;
      };
    };
    if (which === "root")
      internal.structure.roots.known_native_private_root =
        MAX_CLAUDE_CENSUS_COUNT;
    if (which === "state")
      internal.commandLifecycle.states.queued = MAX_CLAUDE_CENSUS_COUNT;
    if (which === "correlation")
      internal.commandLifecycle.probeCorrelation.match =
        MAX_CLAUDE_CENSUS_COUNT;
    if (which === "total")
      internal.commandLifecycle.total = MAX_CLAUDE_CENSUS_COUNT;
    c.observe(
      {
        kind: "json",
        value: {
          type: "command_lifecycle",
          state: "queued",
          command_uuid: probe,
        },
      },
      session,
      probe,
    );
    expect(c.snapshot(true).unavailableReason).toBe("counter_overflow");
  }
});

test("all production root/subtype consumers use the structural decoder, not copied predicates", async () => {
  for (const file of [
    "claude-code/protocol.ts",
    "claude-code/adapter.ts",
    "claude-code/effort-readiness.ts",
    "lifecycle-diagnostics.ts",
    "claude-code/output-census.ts",
  ]) {
    const text = await readFile(
      new URL(`../src/harnesses/${file}`, import.meta.url),
      "utf8",
    );
    const source = ts.createSourceFile(
      file,
      text,
      ts.ScriptTarget.Latest,
      true,
    );
    const duplicated: string[] = [];
    const visit = (n: ts.Node) => {
      if (
        ts.isPropertyAccessExpression(n) &&
        ts.isIdentifier(n.expression) &&
        ["frame", "value"].includes(n.expression.text) &&
        ["type", "subtype"].includes(n.name.text)
      )
        duplicated.push(n.getText(source));
      ts.forEachChild(n, visit);
    };
    visit(source);
    expect(duplicated).toEqual([]);
    expect(text.includes("decodeClaudeOutputTag")).toBe(true);
  }
});
