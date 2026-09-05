#!/usr/bin/env bun
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(
  import.meta.dir,
  "../src/assets/sunnyside/generated/human-v1.0",
);
const metadataPath = resolve(root, "human-v1.0.runtime.json");

interface Runtime {
  formatVersion: number;
  sourceProvenance: string;
  canvas: { width: number; height: number; grid: number };
  footAnchor: { x: number; y: number; basis: string };
  sheet: { file: string; width: number; height: number; columns: number };
  frames: Array<{
    index: number;
    rect: { x: number; y: number; w: number; h: number };
    durationMs: number;
  }>;
  animations: Array<{
    id: string;
    tag: string;
    playback: string;
    loop: boolean;
    frames: number[];
  }>;
  directionalFamilies: Record<
    string,
    Record<string, { animationId: string | null; mirrorX: boolean }>
  >;
  layers: Array<{
    name: string;
    file: string;
    role: string | null;
    frameIndices: number[];
  }>;
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function pngDimensions(
  path: string,
): Promise<{ width: number; height: number }> {
  const bytes = await readFile(path);
  assert(bytes.subarray(1, 4).toString() === "PNG", `${path} is not a PNG`);
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

const data = JSON.parse(await readFile(metadataPath, "utf8")) as Runtime;
assert(data.formatVersion === 3, "Human v1 runtime format must be version 3");
assert(data.frames.length > 0, "Human v1 export has no frames");
assert(data.animations.length > 0, "Human v1 export has no tags");
assert(data.layers.length > 0, "Human v1 export has no layers");
assert(data.canvas.grid === 16, "Human v1 source grid must remain 16px");
assert(
  data.footAnchor.x === 48 && data.footAnchor.y === 39,
  "Human v1 foot anchor must remain at the calibrated base-layer baseline",
);
assert(
  data.footAnchor.x >= 0 &&
    data.footAnchor.x <= data.canvas.width &&
    data.footAnchor.y >= 0 &&
    data.footAnchor.y <= data.canvas.height,
  "Human v1 foot anchor lies outside the source canvas",
);
assert(
  !/Downloads|Library\/Application Support\/Steam/i.test(JSON.stringify(data)),
  "Generated metadata contains a machine-local Downloads or Steam path",
);

const runtimeFiles = [
  data.sheet.file,
  ...data.layers.map((layer) => layer.file),
];
for (const file of runtimeFiles) {
  assert(
    !file.startsWith("/") && !file.includes(".."),
    `Unsafe generated path: ${file}`,
  );
  assert(
    !file.endsWith(".aseprite"),
    `Runtime asset points to Aseprite source: ${file}`,
  );
  const dimensions = await pngDimensions(resolve(root, file));
  assert(
    dimensions.width === data.sheet.width &&
      dimensions.height === data.sheet.height,
    `${file} dimensions do not match runtime sheet metadata`,
  );
  assert(
    dimensions.width <= 4096 && dimensions.height <= 4096,
    `${file} exceeds the conservative Pixi/WebGL texture size`,
  );
}

for (const [index, frame] of data.frames.entries()) {
  assert(frame.index === index, `Frame index ${index} is unstable`);
  assert(frame.durationMs > 0, `Frame ${index} has invalid duration`);
  assert(
    frame.rect.w === data.canvas.width && frame.rect.h === data.canvas.height,
    `Frame ${index} dimensions differ from source canvas`,
  );
  assert(
    frame.rect.x >= 0 &&
      frame.rect.y >= 0 &&
      frame.rect.x + frame.rect.w <= data.sheet.width &&
      frame.rect.y + frame.rect.h <= data.sheet.height,
    `Frame ${index} lies outside the generated sheet`,
  );
}
const animationIds = new Set(data.animations.map((animation) => animation.id));
assert(
  animationIds.size === data.animations.length,
  "Animation IDs are not unique",
);
for (const animation of data.animations) {
  assert(
    animation.frames.length > 0,
    `Animation ${animation.id} has no frames`,
  );
  assert(
    animation.playback.length > 0,
    `Animation ${animation.id} has no playback`,
  );
  for (const frame of animation.frames)
    assert(
      data.frames[frame],
      `Animation ${animation.id} references missing frame ${frame}`,
    );
}
for (const family of ["idle", "walk", "run"]) {
  const directions = data.directionalFamilies[family];
  assert(directions, `Missing directional family: ${family}`);
  for (const direction of [
    "south",
    "southeast",
    "southwest",
    "northeast",
    "northwest",
    "north",
  ]) {
    const visual = directions[direction];
    assert(visual?.animationId, `Missing ${family} direction: ${direction}`);
    assert(
      animationIds.has(visual.animationId),
      `${family}/${direction} references a missing animation`,
    );
  }
  const south = directions.south;
  const southeast = directions.southeast;
  const southwest = directions.southwest;
  const northeast = directions.northeast;
  const northwest = directions.northwest;
  const north = directions.north;
  assert(
    southwest?.mirrorX && northwest?.mirrorX,
    `${family} western diagonals must use deliberate source mirroring`,
  );
  assert(
    south &&
      southeast &&
      northeast &&
      north &&
      !south.mirrorX &&
      !southeast.mirrorX &&
      !northeast.mirrorX &&
      !north.mirrorX,
    `${family} authored directions must not be mirrored`,
  );
}
for (const layer of data.layers)
  for (const frame of layer.frameIndices)
    assert(
      data.frames[frame],
      `${layer.name} references missing frame ${frame}`,
    );
for (const role of [
  "base",
  "tools-rear",
  "tools-front",
  "hair-bowl",
  "hair-short",
  "hair-mop",
  "hair-spikey",
  "hair-curly",
  "hair-long",
])
  assert(
    data.layers.filter((layer) => layer.role === role).length === 1,
    `Expected exactly one Human v1 layer role: ${role}`,
  );

console.log(
  `Human v1 valid · ${data.frames.length} frames · ${data.animations.length} tags · ${data.layers.length} layers · ${data.sheet.width}x${data.sheet.height} sheets`,
);
