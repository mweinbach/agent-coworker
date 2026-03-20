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

function normalizeMetadata(
  metadata: HarnessContextPayload["metadata"],
): HarnessContextState["metadata"] {
  if (!metadata) return undefined;

  const entries = Object.entries(metadata)
    .map(([key, value]) => [key.trim(), value.trim()] as const)
    .filter(([key, value]) => key.length > 0 && value.length > 0);

  if (entries.length === 0) return undefined;
  return Object.fromEntries(entries);
}

export function normalizeHarnessContextPayload(
  context: HarnessContextPayload,
  updatedAt = new Date().toISOString(),
): HarnessContextState {
  return {
    runId: context.runId.trim(),
    taskId: context.taskId?.trim() || undefined,
    objective: context.objective.trim(),
    acceptanceCriteria: context.acceptanceCriteria.map((item) => item.trim()).filter(Boolean),
    constraints: context.constraints.map((item) => item.trim()).filter(Boolean),
    metadata: normalizeMetadata(context.metadata),
    updatedAt,
  };
}

export class HarnessContextStore {
  private readonly bySessionId = new Map<string, HarnessContextState>();

  get(sessionId: string): HarnessContextState | null {
    const found = this.bySessionId.get(sessionId);
    return found ? cloneContext(found) : null;
  }

  set(sessionId: string, context: HarnessContextPayload): HarnessContextState {
    const next = normalizeHarnessContextPayload(context);

    this.bySessionId.set(sessionId, next);
    return cloneContext(next);
  }

  clear(sessionId: string) {
    this.bySessionId.delete(sessionId);
  }
}

