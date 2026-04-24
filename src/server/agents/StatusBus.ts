import type { PersistentAgentSummary } from "../../shared/agents";
import type { AgentWaitMode, AgentWaitResult } from "./types";

type StatusListener = (agent: PersistentAgentSummary) => void;

function isTerminal(agent: PersistentAgentSummary): boolean {
  return (
    agent.executionState === "completed" ||
    agent.executionState === "errored" ||
    agent.executionState === "closed"
  );
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

  async wait(
    agentIds: string[],
    timeoutMs = 30_000,
    mode: AgentWaitMode = "any",
  ): Promise<AgentWaitResult> {
    const dedupedIds = [...new Set(agentIds)];
    if (dedupedIds.length === 0) {
      return { timedOut: true, mode, agents: [], readyAgentIds: [] };
    }

    const getSnapshot = (): Omit<AgentWaitResult, "timedOut"> => {
      const agents = dedupedIds
        .map((agentId) => this.latest.get(agentId))
        .filter((agent): agent is PersistentAgentSummary => !!agent);
      const readyAgentIds = dedupedIds.filter((agentId) => {
        const agent = this.latest.get(agentId);
        return !!agent && isTerminal(agent);
      });
      return { mode, agents, readyAgentIds };
    };

    const isSatisfied = (readyAgentIds: string[]) =>
      mode === "all" ? readyAgentIds.length === dedupedIds.length : readyAgentIds.length > 0;

    const immediate = getSnapshot();
    if (isSatisfied(immediate.readyAgentIds)) {
      return { timedOut: false, ...immediate };
    }

    const resolvedTimeoutMs = Number.isFinite(timeoutMs)
      ? Math.max(0, Math.floor(timeoutMs))
      : 30_000;
    if (resolvedTimeoutMs === 0) {
      return { timedOut: true, ...getSnapshot() };
    }

    return await new Promise((resolve) => {
      const onStatus = () => {
        const snapshot = getSnapshot();
        if (!isSatisfied(snapshot.readyAgentIds)) {
          return;
        }
        cleanup();
        resolve({ timedOut: false, ...snapshot });
      };

      const cleanup = () => {
        clearTimeout(timer);
        unsubscribe();
      };

      const unsubscribe = this.subscribe(onStatus);
      const timer = setTimeout(() => {
        cleanup();
        resolve({ timedOut: true, ...getSnapshot() });
      }, resolvedTimeoutMs);
    });
  }
}
