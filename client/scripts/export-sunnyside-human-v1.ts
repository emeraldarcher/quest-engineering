import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const clientRoot = resolve(import.meta.dir, "..");
const source = resolve(
  clientRoot,
  "src/assets/sunnyside/source/human-v1.0/human-v1.0.aseprite",
);
const outputRoot = resolve(
  clientRoot,
  "src/assets/sunnyside/generated/human-v1.0",
);

async function available(command: string) {
  try {
    await execFileAsync(command, ["--version"]);
    return true;
  } catch {
    return false;
  }
}

async function asepriteCli() {
  const configured = process.env.ASEPRITE_BIN;
  if (configured && (await available(configured))) return configured;
  for (const candidate of ["aseprite", "libresprite"]) {
    if (await available(candidate)) return candidate;
  }
  return undefined;
}

export async function exportSunnysideHumanV1() {
  if (!existsSync(source))
    throw new Error(
      "Human v1.0 source is missing. Run import:sunnyside-assets first.",
    );
  const cli = await asepriteCli();
  if (!cli) {
    console.error("No Aseprite-compatible CLI found; no export was created.");
    console.error("Install/configure one yourself, then run:");
    console.error(
      "  ASEPRITE_BIN=/path/to/aseprite bun run --cwd client export:sunnyside-human-v1",
    );
    process.exitCode = 2;
    return;
  }

  await mkdir(outputRoot, { recursive: true });
  const sheet = resolve(outputRoot, "human-v1.0-composite.png");
  const data = resolve(outputRoot, "human-v1.0-composite.json");
  await execFileAsync(cli, [
    "-b",
    source,
    "--sheet",
    sheet,
    "--sheet-type",
    "horizontal",
    "--data",
    data,
    "--format",
    "json-array",
  ]);
  const metadata = JSON.parse(await readFile(data, "utf8")) as {
    frames?: unknown[];
    meta?: { frameTags?: unknown[]; layers?: unknown[] };
  };
  if (!metadata.frames?.length || !metadata.meta?.frameTags?.length)
    throw new Error("Aseprite export did not produce frame/tag metadata");
  await writeFile(
    resolve(outputRoot, "README.md"),
    "# Generated Human v1.0 export\n\n" +
      "Generated from `source/human-v1.0/human-v1.0.aseprite` with Aseprite/LibreSprite. " +
      "The composite PNG preserves source frame order; JSON contains durations and tag names. " +
      "The editable Aseprite source remains canonical for its 19 customization layers.\n",
  );
  console.log(
    `Exported ${metadata.frames.length} frames and ${metadata.meta.frameTags.length} tags with ${cli}.`,
  );
}

if (import.meta.main) await exportSunnysideHumanV1();
