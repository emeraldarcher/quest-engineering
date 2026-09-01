import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import {
  mkdir,
  readdir,
  readFile,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const clientRoot = resolve(import.meta.dir, "..");
const assetsRoot = resolve(clientRoot, "src/assets/sunnyside");
const sourceRoot = resolve(assetsRoot, "source/human-v1.0");
const mapsRoot = resolve(clientRoot, "src/world/maps");
const tilesetsRoot = resolve(mapsRoot, "tilesets");
const referenceRoot = resolve(mapsRoot, "reference");
const manifestPath = resolve(assetsRoot, "imported-manifest.json");
const animationManifestPath = resolve(
  clientRoot,
  "src/world/sunnyside-animation-manifest.ts",
);
const inventoryPath = resolve(
  clientRoot,
  "../docs/sunnyside-asset-inventory.md",
);
const archiveRoot = "Sunnyside_World_ASSET_PACK_V2.1";
const assetsPrefix = `${archiveRoot}/Sunnyside_World_Assets/`;
const gameMakerPrefix = `${archiveRoot}/Sunnyside_World_Gamemaker/sprites/`;

export type AssetCategory =
  | "animals"
  | "buildings"
  | "characters"
  | "effects"
  | "furniture"
  | "nature"
  | "props"
  | "ui"
  | "workshop";

type SourceFile = {
  path: string;
  bytes: Buffer;
  source: "assets" | "gamemaker";
};
type ImportedAsset = {
  category: AssetCategory;
  source: string;
  sourceKind: "assets" | "gamemaker";
  path: string;
  hash: string;
  width: number;
  height: number;
  frames?: number;
  layer?: string;
};
type PreviousManifest = { managedFiles?: string[] };

function defaultSourcePath() {
  return resolve(
    process.env.SUNNYSIDE_ASSET_SOURCE ??
      resolve(
        process.env.HOME ?? "~",
        "Downloads/Sunnyside_World_ASSET_PACK_V2.1.zip",
      ),
  );
}

async function command(commandName: string, args: string[]) {
  const { stdout } = await execFileAsync(commandName, args, {
    encoding: "buffer",
    maxBuffer: 64 * 1024 * 1024,
  });
  return Buffer.from(stdout);
}

async function recursiveFiles(root: string): Promise<string[]> {
  const result: string[] = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = resolve(root, entry.name);
    if (entry.isDirectory()) result.push(...(await recursiveFiles(path)));
    else if (entry.isFile())
      result.push(relative(root, path).split(sep).join("/"));
  }
  return result;
}

async function openSource(sourcePath: string) {
  const sourceStat = await stat(sourcePath).catch(() => undefined);
  if (!sourceStat)
    throw new Error(`Sunnyside source does not exist: ${sourcePath}`);
  if (sourceStat.isFile()) {
    if (!sourcePath.endsWith(".zip"))
      throw new Error(
        `Sunnyside source must be a ZIP or extracted directory: ${sourcePath}`,
      );
    const entries = (await command("unzip", ["-Z1", sourcePath]))
      .toString("utf8")
      .split("\n")
      .filter(
        (entry) =>
          entry &&
          !entry.startsWith("__MACOSX/") &&
          !entry.includes("/.DS_Store"),
      );
    return {
      entries,
      read: (entry: string) => command("unzip", ["-p", sourcePath, entry]),
      description: sourcePath,
    };
  }

  const nestedRoot = resolve(sourcePath, archiveRoot);
  const root = existsSync(nestedRoot) ? nestedRoot : sourcePath;
  const entries = (await recursiveFiles(root)).map(
    (entry) => `${archiveRoot}/${entry}`,
  );
  return {
    entries,
    read: (entry: string) =>
      readFile(resolve(root, entry.slice(archiveRoot.length + 1))),
    description: root,
  };
}

function sha256(bytes: Buffer) {
  return createHash("sha256").update(bytes).digest("hex");
}

