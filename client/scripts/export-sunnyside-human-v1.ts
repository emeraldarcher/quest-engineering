import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
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
  `${process.env.HOME ?? ""}/Library/Application Support/Steam/steamapps/common/Aseprite/Aseprite.app/Contents/MacOS/aseprite`,
];

async function steamAsepriteExecutables(): Promise<string[]> {
  const home = process.env.HOME ?? "";
  const steam = `${home}/Library/Application Support/Steam`;
  const metadata = [
    `${steam}/steamapps/libraryfolders.vdf`,
    `${steam}/config/libraryfolders.vdf`,
  ];
  const roots = new Set<string>([steam]);
  for (const file of metadata) {
    try {
      const contents = await readFile(file, "utf8");
      for (const match of contents.matchAll(/"path"\s+"([^"]+)"/g)) {
        const path = match[1]?.replaceAll("\\\\", "\\");
        if (path) roots.add(path);
      }
    } catch {
      // Steam and additional libraries are optional discovery sources.
    }
  }
  return [...roots].map(
    (root) =>
      `${root}/steamapps/common/Aseprite/Aseprite.app/Contents/MacOS/aseprite`,
  );
}

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
    ...(await steamAsepriteExecutables()),
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

interface SourceInspection {
  layers: Array<{ name: string; visible: boolean; frames: number[] }>;
  tagRepeats: number[];
}
interface AsepriteData {
  frames?: AsepriteFrame[];
  meta?: {
    version?: string;
    size?: { w: number; h: number };
    frameTags?: AsepriteTag[];
    layers?: AsepriteLayer[];
  };
}

const SHEET_COLUMNS = 16;
/** Calibrated from every runtime base-layer frame: opaque baseline is y=38. */
const HUMAN_V1_FOOT_ANCHOR = { x: 48, y: 39 } as const;
function parseSourceInspection(output: string): SourceInspection {
  const inspection: SourceInspection = { layers: [], tagRepeats: [] };
  for (const line of output.split("\n")) {
    const [kind, indexValue, nameOrRepeats, visible, frames = ""] = line
      .trim()
      .split("\t");
    const index = Number(indexValue);
    if (kind === "QE_LAYER" && Number.isInteger(index))
      inspection.layers[index] = {
        name: nameOrRepeats ?? "",
        visible: visible === "true",
        frames: frames
          ? frames.split(",").map(Number).filter(Number.isInteger)
          : [],
      };
    else if (kind === "QE_TAG" && Number.isInteger(index))
      inspection.tagRepeats[index] = Number(nameOrRepeats);
  }
  return inspection;
}

