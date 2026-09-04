import type { TownRect } from "../authored/map-schema";

export const REGION_CULL_MARGIN = 128;

export function rectanglesOverlap(a: TownRect, b: TownRect): boolean {
  return !(
    a.x + a.width < b.x ||
    b.x + b.width < a.x ||
    a.y + a.height < b.y ||
    b.y + b.height < a.y
  );
}

export function regionIsVisible(
  region: TownRect,
  viewport: TownRect,
  margin = REGION_CULL_MARGIN,
): boolean {
  return rectanglesOverlap(region, {
    x: viewport.x - margin,
    y: viewport.y - margin,
    width: viewport.width + margin * 2,
    height: viewport.height + margin * 2,
  });
}
