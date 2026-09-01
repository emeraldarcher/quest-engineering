import { describe, expect, test } from "vitest";
import {
  allRuntimeAssets,
  hairStyles,
  SunnysideAssets,
} from "../src/world/runtime/sunnyside-assets";

describe("Sunnyside Checkpoint A manifest", () => {
  test("records provenance and valid runtime framing for every copied asset", () => {
    const assets = allRuntimeAssets();
    expect(assets.length).toBeGreaterThan(35);
    for (const asset of assets) {
      expect(asset.archive).toBe("Sunnyside World Asset Pack 2.1");
      expect(asset.sourceFile).toContain("Sunnyside_World_ASSET_PACK_V2.1");
      expect(asset.url).toMatch(/\.png(?:\?|$)/);
      expect(asset.anchor).toHaveLength(2);
      if (asset.frames) {
        expect(asset.frames).toBeGreaterThan(1);
        expect(asset.rect?.width).toBeGreaterThan(0);
        expect(asset.frameDurationMs).toBeGreaterThan(0);
      }
    }
  });

  test("provides deterministic compositing layers for every spike action", () => {
    for (const action of Object.values(SunnysideAssets.characters)) {
      expect(action.base.rect).toEqual({ x: 0, y: 0, width: 96, height: 64 });
      expect(Object.keys(action.hair)).toEqual([...hairStyles]);
      expect(action.frames).toBeGreaterThanOrEqual(8);
    }
  });
});
