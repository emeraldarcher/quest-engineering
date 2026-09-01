import type { ApiClient, SquadInput } from "../../api/client";
import type { Squad } from "../../api/contracts";
import {
  availableProductKey,
  isProductKeyCollision,
} from "../management/management-key";

export async function createSquadWithGeneratedKey(
  api: Pick<ApiClient, "createSquad">,
  input: Omit<Required<SquadInput>, "key">,
  existingKeys: Iterable<string>,
): Promise<Squad> {
  const reserved = new Set(existingKeys);
  let suffix = 1;

  while (suffix < 10_000) {
    const key = availableProductKey(input.name, reserved, "squad", suffix);
    try {
      return await api.createSquad({ ...input, key });
    } catch (cause) {
      if (!isProductKeyCollision(cause)) throw cause;
      reserved.add(key);
      suffix += 1;
    }
  }

  throw new Error("Unable to derive an available Squad key.");
}
