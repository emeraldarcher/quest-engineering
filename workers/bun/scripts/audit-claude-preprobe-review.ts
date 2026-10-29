// Static only: read repository snapshots and artifact bytes. Never import the
// SDK runtime, target executable, Worker constructor, or any infrastructure.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";

const baseline = process.env.QE_PREPROBE_BASELINE_DIR;
assert(baseline, "Missing static baseline snapshots.");
const printer = ts.createPrinter({ removeComments: true });
function source(path: string, old = false) {
  const text = readFileSync(
    old ? join(baseline as string, path.replaceAll("/", "_")) : path,
    "utf8",
  );
  return ts.createSourceFile(
    path,
    text,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
}
function declaration(file: ts.SourceFile, name: string) {
  let found: ts.Node | undefined;
  function visit(node: ts.Node) {
    if (
      (ts.isFunctionDeclaration(node) || ts.isVariableDeclaration(node)) &&
      node.name?.getText(file) === name
    )
      found = node;
    ts.forEachChild(node, visit);
  }
  visit(file);
  assert(found, `Missing authority/wire declaration ${name}`);
  return printer.printNode(ts.EmitHint.Unspecified, found, file);
}
const authorities = {
  "src/harnesses/claude-code/adapter.ts": [
    "claudeCodeCommand",
    "attestClaudeInit",
    "assertExactConfiguration",
    "assertBrokerBinding",
    "assertSessionBinding",
    "assertExactModelUsage",
  ],
  "src/harnesses/claude-code/effort-readiness.ts": [
    "supportsClaudeReasoning",
    "attestClaudeEffortResponse",
    "attestClaudeEffort",
  ],
  "src/harnesses/claude-code/protocol.ts": [
    "waitForInit",
    "cancelClaudePreparation",
    "rejectServerToolEvidence",
    "message",
  ],
};
let count = 0;
for (const [path, names] of Object.entries(authorities)) {
  const old = source(path, true),
    current = source(path);
  for (const name of names) {
    assert.equal(
      declaration(current, name),
      declaration(old, name),
      `Changed protected authority/wire AST: ${path}/${name}`,
    );
    count++;
  }
}
console.log(
  `PASS: ${count} protected authority/wire AST declarations equal production baseline (probe object, argv/environment, init/model/effort, timeout/cancel).`,
);
for (const [arch, expected] of [
  [
    "linux-arm64",
    "24caa9e6ff13bf227049a2626f1c816fc895023050f0ec3b12dbf14d897367e0",
  ],
  [
    "linux-x64",
    "a967e7b1d8b4e47ee421d5433027880347952b0c0857abf880e2c942a4ec93b3",
  ],
]) {
  const artifact = new URL(
    `../../../.pi/tmp/claude-mods-reassessment/packages/${arch}/claude`,
    import.meta.url,
  );
  const bytes = readFileSync(artifact);
  const actual = createHash("sha256").update(bytes).digest("hex");
  assert.equal(actual, expected, `Pinned Claude ${arch} artifact mismatch`);
  console.log(
    `PASS: static-only Claude ${arch} SHA-256 ${actual} (${bytes.length} bytes).`,
  );
}
