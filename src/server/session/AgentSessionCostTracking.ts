import type { SessionCostTracker } from "../../session/costTracker";
import type { SessionContext, SessionRuntimeState } from "./SessionContext";

export type AgentSessionCostTrackingHost = {
  readonly id: string;
  readonly context: SessionContext;
  readonly state: SessionRuntimeState;
  log(line: string): void;
  queuePersistSessionSnapshot(reason: string): void;
  emitError(code: "validation_failed", source: "session", message: string): void;
  getCostTrackerUnsubscribe: () => (() => void) | undefined;
  setCostTrackerUnsubscribe: (value: (() => void) | undefined) => void;
};

export function attachAgentSessionCostTrackerListeners(
  host: AgentSessionCostTrackingHost,
  tracker: SessionCostTracker,
): void {
  host.setCostTrackerUnsubscribe(
    tracker.addListener((event) => {
      if (event.type === "budget_warning") {
        host.context.emit({
          type: "budget_warning",
          sessionId: host.id,
          currentCostUsd: event.currentCostUsd,
          thresholdUsd: event.thresholdUsd,
          message: event.message,
        });
        host.log(`[cost] ${event.message}`);
        return;
      }

      if (event.type === "budget_exceeded") {
        host.context.emit({
          type: "budget_exceeded",
          sessionId: host.id,
          currentCostUsd: event.currentCostUsd,
          thresholdUsd: event.thresholdUsd,
          message: event.message,
        });
        host.log(`[cost] ${event.message}`);
      }
    }),
  );
}

export function emitAgentSessionUsage(host: AgentSessionCostTrackingHost): void {
  const tracker = host.state.costTracker;
  if (!tracker) {
    host.context.emit({
      type: "session_usage",
      sessionId: host.id,
      usage: null,
    });
    return;
  }
  host.context.emit({
    type: "session_usage",
    sessionId: host.id,
    usage: tracker.getCompactSnapshot(),
  });
}

export function setAgentSessionUsageBudget(
  host: AgentSessionCostTrackingHost,
  warnAtUsd?: number | null,
  stopAtUsd?: number | null,
): void {
  const tracker = host.state.costTracker;
  if (!tracker) {
    host.context.emit({
      type: "session_usage",
      sessionId: host.id,
      usage: null,
    });
    return;
  }

  try {
    tracker.updateBudget({ warnAtUsd, stopAtUsd });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    host.emitError("validation_failed", "session", message);
    return;
  }

  host.context.emit({
    type: "session_usage",
    sessionId: host.id,
    usage: tracker.getCompactSnapshot(),
  });
  host.queuePersistSessionSnapshot("session.usage_budget_updated");
}

export function unsubscribeAgentSessionCostTracker(host: AgentSessionCostTrackingHost): void {
  host.getCostTrackerUnsubscribe()?.();
}
