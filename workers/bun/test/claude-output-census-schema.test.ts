import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import ts from "typescript";
import {
  CLAUDE_OUTPUT_RESULT_SUBTYPES,
  CLAUDE_OUTPUT_SIMPLE_TYPES,
  CLAUDE_OUTPUT_SYSTEM_SUBTYPES,
} from "../src/harnesses/claude-code/output-tags.ts";

test("public catalog exactly matches pinned SDK declarations, not the larger raw-native catalog", async () => {
  const root = resolve(
    import.meta.dir,
    "../node_modules/@anthropic-ai/claude-agent-sdk",
  );
  const pkg = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));
  expect(pkg.version).toBe("0.3.292");
  expect(pkg.claudeCodeVersion).toBe("2.1.292");
  // Parse type declarations only. Never import the SDK runtime or launch Claude.
  const text = await readFile(resolve(root, "sdk.d.ts"), "utf8");
  const source = ts.createSourceFile(
    "sdk.d.ts",
    text,
    ts.ScriptTarget.Latest,
    true,
  );
  const aliases = new Map<string, ts.TypeNode>();
  for (const node of source.statements)
    if (ts.isTypeAliasDeclaration(node)) aliases.set(node.name.text, node.type);
  const literals = (node: ts.TypeNode): string[] => {
    if (ts.isLiteralTypeNode(node) && ts.isStringLiteral(node.literal))
      return [node.literal.text];
    if (ts.isUnionTypeNode(node)) return node.types.flatMap(literals);
    throw new Error(
      "Reviewed discriminator is no longer a closed string-literal union.",
    );
  };
  const leaves = (node: ts.TypeNode): ts.TypeLiteralNode[] => {
    if (ts.isTypeLiteralNode(node)) return [node];
    if (ts.isUnionTypeNode(node)) return node.types.flatMap(leaves);
    if (ts.isTypeReferenceNode(node)) {
      const name = ts.isQualifiedName(node.typeName)
        ? node.typeName.right.text
        : node.typeName.text;
      const target = aliases.get(name);
      if (!target)
        throw new Error("Pinned output schema alias is unavailable.");
      return leaves(target);
    }
    throw new Error(
      "Pinned output schema shape changed; manual review required.",
    );
  };
  const stdout = aliases.get("StdoutMessage");
  if (!stdout) throw new Error("Pinned StdoutMessage alias unavailable.");
  const types = new Set<string>(),
    system = new Set<string>(),
    result = new Set<string>();
  for (const leaf of leaves(stdout)) {
    const fields = new Map(
      leaf.members.flatMap((n) =>
        ts.isPropertySignature(n) && n.type
          ? [[n.name.getText(source), n.type] as const]
          : [],
      ),
    );
    const type = fields.get("type");
    if (!type) throw new Error("Output member missing type discriminator.");
    for (const name of literals(type)) {
      types.add(name);
      if (name === "system" || name === "result") {
        const sub = fields.get("subtype");
        if (!sub) throw new Error("Reviewed output subtype missing.");
        for (const value of literals(sub))
          (name === "system" ? system : result).add(value);
      }
    }
  }
  expect([...types].sort()).toEqual(
    [...CLAUDE_OUTPUT_SIMPLE_TYPES, "system", "result"].sort(),
  );
  expect([...system].sort()).toEqual([...CLAUDE_OUTPUT_SYSTEM_SUBTYPES].sort());
  expect([...result].sort()).toEqual([...CLAUDE_OUTPUT_RESULT_SUBTYPES].sort());
});
