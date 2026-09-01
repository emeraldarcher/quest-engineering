import { existsSync } from "node:fs";
import {
  copyFile,
  mkdir,
  readdir,
  readFile,
  writeFile,
} from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";

export const GAME_MAKER_EMPTY_TILE = -2147483648;
const GAME_MAKER_TILE_ID_MASK = 0x0fffffff;
const GAME_MAKER_MIRROR = 0x10000000;
const GAME_MAKER_FLIP = 0x20000000;
const GAME_MAKER_ROTATE = 0x40000000;
const TILED_FLIP_HORIZONTAL = 0x80000000;
const TILED_FLIP_VERTICAL = 0x40000000;
const TILED_FLIP_DIAGONAL = 0x20000000;

const clientRoot = resolve(import.meta.dir, "..");
const mapsRoot = resolve(clientRoot, "src/world/maps");
const referenceRoot = resolve(mapsRoot, "reference");
const referenceAssetsRoot = resolve(
  clientRoot,
  "src/assets/sunnyside/reference/sunnyside-example",
);
const objectsTilesetPath = resolve(mapsRoot, "tilesets/sunnyside-objects.tsj");

export const sourceTilesets = {
  tileset_sunnysideworld: {
    targetSource: "../tilesets/sunnyside-world.tsj",
    targetName: "sunnyside-world",
    tileWidth: 16,
    tileHeight: 16,
  },
  tileset_forest: {
    targetSource: "../tilesets/sunnyside-forest.tsj",
    targetName: "sunnyside-forest",
    tileWidth: 32,
    tileHeight: 32,
  },
} as const;

type SourceTilesetName = keyof typeof sourceTilesets;
type JsonObject = Record<string, unknown>;

type SourceTileLayer = JsonObject & {
  resourceType: "GMRTileLayer";
  name: string;
  depth: number;
  visible: boolean;
  x: number;
  y: number;
  tilesetId: { name: SourceTilesetName };
  tiles: {
    SerialiseWidth: number;
    SerialiseHeight: number;
    TileCompressedData?: number[];
    TileSerialiseData?: number[];
  };
};

type SourceAsset = {
  name: string;
  spriteId: { name: string; path: string };
  headPosition: number;
  rotation: number;
  scaleX: number;
  scaleY: number;
  x: number;
  y: number;
};

type SourceAssetLayer = JsonObject & {
  resourceType: "GMRAssetLayer";
  name: string;
  depth: number;
  visible: boolean;
  assets: SourceAsset[];
};

type SourceRoom = {
  name: string;
  roomSettings: { Width: number; Height: number };
  layers: (SourceTileLayer | SourceAssetLayer | JsonObject)[];
};

type SpriteFrame = { name: string };
type SpriteResource = {
  width: number;
  height: number;
  layers: { name: string }[];
  frames: SpriteFrame[];
  sequence: { xorigin: number; yorigin: number };
};

type ReferenceSprite = {
  key: string;
  spriteName: string;
  frame: number;
  image: string;
  width: number;
  height: number;
  originX: number;
  originY: number;
};

function parseGameMakerJson<T>(input: string): T {
  // GameMaker .yy JSON permits trailing commas. The source files contain no
  // comments, so this deliberately narrow normalization is deterministic.
  return JSON.parse(input.replace(/,\s*([}\]])/g, "$1")) as T;
}

async function readGameMakerJson<T>(path: string): Promise<T> {
  return parseGameMakerJson<T>(await readFile(path, "utf8"));
}

