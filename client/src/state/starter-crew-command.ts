import type { ApiClient } from "../api/client";
import type { StarterCrewResult, StarterCrewStatus } from "../api/contracts";

export type StarterCrewCommandOutcome =
  | { state: "ready"; result: StarterCrewResult | null; recovered: boolean }
  | { state: "failed"; cause: unknown; status: StarterCrewStatus | null };

export async function executeStarterCrewCommand(
  api: Pick<ApiClient, "createStarterCrew" | "getStarterCrewStatus">,
  workspaceId: string,
): Promise<StarterCrewCommandOutcome> {
  try {
    const result = await api.createStarterCrew(workspaceId);
    return { state: "ready", result, recovered: false };
  } catch (cause) {
    try {
      const status = await api.getStarterCrewStatus();
      if (status.state === "complete")
        return { state: "ready", result: null, recovered: true };
      return { state: "failed", cause, status };
    } catch {
      return { state: "failed", cause, status: null };
    }
  }
}
