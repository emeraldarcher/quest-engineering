import { expect, test } from "bun:test";
import {
  type MiniMedievalFrame,
  miniMedievalFrames,
} from "./mini-medieval-assets";

const dimensions = {
  overworld: [264, 944],
  structures: [544, 1032],
  walls: [472, 744],
  units: [1080, 664],
  animals: [464, 832],
  misc: [496, 408],
  items: [248, 416],
  interface: [288, 184],
  furniture: [488, 1320],
  interiorItems: [232, 168],
  interiorMisc: [192, 464],
  interiorUnits: [184, 88],
  uiFrames: [1016, 528],
  uiIcons: [400, 384],
  uiBanners: [896, 632],
} as const;

function frames(value: unknown): MiniMedievalFrame[] {
  if (Array.isArray(value)) return value as MiniMedievalFrame[];
  if (value && typeof value === "object" && "sheet" in value)
    return [value as MiniMedievalFrame];
  return Object.values(value as Record<string, unknown>).flatMap(frames);
}

test("all semantic Mini Medieval frames are 8px aligned and within original source sheets", () => {
  for (const frame of frames(miniMedievalFrames)) {
    const [width, height] = dimensions[frame.sheet];
    expect(frame.x % 8).toBe(0);
    expect(frame.y % 8).toBe(0);
    expect(frame.width % 8).toBe(0);
    expect(frame.height % 8).toBe(0);
    expect(frame.x + frame.width).toBeLessThanOrEqual(width);
    expect(frame.y + frame.height).toBeLessThanOrEqual(height);
    expect(frame.source).toContain("Mini Medieval");
  }
});
