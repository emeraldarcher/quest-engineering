import type { HostedAgentStatus } from "../session-host/types.ts";
import type { HumanAttention } from "./types.ts";

export type StructuredAttentionSignal =
  | { state: "requested"; attention: HumanAttention }
  | { state: "resolved" }
  | { state: "unavailable" };

interface AttentionEpisode {
  attention: HumanAttention;
  structuredAttentionId: string | null;
  terminalBlockedSeen: boolean;
}

/**
 * Combines terminal-authoritative blocked state with optional rich harness
 * metadata. Correlation is scoped to one durable lineage and never reads
 * terminal prose.
 */
export class HumanAttentionCorrelator {
  private readonly episodes = new Map<string, AttentionEpisode>();
  private readonly resolvedAttentionIds = new Map<string, string>();

  observe(input: {
    lineageId: string;
    harnessDisplayName: string;
    terminalState: HostedAgentStatus;
    structured: StructuredAttentionSignal;
    persistedAttention: HumanAttention | null;
    observedAt?: string;
  }): HumanAttention | null {
    const blocked = input.terminalState === "blocked";
    const structured =
      input.structured.state === "requested"
        ? input.structured.attention
        : null;
    const current = this.episodes.get(input.lineageId);
    const persisted =
      input.persistedAttention &&
      this.resolvedAttentionIds.get(input.lineageId) !==
        input.persistedAttention.attentionId
        ? input.persistedAttention
        : null;
    const unknownRetainsBlockedEpisode =
      input.terminalState === "unknown" &&
      Boolean(
        current?.terminalBlockedSeen ||
          (persisted && input.structured.state !== "resolved"),
      );

    if (!blocked && !unknownRetainsBlockedEpisode && !structured) {
      const resolved = current?.attention ?? persisted;
      if (resolved)
        this.resolvedAttentionIds.set(input.lineageId, resolved.attentionId);
      this.episodes.delete(input.lineageId);
      return null;
    }

    let base = current?.attention ?? persisted;

    // A new structured request while Herdr is not blocked starts a new episode.
    if (
      structured &&
      current?.structuredAttentionId &&
      current.structuredAttentionId !== structured.attentionId &&
      !blocked
    )
      base = null;

    const attention = structured
      ? {
          attentionId: base?.attentionId ?? structured.attentionId,
          category: structured.category,
          message: structured.message,
          requestedAt: base?.requestedAt ?? structured.requestedAt,
          ...(structured.interaction
            ? { interaction: structured.interaction }
            : base?.interaction
              ? { interaction: base.interaction }
              : {}),
        }
      : (base ?? {
          attentionId: crypto.randomUUID(),
          category: "interactive_prompt" as const,
          message: `${input.harnessDisplayName} is waiting for input`,
          requestedAt: input.observedAt ?? new Date().toISOString(),
        });

    this.episodes.set(input.lineageId, {
      attention,
      structuredAttentionId:
        structured?.attentionId ?? current?.structuredAttentionId ?? null,
      terminalBlockedSeen: blocked || current?.terminalBlockedSeen === true,
    });
    return attention;
  }
}