export function decodeGameMakerTileData(
  data: number[],
  expectedCells: number,
): number[] {
  const cells: number[] = [];
  for (let index = 0; index < data.length; ) {
    const value = data[index++];
    if (value === undefined) throw new Error("Truncated GameMaker tile data");
    // Negative values near zero are GameMaker's RLE run counts. Tile values
    // themselves may be negative because their transform/empty bits are set.
    if (value < 0 && value > -1_000_000) {
      const repeated = data[index++];
      if (repeated === undefined)
        throw new Error("Truncated GameMaker tile RLE run");
      cells.push(...Array(-value).fill(repeated));
    } else if (value > 0) {
      const literal = data.slice(index, index + value);
      if (literal.length !== value)
        throw new Error("Truncated GameMaker tile RLE literal");
      cells.push(...literal);
      index += value;
    } else {
      cells.push(value);
    }
  }
  if (cells.length !== expectedCells) {
    throw new Error(
      `GameMaker tile data decoded to ${cells.length} cells; expected ${expectedCells}`,
    );
  }
  return cells;
}

/** Maps a resolved GameMaker tile cell to a Tiled GID, including transforms. */
export function mapGameMakerTile(
  cell: number,
  firstgid: number,
  tilecount: number,
): number {
  if (cell === GAME_MAKER_EMPTY_TILE) return 0;
  const localId = cell & GAME_MAKER_TILE_ID_MASK;
  if (localId < 0 || localId >= tilecount) {
    throw new Error(
      `Unknown GameMaker tile ID ${localId} (tileset contains ${tilecount})`,
    );
  }

  let gid = firstgid + localId;
  const mirror = (cell & GAME_MAKER_MIRROR) !== 0;
  const flip = (cell & GAME_MAKER_FLIP) !== 0;
  const rotate = (cell & GAME_MAKER_ROTATE) !== 0;

  // GameMaker stores mirror, flip, and a 90° clockwise rotation in bits 28-30.
  // Tiled applies diagonal before H/V; diagonal+H is the same clockwise turn.
  if (rotate) gid |= TILED_FLIP_DIAGONAL | TILED_FLIP_HORIZONTAL;
  if (mirror) gid ^= rotate ? TILED_FLIP_VERTICAL : TILED_FLIP_HORIZONTAL;
  if (flip) gid ^= rotate ? TILED_FLIP_HORIZONTAL : TILED_FLIP_VERTICAL;
  return gid >>> 0;
}

function tileLayerData(
  layer: SourceTileLayer,
  roomWidth: number,
  roomHeight: number,
  firstgid: number,
  tilecount: number,
  tileWidth: number,
  tileHeight: number,
): number[] {
  const sourceWidth = layer.tiles.SerialiseWidth;
  const sourceHeight = layer.tiles.SerialiseHeight;
  const cells = layer.tiles.TileCompressedData
    ? decodeGameMakerTileData(
        layer.tiles.TileCompressedData,
        sourceWidth * sourceHeight,
      )
    : layer.tiles.TileSerialiseData;
  if (!cells || cells.length !== sourceWidth * sourceHeight) {
    throw new Error(`Invalid GameMaker tile data for layer '${layer.name}'`);
  }
  const scaleX = tileWidth / 16;
  const scaleY = tileHeight / 16;
  const output = Array(roomWidth * roomHeight).fill(0) as number[];

  for (let y = 0; y < sourceHeight; y += 1) {
    for (let x = 0; x < sourceWidth; x += 1) {
      const destinationX = x * scaleX;
      const destinationY = y * scaleY;
      if (!Number.isInteger(destinationX) || !Number.isInteger(destinationY)) {
        throw new Error(
          `Cannot place ${layer.name}: source grid is not aligned to the 16px Tiled map grid`,
        );
      }
      const cell = cells[y * sourceWidth + x];
      if (cell === undefined)
        throw new Error(`Missing GameMaker cell in '${layer.name}'`);
      output[destinationY * roomWidth + destinationX] = mapGameMakerTile(
        cell,
        firstgid,
        tilecount,
      );
    }
  }
  return output;
}

function sourceProjectFromEnvironment(): string {
  const configured = process.env.SUNNYSIDE_GAMEMAKER_PROJECT;
  if (configured) return resolve(configured);
  return resolve(
    process.env.HOME ?? "~",
    "Downloads/Sunnyside_World_ASSET_PACK_V2.1/Sunnyside_World_Gamemaker",
  );
}

