import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";

const clientRoot = resolve(import.meta.dir, "..");
const assetsRoot = resolve(clientRoot, "src/assets/sunnyside");
const tilesetsRoot = resolve(clientRoot, "src/world/maps/tilesets");
const manifestPath = resolve(assetsRoot, "imported-manifest.json");
const animationManifestPath = resolve(
  clientRoot,
  "src/world/sunnyside-animation-manifest.ts",
);

type Tile = {
  id: number;
  image: string;
  imagewidth: number;
  imageheight: number;
};
type Tileset = {
  name: string;
  tiles?: Tile[];
  image?: string;
  imagewidth?: number;
  imageheight?: number;
};
type ImportManifest = {
  managedFiles: string[];
  assets: { path: string; hash: string; width: number; height: number }[];
};

function pngDimensions(bytes: Buffer) {
  if (bytes.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a")
    throw new Error("not a PNG");
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

function hash(bytes: Buffer) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function imageExists(
  tilesetPath: string,
  image: string,
  expectedWidth?: number,
  expectedHeight?: number,
) {
  if (
    image.includes("Downloads") ||
    image.startsWith("/") ||
    image.includes(":\\")
  )
    throw new Error(
      `${relative(clientRoot, tilesetPath)} has a non-repository image path: ${image}`,
    );
  const imagePath = resolve(dirname(tilesetPath), image);
  const imageRoot = resolve(clientRoot, "src/assets/sunnyside");
  if (!imagePath.startsWith(`${imageRoot}${sep}`))
    throw new Error(
      `${relative(clientRoot, tilesetPath)} image escapes Sunnyside assets: ${image}`,
    );
  const dimensions = pngDimensions(await readFile(imagePath));
  if (
    (expectedWidth && dimensions.width !== expectedWidth) ||
    (expectedHeight && dimensions.height !== expectedHeight)
  )
    throw new Error(
      `${relative(clientRoot, tilesetPath)} image dimensions do not match ${image}`,
    );
}

export async function validateSunnysideAssets() {
  const files = (await readdir(tilesetsRoot)).filter(
    (file) => file.startsWith("sunnyside-") && file.endsWith(".tsj"),
  );
  if (files.length < 10)
    throw new Error(
      "Expected world, forest, objects, and generated Sunnyside collection tilesets",
    );
  const generated = new Set([
    "sunnyside-animals.tsj",
    "sunnyside-buildings.tsj",
    "sunnyside-characters.tsj",
    "sunnyside-effects.tsj",
    "sunnyside-furniture.tsj",
    "sunnyside-nature.tsj",
    "sunnyside-props.tsj",
    "sunnyside-ui.tsj",
    "sunnyside-workshop.tsj",
  ]);
  for (const file of files.sort()) {
    const path = resolve(tilesetsRoot, file);
    const tileset = JSON.parse(await readFile(path, "utf8")) as Tileset;
    const ids = new Set<number>();
    for (const tile of tileset.tiles ?? []) {
      if (ids.has(tile.id))
        throw new Error(`${file} contains duplicate tile id ${tile.id}`);
      ids.add(tile.id);
      await imageExists(
        path,
        tile.image,
        generated.has(file) ? tile.imagewidth : undefined,
        generated.has(file) ? tile.imageheight : undefined,
      );
    }
    if (tileset.image)
      await imageExists(
        path,
        tileset.image,
        tileset.imagewidth,
        tileset.imageheight,
      );
  }

  const manifest = JSON.parse(
    await readFile(manifestPath, "utf8"),
  ) as ImportManifest;
  const managed = new Set<string>();
  const hashes = new Set<string>();
  for (const file of manifest.managedFiles) {
    if (!file.startsWith("assets/sunnyside/imported/") || managed.has(file))
      throw new Error(`Invalid or duplicate managed import path: ${file}`);
    managed.add(file);
  }
  for (const asset of manifest.assets) {
    if (asset.path.includes("Downloads"))
      throw new Error(`Asset manifest references Downloads: ${asset.path}`);
    const bytes = await readFile(resolve(clientRoot, "src", asset.path));
    const dimensions = pngDimensions(bytes);
    if (dimensions.width !== asset.width || dimensions.height !== asset.height)
      throw new Error(`Manifest dimensions are stale for ${asset.path}`);
    // Repeated paths are permitted only when source aliases deliberately point to
    // the pre-existing canonical runtime image, but unique visual payloads are not.
    if (hashes.has(asset.hash))
      throw new Error(
        `Duplicate canonical source payload in manifest: ${asset.path}`,
      );
    hashes.add(asset.hash);
    if (hash(bytes) !== asset.hash)
      throw new Error(`Manifest hash is stale for ${asset.path}`);
  }

  for (const catalog of [
    "sunnyside-asset-catalog.tmj",
    "sunnyside-character-catalog.tmj",
  ]) {
    const path = resolve(clientRoot, "src/world/maps/reference", catalog);
    const map = JSON.parse(await readFile(path, "utf8")) as {
      tilesets: { source: string }[];
    };
    for (const tileset of map.tilesets) {
      const source = resolve(dirname(path), tileset.source);
      if (!source.startsWith(`${tilesetsRoot}${sep}`))
        throw new Error(`${catalog} has a tileset outside maps/tilesets`);
      JSON.parse(await readFile(source, "utf8"));
    }
  }

  const animationSource = await readFile(animationManifestPath, "utf8");
  if (animationSource.includes("Downloads"))
    throw new Error("Animation manifest references Downloads");
  const imageMatches = [...animationSource.matchAll(/"image": "([^"]+)"/g)];
  if (!imageMatches.length)
    throw new Error("Animation manifest contains no PNG strip entries");
  for (const match of imageMatches) {
    const image = match[1];
    if (!image) continue;
    const assetPath = resolve(dirname(animationManifestPath), image);
    pngDimensions(await readFile(assetPath));
  }
  console.log(
    `Validated ${files.length} Sunnyside tilesets, ${manifest.assets.length} distinct image assets, and ${imageMatches.length} animation entries.`,
  );
}

if (import.meta.main) await validateSunnysideAssets();
