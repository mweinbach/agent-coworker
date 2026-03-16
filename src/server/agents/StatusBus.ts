import type { PersistentAgentSummary } from "../../shared/agents";

type StatusListener = (agent: PersistentAgentSummary) => void;

function isTerminal(agent: PersistentAgentSummary): boolean {
  return agent.executionState === "completed"
    || agent.executionState === "errored"
    || agent.executionState === "closed";
}

export class StatusBus {
  private readonly latest = new Map<string, PersistentAgentSummary>();
  private readonly listeners = new Set<StatusListener>();

  publish(agent: PersistentAgentSummary): void {
    this.latest.set(agent.agentId, agent);
    for (const listener of this.listeners) {
      listener(agent);
    }
  }

  get(agentId: string): PersistentAgentSummary | null {
    return this.latest.get(agentId) ?? null;
  }

  subscribe(listener: StatusListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  async wait(agentIds: string[], timeoutMs = 30_000): Promise<{ timedOut: boolean; agents: PersistentAgentSummary[] }> {
    const dedupedIds = [...new Set(agentIds)];
    if (dedupedIds.length === 0) {
      return { timedOut: true, agents: [] };
    }

    const findTerminal = (): PersistentAgentSummary[] =>
      dedupedIds
        .map((agentId) => this.latest.get(agentId))
        .filter((agent): agent is PersistentAgentSummary => !!agent && isTerminal(agent));

    const immediate = findTerminal();
    if (immediate.length > 0) {
      return { timedOut: false, agents: immediate };
    }

    const clampedTimeoutMs = Math.max(10_000, Math.floor(timeoutMs));
    return await new Promise((resolve) => {
      const onStatus = () => {
        const terminal = findTerminal();
        if (terminal.length === 0) {
          return;
        }
        cleanup();
        resolve({ timedOut: false, agents: terminal });
      };

      const cleanup = () => {
        clearTimeout(timer);
        unsubscribe();
      };

      const unsubscribe = this.subscribe(onStatus);
      const timer = setTimeout(() => {
        cleanup();
        resolve({ timedOut: true, agents: [] });
      }, clampedTimeoutMs);
    });
  }
}