async function loadTargetTileset(name: SourceTilesetName) {
  const target = sourceTilesets[name];
  const path = resolve(referenceRoot, target.targetSource);
  const tileset = JSON.parse(await readFile(path, "utf8")) as JsonObject;
  if (
    tileset.name !== target.targetName ||
    tileset.tilewidth !== target.tileWidth ||
    tileset.tileheight !== target.tileHeight ||
    typeof tileset.tilecount !== "number"
  ) {
    throw new Error(
      `Tiled tileset '${target.targetSource}' does not match the declared ${name} mapping`,
    );
  }
  return { ...target, tilecount: tileset.tilecount as number };
}

async function validateSourceTileset(
  sourceRoot: string,
  name: SourceTilesetName,
  target: Awaited<ReturnType<typeof loadTargetTileset>>,
) {
  const tileset = await readGameMakerJson<JsonObject>(
    resolve(sourceRoot, `tilesets/${name}/${name}.yy`),
  );
  if (
    tileset.tileWidth !== target.tileWidth ||
    tileset.tileHeight !== target.tileHeight ||
    tileset.tile_count !== target.tilecount
  ) {
    throw new Error(
      `GameMaker tileset '${name}' does not match its explicit Tiled mapping`,
    );
  }
}

async function referenceSprite(
  sourceRoot: string,
  spriteName: string,
  frame: number,
): Promise<ReferenceSprite> {
  const spritePath = resolve(
    sourceRoot,
    `sprites/${spriteName}/${spriteName}.yy`,
  );
  if (!existsSync(spritePath))
    throw new Error(`Missing GameMaker sprite resource '${spriteName}'`);
  const sprite = await readGameMakerJson<SpriteResource>(spritePath);
  // Some GameMaker asset graphics retain a negative editor playhead. It is not
  // a sprite frame and is rendered as the first representative frame.
  const actualFrame = Math.max(0, Math.min(frame, sprite.frames.length - 1));
  const sourceFrame = sprite.frames[actualFrame];
  if (!sourceFrame)
    throw new Error(`Sprite '${spriteName}' has no renderable frames`);
  const spriteDirectory = dirname(spritePath);
  const directFrame = resolve(spriteDirectory, `${sourceFrame.name}.png`);
  let sourceImage = directFrame;
  if (!existsSync(sourceImage)) {
    const frameDirectory = resolve(spriteDirectory, "layers", sourceFrame.name);
    const layerNames = new Set(sprite.layers.map((layer) => layer.name));
    const frameImages = (await readdir(frameDirectory)).filter((file) =>
      file.endsWith(".png"),
    );
    // GameMaker writes a composed frame alongside its individual image layers.
    const composed = frameImages.find(
      (file) => !layerNames.has(file.slice(0, -4)),
    );
    sourceImage = resolve(frameDirectory, composed ?? frameImages[0] ?? "");
  }
  if (!existsSync(sourceImage))
    throw new Error(
      `Missing image for GameMaker sprite '${spriteName}' frame ${frame}`,
    );

  const fileName = `${spriteName.replace(/[^a-z0-9_-]/gi, "-")}-frame-${frame}.png`;
  return {
    key: `${spriteName}:${frame}`,
    spriteName,
    frame: actualFrame,
    image: `../../../assets/sunnyside/reference/sunnyside-example/${fileName}`,
    width: sprite.width,
    height: sprite.height,
    originX: sprite.sequence.xorigin,
    originY: sprite.sequence.yorigin,
  };
}

