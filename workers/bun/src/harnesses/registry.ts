import type {
  AgentHarness,
  HarnessDiscovery,
  HarnessKind,
  HarnessOperationPhase,
} from "./types.ts";
import { operationalHarnessError } from "./types.ts";

/** Static built-in adapter registry; adding a harness does not alter dispatch semantics. */
export class HarnessRegistry {
  private readonly adapters = new Map<string, AgentHarness>();

  constructor(adapters: AgentHarness[] = []) {
    for (const adapter of adapters) this.register(adapter);
  }

  register(adapter: AgentHarness): void {
    if (this.adapters.has(adapter.kind))
      throw new Error(`Harness adapter ${adapter.kind} is already registered.`);
    this.adapters.set(adapter.kind, withOperationalBoundary(adapter));
  }

  get(kind: HarnessKind): AgentHarness {
    const adapter = this.adapters.get(kind);
    if (!adapter) throw new Error(`Harness adapter ${kind} is not registered.`);
    return adapter;
  }

  list(): AgentHarness[] {
    return [...this.adapters.values()];
  }

  async discover(): Promise<HarnessDiscovery[]> {
    return Promise.all(this.list().map((adapter) => adapter.discover()));
  }

  disconnect(): void {
    for (const adapter of this.adapters.values()) adapter.disconnect();
  }
}

const operationPhases: Partial<Record<string, HarnessOperationPhase>> = {
  discover: "discovery",
  start: "prepare",
  continue: "prepare",
  provePreparedProcessAdoption: "recover",
  ready: "readiness",
  observePreAuthorizationActivity: "observe",
  sendInputAndCollect: "execute",
  retire: "retire",
  interrupt: "interrupt",
  proveInactiveForFreshRecovery: "recover",
  inspect: "observe",
  close: "retire",
  recover: "recover",
  waitAndCollect: "observe",
  clearActiveMetadata: "retire",
  discoverAdoptionCandidates: "recover",
  attachment: "observe",
  disconnect: "retire",
};

function withOperationalBoundary(adapter: AgentHarness): AgentHarness {
  return new Proxy(adapter, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (typeof property !== "string" || typeof value !== "function")
        return value;
      const phase = operationPhases[property];
      if (!phase) return value.bind(target);
      return (...args: unknown[]) => {
        try {
          const result = Reflect.apply(value, target, args) as unknown;
          if (
            result &&
            (typeof result === "object" || typeof result === "function") &&
            "then" in result
          )
            return Promise.resolve(result).catch((error) => {
              throw operationalHarnessError(error, phase);
            });
          return result;
        } catch (error) {
          throw operationalHarnessError(error, phase);
        }
      };
    },
  });
}
