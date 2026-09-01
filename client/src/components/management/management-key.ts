import { ApiError } from "../../api/contracts";

export function availableProductKey(
  name: string,
  existingKeys: Iterable<string>,
  fallback: string,
  preferredSuffix = 1,
): string {
  const keys = new Set(existingKeys);
  const base = productKeyBase(name, fallback);
  if (preferredSuffix <= 1 && !keys.has(base)) return base;

  let suffix = Math.max(2, preferredSuffix);
  while (suffix < 10_000) {
    const ending = `-${suffix}`;
    const candidate = `${base.slice(0, 64 - ending.length).replace(/-+$/, "")}${ending}`;
    if (!keys.has(candidate)) return candidate;
    suffix += 1;
  }
  throw new Error("Unable to derive an available Product key.");
}

export function productKeyBase(name: string, fallback: string): string {
  let key = name
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!key || !/^[a-z]/.test(key)) key = `${fallback}${key ? `-${key}` : ""}`;
  return key.slice(0, 64).replace(/-+$/, "") || fallback;
}

export function isProductKeyCollision(cause: unknown): boolean {
  return (
    cause instanceof ApiError &&
    cause.code === "validation_failed" &&
    cause.details.some(
      (detail) => detail.path.length === 1 && detail.path[0] === "key",
    )
  );
}