async function writeReferenceObjectTileset(
  sourceRoot: string,
  layers: SourceAssetLayer[],
): Promise<Map<string, { id: number; sprite: ReferenceSprite }>> {
  const requested = new Map<string, ReferenceSprite>();
  for (const layer of layers) {
    for (const asset of layer.assets) {
      const key = `${asset.spriteId.name}:${asset.headPosition}`;
      if (!requested.has(key)) {
        requested.set(
          key,
          await referenceSprite(
            sourceRoot,
            asset.spriteId.name,
            asset.headPosition,
          ),
        );
      }
    }
  }

  await mkdir(referenceAssetsRoot, { recursive: true });
  const sprites = [...requested.values()].sort((left, right) =>
    left.key.localeCompare(right.key),
  );
  const objectTileset = JSON.parse(
    await readFile(objectsTilesetPath, "utf8"),
  ) as JsonObject & { tiles: JsonObject[] };
  const baseTiles = objectTileset.tiles.filter(
    (tile) => (tile.id as number) < 22,
  );
  const ids = new Map<string, { id: number; sprite: ReferenceSprite }>();
  const importedTiles = [] as JsonObject[];

  for (const [offset, sprite] of sprites.entries()) {
    const id = 22 + offset;
    const spritePath = resolve(
      sourceRoot,
      `sprites/${sprite.spriteName}/${sprite.spriteName}.yy`,
    );
    const sourceResource = await readGameMakerJson<SpriteResource>(spritePath);
    const sourceFrame = sourceResource.frames[sprite.frame];
    if (!sourceFrame)
      throw new Error(`Sprite '${sprite.spriteName}' frame was not resolved`);
    const directFrame = resolve(dirname(spritePath), `${sourceFrame.name}.png`);
    let sourceImage = directFrame;
    if (!existsSync(sourceImage)) {
      const frameDirectory = resolve(
        dirname(spritePath),
        "layers",
        sourceFrame.name,
      );
      const layerNames = new Set(
        sourceResource.layers.map((layer) => layer.name),
      );
      const frameImages = (await readdir(frameDirectory)).filter((file) =>
        file.endsWith(".png"),
      );
      sourceImage = resolve(
        frameDirectory,
        frameImages.find((file) => !layerNames.has(file.slice(0, -4))) ??
          frameImages[0] ??
          "",
      );
    }
    const targetFile = sprite.image.split("/").at(-1);
    if (!targetFile)
      throw new Error(`Invalid reference sprite path '${sprite.image}'`);
    await copyFile(sourceImage, resolve(referenceAssetsRoot, targetFile));
    importedTiles.push({
      id,
      image: sprite.image,
      imageheight: sprite.height,
      imagewidth: sprite.width,
      properties: [
        {
          name: "qeReferenceSourceSprite",
          type: "string",
          value: sprite.spriteName,
        },
        { name: "qeReferenceSourceFrame", type: "int", value: sprite.frame },
      ],
    });
    ids.set(sprite.key, { id, sprite });
  }

  objectTileset.tilecount = 22 + importedTiles.length;
  objectTileset.tiles = [...baseTiles, ...importedTiles];
  await writeFile(
    objectsTilesetPath,
    `${JSON.stringify(objectTileset, null, 2)}\n`,
  );
  return ids;
}

function sourceAssetObject(
  asset: SourceAsset,
  source: { id: number; sprite: ReferenceSprite },
  firstgid: number,
  id: number,
) {
  const sprite = source.sprite;
  const width = sprite.width * Math.abs(asset.scaleX);
  const height = sprite.height * Math.abs(asset.scaleY);
  let gid = firstgid + source.id;
  if (asset.scaleX < 0) gid |= TILED_FLIP_HORIZONTAL;
  if (asset.scaleY < 0) gid |= TILED_FLIP_VERTICAL;
  return {
    id,
    gid: gid >>> 0,
    name: asset.spriteId.name,
    type: "reference_sprite",
    x: asset.x - sprite.originX * Math.abs(asset.scaleX),
    // sunnyside-objects.tsj uses Tiled's bottom-left object alignment.
    y: asset.y - sprite.originY * Math.abs(asset.scaleY) + height,
    width,
    height,
    rotation: asset.rotation,
    visible: true,
    properties: [
      { name: "qeReferenceSource", type: "string", value: asset.name },
      { name: "qeReferenceSprite", type: "string", value: asset.spriteId.name },
    ],
  };
}

