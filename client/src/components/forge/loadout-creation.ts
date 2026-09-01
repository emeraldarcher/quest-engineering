import type { LoadoutInput } from "../../api/client";
import type { Loadout } from "../../api/contracts";
import {
  availableProductKey,
  isProductKeyCollision,
} from "../management/management-key";

export interface LoadoutCreateOperations {
  createLoadout(input: Required<LoadoutInput>): Promise<Loadout>;
}

export async function createLoadoutWithGeneratedKey(
  operations: LoadoutCreateOperations,
  input: Omit<Required<LoadoutInput>, "key">,
  existingKeys: Iterable<string>,
): Promise<Loadout> {
  const keys = new Set(existingKeys);
  let suffix = 1;

  while (suffix < 100) {
    const key = availableProductKey(input.name, keys, "loadout", suffix);
    try {
      return await operations.createLoadout({ ...input, key });
    } catch (cause) {
      if (!isProductKeyCollision(cause)) throw cause;
      keys.add(key);
      suffix = suffix <= 1 ? 2 : suffix + 1;
    }
  }

  throw new Error("Unable to create an available Loadout key.");
}
