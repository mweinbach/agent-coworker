import type { HarnessContextPayload, HarnessContextState } from "../types";

function cloneContext(context: HarnessContextState): HarnessContextState {
  return {
    runId: context.runId,
    taskId: context.taskId,
    objective: context.objective,
    acceptanceCriteria: [...context.acceptanceCriteria],
    constraints: [...context.constraints],
    metadata: context.metadata ? { ...context.metadata } : undefined,
    updatedAt: context.updatedAt,
  };
}

export class HarnessContextStore {
  private readonly bySessionId = new Map<string, HarnessContextState>();

  get(sessionId: string): HarnessContextState | null {
    const found = this.bySessionId.get(sessionId);
    return found ? cloneContext(found) : null;
  }

  set(sessionId: string, context: HarnessContextPayload): HarnessContextState {
    const next: HarnessContextState = {
      runId: context.runId.trim(),
      taskId: context.taskId?.trim() || undefined,
      objective: context.objective.trim(),
      acceptanceCriteria: context.acceptanceCriteria.map((item) => item.trim()).filter(Boolean),
      constraints: context.constraints.map((item) => item.trim()).filter(Boolean),
      metadata: context.metadata ? { ...context.metadata } : undefined,
      updatedAt: new Date().toISOString(),
    };

    this.bySessionId.set(sessionId, next);
    return cloneContext(next);
  }

  clear(sessionId: string) {
    this.bySessionId.delete(sessionId);
  }
}

