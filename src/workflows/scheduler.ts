/**
 * FIFO semaphore bounding how many child agents a workflow has in flight.
 *
 * `AgentControl` enforces `MAX_ACTIVE_CHILDREN_PER_PARENT = 16`, counting only
 * children in `running` or `pending_init` (`AgentControl.ts:328-341`) — a finished
 * but still-open child does not occupy a slot. So an arbitrarily large workflow
 * works provided the host throttles itself.
 *
 * The default is deliberately BELOW the hard cap: the parent turn can call
 * `spawnAgent` directly while a workflow is running, and those spawns compete for
 * the same 16 slots. Leaving headroom means a concurrent parent spawn fails with
 * neither party having to reason about the other.
 */
export const WORKFLOW_MAX_INFLIGHT_AGENTS = 12;

/**
 * Absolute ceiling, matching AgentControl's MAX_ACTIVE_CHILDREN_PER_PARENT.
 * Configuring above it cannot help — spawn() rejects past that point.
 */
export const WORKFLOW_MAX_CONFIGURABLE_AGENTS = 16;

/**
 * Resolve the in-flight cap for a run.
 *
 * The default suits hosted APIs. Local inference engines (LM Studio and
 * friends) have much smaller request pools and per-model context budgets, where
 * a 12-wide fan-out fails outright — "context size has been exceeded", or
 * "worker local total request limit reached" — rather than queueing. Those
 * setups need a lower value, so this is user-configurable.
 */
export function resolveWorkflowConcurrency(configured: number | undefined): number {
  if (typeof configured !== "number" || !Number.isFinite(configured)) {
    return WORKFLOW_MAX_INFLIGHT_AGENTS;
  }
  const floored = Math.floor(configured);
  if (floored < 1) return 1;
  return Math.min(floored, WORKFLOW_MAX_CONFIGURABLE_AGENTS);
}

export class AgentScheduler {
  private active = 0;
  private readonly queue: Array<() => void> = [];

  constructor(private readonly limit: number = WORKFLOW_MAX_INFLIGHT_AGENTS) {
    if (limit < 1) throw new Error("AgentScheduler limit must be at least 1");
  }

  get inFlight(): number {
    return this.active;
  }

  get queued(): number {
    return this.queue.length;
  }

  async run<T>(task: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await task();
    } finally {
      this.release();
    }
  }

  private acquire(): Promise<void> {
    if (this.active < this.limit) {
      this.active += 1;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      this.queue.push(() => {
        this.active += 1;
        resolve();
      });
    });
  }

  private release(): void {
    this.active -= 1;
    const next = this.queue.shift();
    if (next) next();
  }
}
