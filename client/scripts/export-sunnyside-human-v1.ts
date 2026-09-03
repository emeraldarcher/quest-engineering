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

const STANDARD_MACOS_EXECUTABLES = [
  "/Applications/Aseprite.app/Contents/MacOS/aseprite",
  `${process.env.HOME ?? ""}/Applications/Aseprite.app/Contents/MacOS/aseprite`,
];

async function available(command: string): Promise<boolean> {
  if (command.includes("/") && !existsSync(command)) return false;
  try {
    await execFileAsync(command, ["--version"]);
    return true;
  } catch {
    return false;
  }
}

export async function findAsepriteCli(): Promise<string | null> {
  const configured = process.env.ASEPRITE_BIN;
  if (configured) return (await available(configured)) ? configured : null;
  for (const candidate of [
    ...STANDARD_MACOS_EXECUTABLES,
    "aseprite",
    "libresprite",
  ])
    if (candidate && (await available(candidate))) return candidate;
  return null;
}

function safeFileName(value: string, index: number): string {
  const safe = value
    .normalize("NFKD")
    .replace(/[^a-zA-Z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLocaleLowerCase();
  return `${String(index + 1).padStart(2, "0")}-${safe || "layer"}`;
}

export function animationDirection(
  tag: string,
):
  | "north"
  | "northeast"
  | "east"
  | "southeast"
  | "south"
  | "southwest"
  | "west"
  | "northwest"
  | null {
  const value = tag.toLocaleLowerCase();
  if (/(^|[-_ ])(northeast|north-east|ne)$/.test(value)) return "northeast";
  if (/(^|[-_ ])(southeast|south-east|se)$/.test(value)) return "southeast";
  if (/(^|[-_ ])(southwest|south-west|sw)$/.test(value)) return "southwest";
  if (/(^|[-_ ])(northwest|north-west|nw)$/.test(value)) return "northwest";
  if (/(^|[-_ ])(north|up|n)$/.test(value)) return "north";
  if (/(^|[-_ ])(south|down|s)$/.test(value)) return "south";
  if (/(^|[-_ ])(east|right|e)$/.test(value)) return "east";
  if (/(^|[-_ ])(west|left|w)$/.test(value)) return "west";
  return null;
}

interface AsepriteFrame {
  filename: string;
  frame: { x: number; y: number; w: number; h: number };
  duration: number;
}
interface AsepriteTag {
  name: string;
  from: number;
  to: number;
  direction: string;
}
interface AsepriteLayer {
  name: string;
  group?: string;
  opacity?: number;
  blendMode?: string;
}
interface AsepriteData {
  frames?: AsepriteFrame[];
  meta?: { frameTags?: AsepriteTag[]; layers?: AsepriteLayer[] };
}

export async function exportSunnysideHumanV1(): Promise<boolean> {
  if (!existsSync(source))
    throw new Error(
      "Human v1.0 source is missing. Run import:sunnyside-assets first.",
    );
  const cli = await findAsepriteCli();
  if (!cli) {
    const configured = process.env.ASEPRITE_BIN;
    console.error(
      configured
        ? `ASEPRITE_BIN is not executable: ${configured}`
        : "No Aseprite-compatible CLI found, including the conventional macOS app-bundle path.",
    );
    console.error("Provide the executable explicitly, then run:");
    console.error(
      "  ASEPRITE_BIN=/Applications/Aseprite.app/Contents/MacOS/aseprite bun run --cwd client export:sunnyside-human-v1",
    );
    return false;
  }

  await mkdir(resolve(outputRoot, "layers"), { recursive: true });
  const scratchRoot = resolve(clientRoot, "../.pi/tmp");
  await mkdir(scratchRoot, { recursive: true });
  const sheet = resolve(outputRoot, "human-v1.0-composite.png");
  const rawData = resolve(scratchRoot, "human-v1.0-aseprite-export.json");
  await execFileAsync(cli, [
    "-b",
    source,
    "--list-tags",
    "--list-layers",
    "--sheet",
    sheet,
    "--sheet-type",
    "horizontal",
    "--data",
    rawData,
    "--format",
    "json-array",
  ]);
  const data = JSON.parse(await readFile(rawData, "utf8")) as AsepriteData;
  if (!data.frames?.length || !data.meta?.frameTags?.length)
    throw new Error("Aseprite export did not produce frame/tag metadata");

  const layers = data.meta.layers ?? [];
  if (!layers.length)
    throw new Error(
      "Aseprite export did not produce compositing-layer metadata",
    );
  const layerExports = [];
  for (const [index, layer] of layers.entries()) {
    const file = `${safeFileName(layer.name, index)}.png`;
    await execFileAsync(cli, [
      "-b",
      source,
      "--layer",
      layer.name,
      "--sheet",
      resolve(outputRoot, "layers", file),
      "--sheet-type",
      "horizontal",
    ]);
    layerExports.push({
      name: layer.name,
      file: `layers/${file}`,
      group: layer.group ?? null,
      opacity: layer.opacity ?? 255,
      blendMode: layer.blendMode ?? "normal",
    });
  }

  const orderedFrames = (tag: AsepriteTag): number[] => {
    const forward = Array.from(
      { length: tag.to - tag.from + 1 },
      (_, offset) => tag.from + offset,
    );
    if (tag.direction === "reverse") return [...forward].reverse();
    if (tag.direction === "pingpong")
      return [...forward, ...forward.slice(1, -1).reverse()];
    if (tag.direction === "pingpong_reverse") {
      const reverse = [...forward].reverse();
      return [...reverse, ...reverse.slice(1, -1).reverse()];
    }
    return forward;
  };
  const runtime = {
    formatVersion: 1,
    source: "source/human-v1.0/human-v1.0.aseprite",
    composite: "human-v1.0-composite.png",
    frames: data.frames.map((frame, index) => ({
      index,
      rect: frame.frame,
      durationMs: frame.duration,
    })),
    animations: data.meta.frameTags.map((tag) => ({
      tag: tag.name,
      direction: animationDirection(tag.name),
      from: tag.from,
      to: tag.to,
      playback: tag.direction,
      frames: orderedFrames(tag),
    })),
    layers: layerExports,
  };
  await writeFile(
    resolve(outputRoot, "human-v1.0.runtime.json"),
    `${JSON.stringify(runtime, null, 2)}\n`,
  );
  await writeFile(
    resolve(outputRoot, "README.md"),
    "# Generated Human v1.0 export\n\n" +
      "Generated deterministically from `source/human-v1.0/human-v1.0.aseprite`. " +
      "`human-v1.0.runtime.json` preserves source tags, directions, frame order, durations, and compositing-layer files for Pixi; runtime never parses Aseprite files.\n",
  );
  console.log(
    `Exported ${runtime.frames.length} frames, ${runtime.animations.length} tags, and ${runtime.layers.length} layers with ${cli}.`,
  );
  return true;
}

if (import.meta.main) {
  const exported = await exportSunnysideHumanV1();
  if (!exported) process.exitCode = 2;
}
