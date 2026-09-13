import type { AgentHarness, HarnessDiscovery, HarnessKind } from "./types.ts";

/** Static built-in adapter registry; adding a harness does not alter dispatch semantics. */
export class HarnessRegistry {
  private readonly adapters = new Map<string, AgentHarness>();

  constructor(adapters: AgentHarness[] = []) {
    for (const adapter of adapters) this.register(adapter);
  }

  register(adapter: AgentHarness): void {
    if (this.adapters.has(adapter.kind))
      throw new Error(`Harness adapter ${adapter.kind} is already registered.`);
    this.adapters.set(adapter.kind, adapter);
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