const layerRoles: Record<string, string> = {
  base: "base",
  "tools rear": "tools-rear",
  tools: "tools-front",
  "bowl hair": "hair-bowl",
  "short hair": "hair-short",
  "mop hair": "hair-mop",
  "spikey hair": "hair-spikey",
  "curly hair": "hair-curly",
  "long hair": "hair-long",
};

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

  await rm(outputRoot, { recursive: true, force: true });
  await mkdir(resolve(outputRoot, "layers"), { recursive: true });
  await mkdir(resolve(outputRoot, "runtime-layers"), { recursive: true });
  const scratchRoot = resolve(clientRoot, "../.pi/tmp");
  await mkdir(scratchRoot, { recursive: true });
  const sheet = resolve(outputRoot, "human-v1.0-composite.png");
  const rawData = resolve(scratchRoot, "human-v1.0-aseprite-export.json");
  const inspectionScript = resolve(scratchRoot, "inspect-human-v1.lua");
  await writeFile(
    inspectionScript,
    [
      "for i, layer in ipairs(app.activeSprite.layers) do",
      "  local frames = {}",
      "  for _, cel in ipairs(layer.cels) do table.insert(frames, tostring(cel.frame.frameNumber - 1)) end",
      '  print("QE_LAYER\\t" .. tostring(i - 1) .. "\\t" .. layer.name .. "\\t" .. tostring(layer.isVisible) .. "\\t" .. table.concat(frames, ","))',
      "end",
      "for i, tag in ipairs(app.activeSprite.tags) do",
      '  print("QE_TAG\\t" .. tostring(i - 1) .. "\\t" .. tostring(tag.repeats))',
      "end",
    ].join("\n"),
  );
  const inspected = await execFileAsync(cli, [
    "-b",
    source,
    "--script",
    inspectionScript,
  ]);
  const sourceInspection = parseSourceInspection(inspected.stdout);
  const metadataSheet = resolve(scratchRoot, "human-v1.0-all-layers.png");
  const sheetArguments = [
    "--sheet-type",
    "rows",
    "--sheet-columns",
    String(SHEET_COLUMNS),
  ];
  await execFileAsync(cli, [
    "-b",
    "--all-layers",
    "--list-tags",
    "--list-layers",
    source,
    "--sheet",
    metadataSheet,
    ...sheetArguments,
    "--data",
    rawData,
    "--format",
    "json-array",
  ]);
  await execFileAsync(cli, ["-b", source, "--sheet", sheet, ...sheetArguments]);
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
    const normalizedName = layer.name.toLocaleLowerCase();
    const role = layerRoles[normalizedName] ?? null;
    const file = role
      ? `runtime-layers/${role}.png`
      : `layers/${safeFileName(layer.name, index)}.png`;
    await execFileAsync(cli, [
      "-b",
      "--layer",
      layer.name,
      source,
      "--sheet",
      resolve(outputRoot, file),
      ...sheetArguments,
    ]);
    layerExports.push({
      name: layer.name,
      file,
      role,
      frameIndices: sourceInspection.layers[index]?.frames ?? [],
      sourceVisible: sourceInspection.layers[index]?.visible ?? false,
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
  const animations = data.meta.frameTags.map((tag, index) => ({
    id: `${tag.name}:${index + 1}`,
    tag: tag.name,
    direction: animationDirection(tag.name),
    from: tag.from,
    to: tag.to,
    playback: tag.direction,
    loop: (sourceInspection.tagRepeats[index] ?? 0) !== 1,
    frames: orderedFrames(tag),
  }));
  const directionalFamilies = Object.fromEntries(
    ["idle", "walk", "run"].map((family) => {
      const tagged = (suffix: string) =>
        animations.find((animation) => animation.tag === `${family}-${suffix}`)
          ?.id ?? null;
      return [
        family,
        {
          south: { animationId: tagged("s"), mirrorX: false },
          southeast: { animationId: tagged("se"), mirrorX: false },
          southwest: { animationId: tagged("se"), mirrorX: true },
          northeast: { animationId: tagged("ne"), mirrorX: false },
          northwest: { animationId: tagged("ne"), mirrorX: true },
          north: { animationId: tagged("n"), mirrorX: false },
        },
      ];
    }),
  );
  const runtime = {
    formatVersion: 3,
    sourceProvenance:
      "client/src/assets/sunnyside/source/human-v1.0/human-v1.0.aseprite",
    asepriteVersion: data.meta.version ?? "unknown",
    canvas: { width: 96, height: 64, grid: 16 },
    footAnchor: {
      ...HUMAN_V1_FOOT_ANCHOR,
      basis: "one pixel below the shared base-layer opaque baseline",
    },
    sheet: {
      file: "human-v1.0-composite.png",
      width: data.meta.size?.w ?? 0,
      height: data.meta.size?.h ?? 0,
      columns: SHEET_COLUMNS,
    },
    frames: data.frames.map((frame, index) => ({
      index,
      rect: frame.frame,
      durationMs: frame.duration,
    })),
    animations,
    directionalFamilies,
    layers: layerExports,
  };
  await writeFile(
    resolve(outputRoot, "human-v1.0.runtime.json"),
    `${JSON.stringify(runtime, null, 2)}\n`,
  );
  await writeFile(
    resolve(outputRoot, "README.md"),
    "# Generated Human v1.0 export\n\n" +
      "Generated deterministically from `client/src/assets/sunnyside/source/human-v1.0/human-v1.0.aseprite`. " +
      "`human-v1.0.runtime.json` preserves source tags, legitimate directional mirroring, frame order, durations, the calibrated foot anchor, and compositing-layer files for Pixi; runtime never parses Aseprite files.\n",
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