function pngDimensions(bytes: Buffer) {
  if (bytes.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a")
    throw new Error("Expected PNG data");
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

function categoryForAssets(path: string): AssetCategory | undefined {
  const pathInAssets = path.slice(assetsPrefix.length);
  if (pathInAssets.startsWith("UI/")) return "ui";
  if (pathInAssets.startsWith("Characters/")) return "characters";
  if (pathInAssets.startsWith("Elements/Animals/")) return "animals";
  if (pathInAssets.startsWith("Elements/VFX/")) return "effects";
  if (
    pathInAssets.startsWith("Elements/Plants/") ||
    pathInAssets.startsWith("Elements/Crops/")
  )
    return "nature";
  if (pathInAssets.startsWith("Elements/Other/")) return "props";
  // The two grid sheets remain in the existing Terrain and Forest tilesets.
  return undefined;
}

function categoryForGameMaker(path: string): AssetCategory {
  const resource = path.slice(gameMakerPrefix.length).split("/")[0] ?? "misc";
  const name = resource.toLowerCase();
  if (
    /^(base|bowlhair|curlyhair|longhair|mophair|shorthair|spikeyhair|tools)_|^spr_(idle|walking|run|doing|waiting|carry|hurt|jump|roll|caught|attack|axe|mining|watering|swimming|death|dig|reeling|casting|hammering)|skeleton|goblin/.test(
      name,
    )
  )
    return "characters";
  if (
    /^(arrow|axe$|basket|bluebar|cancel|confirm|cursor|dt_box|expression|greenbar|hammer$|hand_|happiness|indicator|itemdisc|label_|pickaxe|plan|plant$|playercount|redbar|rod|sandtimer|search|select|shovel|stopwatch|sword$|water$|w_box)/.test(
      name,
    )
  )
    return "ui";
  if (/(bird|blinking|chicken|cow|duck|pig|sheep)/.test(name)) return "animals";
  if (/(smoke|fire|glint|dust|leaves_hit)/.test(name)) return "effects";
  if (
    /(tree|mushroom|crop|beetroot|cabbage|carrot|cauliflower|kale|parsnip|potato|pumpkin|radish|sunflower|wheat|soil|seeds|truffle)/.test(
      name,
    )
  )
    return "nature";
  if (
    /(anvil|ore|minecart|beam|wood|crate|barrel|bucket|tool|hammer|pickaxe|shovel)/.test(
      name,
    )
  )
    return "workshop";
  if (
    /(chair|book|jar|mug|plate|picture|rug|sidetable|chest|knifeandfork)/.test(
      name,
    )
  )
    return "furniture";
  if (/(chimney|windmill|well)/.test(name)) return "buildings";
  return "props";
}

function destinationFor(category: AssetCategory, source: SourceFile) {
  if (source.source === "assets")
    return `assets/sunnyside/imported/${category}/${source.path.slice(assetsPrefix.length)}`;
  return `assets/sunnyside/imported/${category}/gamemaker/${source.path.slice(gameMakerPrefix.length)}`;
}

async function legacyHashes() {
  const hashes = new Map<string, string>();
  const excluded = new Set([
    "imported",
    "source",
    "generated",
    "reference",
    "custom",
  ]);
  for (const entry of await readdir(assetsRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || excluded.has(entry.name)) continue;
    for (const path of await recursiveFiles(resolve(assetsRoot, entry.name))) {
      if (!path.endsWith(".png")) continue;
      const fullPath = resolve(assetsRoot, entry.name, path);
      hashes.set(
        sha256(await readFile(fullPath)),
        `assets/sunnyside/${entry.name}/${path}`,
      );
    }
  }
  return hashes;
}

async function writeIfChanged(path: string, bytes: Buffer | string) {
  const next = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  const current = await readFile(path).catch(() => undefined);
  if (current && Buffer.compare(current, next) === 0) return false;
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, next);
  return true;
}

function stripFrames(name: string) {
  const match = name.match(/_strip(\d+)\.png$/i);
  return match ? Number(match[1]) : undefined;
}

function humanLayer(name: string) {
  const match = name.match(
    /^(base|bowlhair|shorthair|mophair|spikeyhair|curlyhair|longhair|tools)_/i,
  );
  return match?.[1]?.toLowerCase();
}

function relativeImagePath(path: string) {
  return relative(tilesetsRoot, resolve(clientRoot, "src", path))
    .split(sep)
    .join("/");
}

function categoryTitle(category: AssetCategory) {
  return category === "ui"
    ? "UI & Icons"
    : `${category[0]?.toUpperCase()}${category.slice(1)}`;
}

function displayName(asset: ImportedAsset) {
  return basename(asset.source, ".png")
    .replace(/^spr_deco_/, "")
    .replace(/^spr_/, "")
    .replace(/[_-]+/g, " ");
}

function collectionTileset(category: AssetCategory, assets: ImportedAsset[]) {
  return {
    name: `Sunnyside — ${categoryTitle(category)}`,
    tilewidth: 16,
    tileheight: 16,
    tilecount: assets.length,
    type: "tileset",
    version: "1.10",
    tiledversion: "1.10.2",
    properties: [
      { name: "category", type: "string", value: category },
      { name: "qeSunnysideGenerated", type: "bool", value: true },
    ],
    tiles: assets.map((asset, id) => ({
      id,
      image: relativeImagePath(asset.path),
      imagewidth: asset.width,
      imageheight: asset.height,
      properties: [
        { name: "category", type: "string", value: asset.category },
        { name: "source", type: "string", value: asset.source },
        { name: "sourceKind", type: "string", value: asset.sourceKind },
        {
          name: "animated",
          type: "bool",
          value: Boolean(asset.frames && asset.frames > 1),
        },
        ...(asset.frames
          ? [{ name: "frames", type: "int", value: asset.frames }]
          : []),
        ...(asset.layer
          ? [{ name: "compositingLayer", type: "string", value: asset.layer }]
          : []),
      ],
    })),
  };
}

function catalogMap(
  _name: string,
  categories: AssetCategory[],
  byCategory: Map<AssetCategory, ImportedAsset[]>,
) {
  const tilesets = categories.map((category, index) => ({
    firstgid:
      1 +
      categories
        .slice(0, index)
        .reduce(
          (total, item) => total + (byCategory.get(item)?.length ?? 0),
          0,
        ),
    source: `../tilesets/sunnyside-${category}.tsj`,
  }));
  const layers: object[] = [];
  let nextObjectId = 1;
  let nextLayerId = 1;
  let y = 32;
  let mapWidth = 1024;
  for (const [categoryIndex, category] of categories.entries()) {
    const assets = byCategory.get(category) ?? [];
    if (!assets.length) continue;
    const maximumWidth = Math.max(...assets.map((asset) => asset.width));
    const maximumHeight = Math.max(...assets.map((asset) => asset.height));
    const columns = Math.max(
      1,
      Math.min(6, Math.floor(2048 / (maximumWidth + 32))),
    );
    const cellWidth = maximumWidth + 32;
    const cellHeight = maximumHeight + 40;
    mapWidth = Math.max(mapWidth, columns * cellWidth + 32);
    const firstgid = tilesets[categoryIndex]?.firstgid ?? 1;
    const objects = assets.flatMap((asset, id) => {
      const column = id % columns;
      const row = Math.floor(id / columns);
      const x = 16 + column * cellWidth;
      const objectY = y + 24 + row * cellHeight + asset.height;
      const labelY = objectY + 4;
      return [
        {
          id: nextObjectId++,
          gid: firstgid + id,
          name: displayName(asset),
          type: "sunnyside_asset",
          x,
          y: objectY,
          width: asset.width,
          height: asset.height,
          visible: true,
          properties: [{ name: "source", type: "string", value: asset.source }],
        },
        {
          id: nextObjectId++,
          name: displayName(asset),
          type: "sunnyside_label",
          x,
          y: labelY,
          width: cellWidth - 8,
          height: 16,
          visible: true,
          text: {
            text: displayName(asset),
            fontfamily: "sans-serif",
            pixelsize: 10,
            wrap: true,
            color: "#2f2721",
          },
        },
      ];
    });
    layers.push({
      id: nextLayerId++,
      name: `— ${category.toUpperCase()} —`,
      type: "objectgroup",
      x: 0,
      y: 0,
      opacity: 1,
      visible: true,
      draworder: "topdown",
      objects,
      properties: [{ name: "category", type: "string", value: category }],
    });
    y += Math.ceil(assets.length / columns) * cellHeight + 56;
  }
  return {
    compressionlevel: -1,
    height: Math.ceil((y + 32) / 16),
    infinite: false,
    layers,
    nextlayerid: nextLayerId,
    nextobjectid: nextObjectId,
    orientation: "orthogonal",
    renderorder: "right-down",
    tiledversion: "1.10.2",
    tileheight: 16,
    tilewidth: 16,
    type: "map",
    version: "1.10",
    width: Math.ceil(mapWidth / 16),
    tilesets,
    properties: [
      { name: "qeReferenceMap", type: "bool", value: true },
      { name: "qeRuntimeMap", type: "bool", value: false },
      {
        name: "qeReferencePurpose",
        type: "string",
        value:
          "Generated exhaustive Sunnyside asset browser. Do not design a scene here.",
      },
    ],
  };
}

function animationManifest(assets: ImportedAsset[]) {
  const animations = assets
    .filter((asset) => asset.frames && asset.frames > 1)
    .sort((left, right) => left.path.localeCompare(right.path))
    .map((asset) => ({
      key: asset.path
        .replace(/^assets\/sunnyside\/(imported\/)?/, "")
        .replace(/[^a-zA-Z0-9]+/g, "-"),
      source: asset.source,
      image: `../assets/sunnyside/${asset.path.replace(/^assets\/sunnyside\//, "")}`,
      frames: asset.frames ?? 1,
      frameWidth: Math.floor(asset.width / (asset.frames ?? 1)),
      frameHeight: asset.height,
      frameDurationMs: 100,
      loop: !/(death|hurt|attack|caught|jump)/i.test(asset.source),
      ...(asset.layer ? { compositingLayer: asset.layer } : {}),
    }));
  const character = animations.filter((animation) =>
    /\/Characters\/|\/characters\//.test(animation.source),
  );
  const environment = animations.filter(
    (animation) => !character.includes(animation),
  );
  const characterJson = JSON.stringify(
    Object.fromEntries(
      character.map((animation) => [animation.key, animation]),
    ),
    null,
    2,
  );
  const environmentJson = JSON.stringify(
    Object.fromEntries(
      environment.map((animation) => [animation.key, animation]),
    ),
    null,
    2,
  );
  return `// Generated by scripts/import-sunnyside-assets.ts. Do not hand-edit.\n\nexport type SunnysideAnimation = {\n  key: string;\n  source: string;\n  image: string;\n  frames: number;\n  frameWidth: number;\n  frameHeight: number;\n  frameDurationMs: number;\n  loop: boolean;\n  compositingLayer?: string;\n};\n\nexport const SunnysideCharacterAnimations: Record<string, SunnysideAnimation> =\n  JSON.parse(\`${characterJson}\`);\n\nexport const SunnysideEnvironmentAnimations: Record<\n  string,\n  SunnysideAnimation\n> = JSON.parse(\`${environmentJson}\`);\n`;
}

function inventoryMarkdown(
  sourceDescription: string,
  assets: ImportedAsset[],
  duplicateCount: number,
  importedBytes: number,
  sourceCounts: Map<AssetCategory, number>,
  duplicateCounts: Map<AssetCategory, number>,
  totalSourceImages: number,
) {
  const code = "`";
  const categories = [...new Set(assets.map((asset) => asset.category))].sort();
  const rows = categories.map((category) => {
    const matching = assets.filter((asset) => asset.category === category);
    return `| ${category} | ${sourceCounts.get(category) ?? 0} | ${matching.length} | ${duplicateCounts.get(category) ?? 0} | ${code}Sunnyside — ${categoryTitle(category)}${code} | ${matching.filter((asset) => asset.frames).length} |`;
  });
  return `# Sunnyside asset inventory\n\nGenerated by ${code}bun run --cwd client import:sunnyside-assets${code}. This catalog is authoring-only; it does not load assets into the runtime.\n\n## Source provenance\n\n- Canonical source inspected: ${code}${sourceDescription}${code}\n- Pack: Sunnyside World Asset Pack v2.1 (Daniel Diggle)\n- Asset PNG source paths: ${code}Sunnyside_World_Assets/…${code}\n- Static GameMaker composites: ${code}Sunnyside_World_Gamemaker/sprites/…${code} (art only; no ${code}.yy${code} project resources are imported)\n- Human v1.0 editable source: ${code}client/src/assets/sunnyside/source/human-v1.0/human-v1.0.aseprite${code}\n- Total useful source images inspected: ${totalSourceImages} (asset-folder PNGs plus static GameMaker composites)\n- Source payload duplicates excluded by SHA-256: ${duplicateCount}\n- Canonical imported/distinct collection image records: ${assets.length}; plus 2 retained grid sheets (${assets.length + 2} total library visuals)\n- Imported PNG bytes managed by the importer: ${(importedBytes / 1024 / 1024).toFixed(2)} MiB\n\n## Categories\n\n| Category | Source count | Imported distinct | Excluded duplicates | Authoring tileset | Strip animations |\n| --- | ---: | ---: | ---: | --- | ---: |\n${rows.join("\n")}\n\nThe Terrain category is represented by the retained ${code}sunnyside-world.tsj${code} (1024×1024 / 16px grid) and ${code}sunnyside-forest.tsj${code} (320×576 / 32px grid), rather than a redundant collection tileset.\n\n## Representation policy\n\n- PNG is canonical for static art and PNG strips are canonical for animation.\n- Equivalent GIFs, GameMaker ${code}.yy${code} resources, pack-local Aseprite sources, and duplicate download payloads are intentionally excluded.\n- Original source file paths are retained as the ${code}source${code} property on every collection tile.\n- The existing grid tilesets ${code}sunnyside-world.tsj${code} and ${code}sunnyside-forest.tsj${code} remain the canonical 16px world/terrain and 32px forest sheets, including their Wang sets.\n- Animation timing and strip rectangles are centralized in ${code}client/src/world/sunnyside-animation-manifest.ts${code}; v1.0 remains pending a real Aseprite-compatible CLI export.\n\n## Browse\n\nOpen ${code}client/src/world/maps/reference/sunnyside-asset-catalog.tmj${code} for non-character art, and ${code}client/src/world/maps/reference/sunnyside-character-catalog.tmj${code} for the complete legacy character strip vocabulary. These are generated reference maps, not production maps.\n`;
}

export async function importSunnysideAssets(sourcePath = defaultSourcePath()) {
  const source = await openSource(sourcePath);
  const assetPaths = source.entries.filter(
    (path) => path.startsWith(assetsPrefix) && path.endsWith(".png"),
  );
  const directGameMakerPaths = source.entries.filter((path) => {
    if (!path.startsWith(gameMakerPrefix) || !path.endsWith(".png"))
      return false;
    return path.slice(gameMakerPrefix.length).split("/").length === 2;
  });
  const staticGameMakerPaths = directGameMakerPaths.filter((path) => {
    const resource = path.slice(gameMakerPrefix.length).split("/")[0] ?? "";
    return (
      directGameMakerPaths.filter((other) => other.includes(`/${resource}/`))
        .length === 1
    );
  });
  const candidates = [
    ...assetPaths.map((path) => ({ path, source: "assets" as const })),
    ...staticGameMakerPaths.map((path) => ({
      path,
      source: "gamemaker" as const,
    })),
  ]
    .filter(
      (candidate) =>
        candidate.source === "gamemaker" || categoryForAssets(candidate.path),
    )
    .sort((left, right) => left.path.localeCompare(right.path));

  const previous = (await readFile(manifestPath, "utf8")
    .then(JSON.parse)
    .catch(() => ({}))) as PreviousManifest;
  const legacy = await legacyHashes();
  const hashes = new Map<string, ImportedAsset>();
  const assets: ImportedAsset[] = [];
  const managedFiles: string[] = [];
  const sourceCounts = new Map<AssetCategory, number>();
  const duplicateCounts = new Map<AssetCategory, number>();
  for (const candidate of candidates) {
    const category =
      candidate.source === "assets"
        ? categoryForAssets(candidate.path)
        : categoryForGameMaker(candidate.path);
    if (category)
      sourceCounts.set(category, (sourceCounts.get(category) ?? 0) + 1);
  }
  let duplicateCount = 0;
  let importedBytes = 0;

  for (const candidate of candidates) {
    const category =
      candidate.source === "assets"
        ? categoryForAssets(candidate.path)
        : categoryForGameMaker(candidate.path);
    if (!category) continue;
    const bytes = await source.read(candidate.path);
    const hash = sha256(bytes);
    if (hashes.has(hash)) {
      duplicateCount += 1;
      duplicateCounts.set(category, (duplicateCounts.get(category) ?? 0) + 1);
      continue;
    }
    const sourceFile: SourceFile = { ...candidate, bytes };
    const outputPath = legacy.get(hash) ?? destinationFor(category, sourceFile);
    if (!legacy.has(hash)) {
      const fullPath = resolve(clientRoot, "src", outputPath);
      await writeIfChanged(fullPath, bytes);
      managedFiles.push(outputPath);
      importedBytes += bytes.length;
    }
    const dimensions = pngDimensions(bytes);
    const fileName = basename(candidate.path);
    const frames = stripFrames(fileName);
    const layer = candidate.path.includes("/Characters/Human/")
      ? humanLayer(fileName)
      : undefined;
    const asset: ImportedAsset = {
      category,
      source: candidate.path.slice(archiveRoot.length + 1),
      sourceKind: candidate.source,
      path: outputPath,
      hash,
      ...dimensions,
      ...(frames === undefined ? {} : { frames }),
      ...(layer === undefined ? {} : { layer }),
    };
    hashes.set(hash, asset);
    assets.push(asset);
  }

  const v1Source = sourcePath.endsWith(".zip")
    ? resolve(
        process.env.SUNNYSIDE_HUMAN_V1_SOURCE ??
          resolve(
            process.env.HOME ?? "~",
            "Downloads/sunnyside_world_chatacter_anim_human_v1.0.aseprite",
          ),
      )
    : resolve(
        process.env.SUNNYSIDE_HUMAN_V1_SOURCE ?? dirname(sourcePath),
        "sunnyside_world_chatacter_anim_human_v1.0.aseprite",
      );
  if (!existsSync(v1Source))
    throw new Error(`Missing Human v1.0 Aseprite source: ${v1Source}`);
  const v1Bytes = await readFile(v1Source);
  await writeIfChanged(resolve(sourceRoot, "human-v1.0.aseprite"), v1Bytes);
  await writeIfChanged(
    resolve(sourceRoot, "provenance.json"),
    `${JSON.stringify(
      {
        sourceFile: "sunnyside_world_chatacter_anim_human_v1.0.aseprite",
        version: "1.0",
        sha256: sha256(v1Bytes),
        frames: 310,
        layers: 19,
        tags: 34,
        grid: "16x16",
        exportStatus: "pending-aseprite-compatible-cli",
      },
      null,
      2,
    )}\n`,
  );

  for (const oldFile of previous.managedFiles ?? []) {
    if (
      !managedFiles.includes(oldFile) &&
      oldFile.startsWith("assets/sunnyside/imported/")
    )
      await unlink(resolve(clientRoot, "src", oldFile)).catch(() => undefined);
  }

  const categories = [
    ...new Set(assets.map((asset) => asset.category)),
  ].sort() as AssetCategory[];
  const byCategory = new Map(
    categories.map((category) => [
      category,
      assets
        .filter((asset) => asset.category === category)
        .sort((left, right) => left.path.localeCompare(right.path)),
    ]),
  );
  for (const category of categories) {
    await writeIfChanged(
      resolve(tilesetsRoot, `sunnyside-${category}.tsj`),
      `${JSON.stringify(collectionTileset(category, byCategory.get(category) ?? []), null, 2)}\n`,
    );
  }
  await writeIfChanged(animationManifestPath, animationManifest(assets));
  await writeIfChanged(
    resolve(referenceRoot, "sunnyside-asset-catalog.tmj"),
    `${JSON.stringify(
      catalogMap(
        "Sunnyside Asset Catalog",
        categories.filter((category) => category !== "characters"),
        byCategory,
      ),
      null,
      2,
    )}\n`,
  );
  await writeIfChanged(
    resolve(referenceRoot, "sunnyside-character-catalog.tmj"),
    `${JSON.stringify(catalogMap("Sunnyside Character Catalog", ["characters"], byCategory), null, 2)}\n`,
  );
  await writeIfChanged(
    manifestPath,
    `${JSON.stringify({ version: 1, managedFiles: managedFiles.sort(), assets, duplicateCount }, null, 2)}\n`,
  );
  await writeIfChanged(
    inventoryPath,
    inventoryMarkdown(
      basename(source.description),
      assets,
      duplicateCount,
      importedBytes,
      sourceCounts,
      duplicateCounts,
      candidates.length + 2,
    ),
  );

  console.log(
    `Imported ${assets.length} distinct Sunnyside image records; excluded ${duplicateCount} duplicate payloads.`,
  );
  console.log(
    `Generated ${categories.length} collection tilesets and two reference catalogs.`,
  );
  console.log(
    "Human v1.0 source retained; no Aseprite-compatible CLI was found, so no v1.0 PNG export was generated.",
  );
  return { assets, duplicateCount, categories };
}

if (import.meta.main) await importSunnysideAssets();