export async function importSunnysideExample(
  sourceRoot = sourceProjectFromEnvironment(),
) {
  const yyp = resolve(sourceRoot, "Untitled.yyp");
  const roomPath = resolve(sourceRoot, "rooms/Room1/Room1.yy");
  if (!existsSync(yyp))
    throw new Error(`Missing Sunnyside GameMaker project: ${yyp}`);
  if (!existsSync(roomPath))
    throw new Error(`Missing Sunnyside example room: ${roomPath}`);
  const room = await readGameMakerJson<SourceRoom>(roomPath);
  if (room.name !== "Room1")
    throw new Error(`Expected Room1, received '${room.name}'`);

  const targets = {
    tileset_sunnysideworld: await loadTargetTileset("tileset_sunnysideworld"),
    tileset_forest: await loadTargetTileset("tileset_forest"),
  };
  await validateSourceTileset(
    sourceRoot,
    "tileset_sunnysideworld",
    targets.tileset_sunnysideworld,
  );
  await validateSourceTileset(
    sourceRoot,
    "tileset_forest",
    targets.tileset_forest,
  );

  const tileLayers = room.layers.filter(
    (layer): layer is SourceTileLayer => layer.resourceType === "GMRTileLayer",
  );
  const assetLayers = room.layers.filter(
    (layer): layer is SourceAssetLayer =>
      layer.resourceType === "GMRAssetLayer",
  );
  // Room1 is 1366px wide, while its authored 16px layer grid is 86 cells
  // (1376px). Tiled maps are tile-grid sized, so retain every authored cell.
  const mapWidth = Math.max(
    ...tileLayers.map(
      (layer) =>
        layer.tiles.SerialiseWidth *
        (layer.tilesetId.name === "tileset_forest" ? 2 : 1),
    ),
  );
  const mapHeight = Math.max(
    ...tileLayers.map(
      (layer) =>
        layer.tiles.SerialiseHeight *
        (layer.tilesetId.name === "tileset_forest" ? 2 : 1),
    ),
  );
  const objectTiles = await writeReferenceObjectTileset(
    sourceRoot,
    assetLayers,
  );
  const firstgids = {
    tileset_sunnysideworld: 1,
    tileset_forest: 1 + targets.tileset_sunnysideworld.tilecount,
    objects:
      1 +
      targets.tileset_sunnysideworld.tilecount +
      targets.tileset_forest.tilecount,
  };

  let nextObjectId = 1;
  const layers = [...room.layers]
    .sort((left, right) => (right.depth as number) - (left.depth as number))
    .flatMap<JsonObject>((layer, index) => {
      if (layer.resourceType === "GMRTileLayer") {
        const tile = layer as SourceTileLayer;
        const target = targets[tile.tilesetId.name];
        return [
          {
            id: index + 1,
            name: tile.name,
            type: "tilelayer",
            x: 0,
            y: 0,
            width: mapWidth,
            height: mapHeight,
            opacity: 1,
            visible: tile.visible,
            offsetx: tile.x,
            offsety: tile.y,
            data: tileLayerData(
              tile,
              mapWidth,
              mapHeight,
              tile.tilesetId.name === "tileset_sunnysideworld"
                ? firstgids.tileset_sunnysideworld
                : firstgids.tileset_forest,
              target.tilecount,
              target.tileWidth,
              target.tileHeight,
            ),
          },
        ];
      }
      if (layer.resourceType === "GMRAssetLayer") {
        const assetLayer = layer as SourceAssetLayer;
        return [
          {
            id: index + 1,
            name: assetLayer.name,
            type: "objectgroup",
            x: 0,
            y: 0,
            opacity: 1,
            visible: assetLayer.visible,
            draworder: "topdown",
            objects: assetLayer.assets.map((asset) => {
              const source = objectTiles.get(
                `${asset.spriteId.name}:${asset.headPosition}`,
              );
              if (!source)
                throw new Error(
                  `No imported tile for sprite '${asset.spriteId.name}'`,
                );
              return sourceAssetObject(
                asset,
                source,
                firstgids.objects,
                nextObjectId++,
              );
            }),
          },
        ];
      }
      return [];
    });

  layers.push({
    id: room.layers.length + 1,
    name: "Authoring Notes",
    type: "objectgroup",
    x: 0,
    y: 0,
    opacity: 1,
    visible: false,
    draworder: "topdown",
    objects: [
      {
        id: nextObjectId,
        name: "Artist-authored Sunnyside reference",
        type: "reference_note",
        x: 0,
        y: 0,
        width: 0,
        height: 0,
        visible: false,
        properties: [
          {
            name: "note",
            type: "string",
            value:
              "Imported from Sunnyside World v2.1 Room1. This map is a designer reference only; never add runtime markers here.",
          },
        ],
      },
    ],
  });

  const map = {
    compressionlevel: -1,
    height: mapHeight,
    infinite: false,
    layers,
    nextlayerid: room.layers.length + 2,
    nextobjectid: nextObjectId + 1,
    orientation: "orthogonal",
    renderorder: "right-down",
    tiledversion: "1.10.2",
    tileheight: 16,
    tilesets: [
      {
        firstgid: firstgids.tileset_sunnysideworld,
        source: "../tilesets/sunnyside-world.tsj",
      },
      {
        firstgid: firstgids.tileset_forest,
        source: "../tilesets/sunnyside-forest.tsj",
      },
      {
        firstgid: firstgids.objects,
        source: "../tilesets/sunnyside-objects.tsj",
      },
    ],
    tilewidth: 16,
    type: "map",
    version: "1.10",
    width: mapWidth,
    properties: [
      { name: "qeReferenceMap", type: "bool", value: true },
      { name: "qeRuntimeMap", type: "bool", value: false },
      {
        name: "qeReferenceSource",
        type: "string",
        value:
          "Sunnyside World Asset Pack v2.1 / Sunnyside_World_Gamemaker / rooms/Room1/Room1.yy",
      },
      {
        name: "qeReferencePurpose",
        type: "string",
        value:
          "Artist-authored construction reference; not a Quest Engineering runtime map.",
      },
    ],
  };
  const mapping = {
    source: "Sunnyside World Asset Pack v2.1",
    room: "Sunnyside_World_Gamemaker/rooms/Room1/Room1.yy",
    tileEncoding:
      "TileCompressedData format 1: positive literal count, small negative repeat count; tile ID in low 28 bits; GameMaker bits 28/29/30 are mirror/flip/90-degree clockwise rotation; -2147483648 is empty.",
    tilesets: Object.fromEntries(
      Object.entries(targets).map(([name, target]) => [
        name,
        {
          sourceTexture:
            name === "tileset_sunnysideworld"
              ? "spr_tileset_sunnysideworld (1024x1024)"
              : "spr_tileset_sunnysideworld_forest (320x576)",
          tileWidth: target.tileWidth,
          tileHeight: target.tileHeight,
          target: sourceTilesets[name as SourceTilesetName].targetSource,
          localId:
            "row * target columns + column (verified dimensions and tile count)",
        },
      ]),
    ),
    autotiles:
      "Resolved room cells are exported; no GameMaker autotile behavior is emulated.",
  };

  await mkdir(referenceRoot, { recursive: true });
  await writeFile(
    resolve(referenceRoot, "sunnyside-example-world.tmj"),
    `${JSON.stringify(map, null, 2)}\n`,
  );
  await writeFile(
    resolve(referenceRoot, "sunnyside-example-world.mapping.json"),
    `${JSON.stringify(mapping, null, 2)}\n`,
  );
  return map;
}

if (import.meta.main) {
  const map = await importSunnysideExample();
  console.log(
    `Imported Sunnyside Room1 to ${relative(clientRoot, resolve(referenceRoot, "sunnyside-example-world.tmj"))} (${map.width}x${map.height} tiles)`,
  );
}
