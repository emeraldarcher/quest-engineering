import type { ClassInput } from "../../api/client";
import type { ClassDefinition } from "../../api/contracts";
import {
  availableProductKey,
  isProductKeyCollision,
} from "../management/management-key";

export interface ClassCreateOperations {
  createClass(input: Required<ClassInput>): Promise<ClassDefinition>;
}

export async function createClassWithGeneratedKey(
  operations: ClassCreateOperations,
  input: Omit<Required<ClassInput>, "key">,
  existingKeys: Iterable<string>,
): Promise<ClassDefinition> {
  const keys = new Set(existingKeys);
  let suffix = 1;

  while (suffix < 100) {
    const key = availableProductKey(input.name, keys, "class", suffix);
    try {
      return await operations.createClass({ ...input, key });
    } catch (cause) {
      if (!isProductKeyCollision(cause)) throw cause;
      keys.add(key);
      suffix = suffix <= 1 ? 2 : suffix + 1;
    }
  }

  throw new Error("Unable to create an available Class key.");
}
