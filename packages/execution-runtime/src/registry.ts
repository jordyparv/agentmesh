import type { AdapterFactory, AgentAdapter } from "@agentmesh/contracts";

/**
 * Adapter plugin registry. New providers register a factory; neither the scheduler nor
 * the memory engine needs to change.
 */
export class AdapterRegistry {
  private factories = new Map<string, AdapterFactory>();

  register(f: AdapterFactory): this {
    if (this.factories.has(f.kind)) throw new Error(`Adapter kind already registered: ${f.kind}`);
    this.factories.set(f.kind, f);
    return this;
  }

  has(kind: string): boolean {
    return this.factories.has(kind);
  }

  kinds(): { kind: string; displayName: string }[] {
    return [...this.factories.values()].map((f) => ({ kind: f.kind, displayName: f.displayName }));
  }

  create(agent: { id: string; kind: string; config: Record<string, unknown> }): AgentAdapter {
    const f = this.factories.get(agent.kind);
    if (!f) throw new Error(`No adapter registered for kind "${agent.kind}"`);
    return f.create(agent);
  }
}
