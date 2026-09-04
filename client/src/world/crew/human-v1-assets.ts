import { HUMAN_HAIR_ROLES, HumanV1 } from "./human-v1-runtime";

const generatedModules = import.meta.glob<string>(
  "../../assets/sunnyside/generated/human-v1.0/runtime-layers/*.png",
  { eager: true, query: "?url", import: "default" },
);

export function humanV1AssetUrl(file: string): string {
  const url =
    generatedModules[`../../assets/sunnyside/generated/human-v1.0/${file}`];
  if (!url) throw new Error(`Missing generated Human v1 asset: ${file}`);
  return url;
}

export function humanV1LayerUrl(role: string): string {
  const layer = HumanV1.layers.find((value) => value.role === role);
  if (!layer)
    throw new Error(`Human v1 compositing role is unavailable: ${role}`);
  return humanV1AssetUrl(layer.file);
}

export function allHumanV1RuntimeUrls(): string[] {
  const roles = ["tools-rear", "base", ...HUMAN_HAIR_ROLES, "tools-front"];
  return [...new Set(roles.map(humanV1LayerUrl))];
}
