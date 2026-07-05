import { formatCost, formatTokenCount } from "../../../../../src/session/pricing";
import type {
  FeedItem,
  SessionUsageSnapshot,
  ThreadAgentSummary,
  ThreadPendingSteer,
  ThreadPendingTurnStart,
  ThreadStatus,
  TurnUsageSnapshot,
} from "../../app/types";

export function reasoningLabelForMode(mode: "reasoning" | "summary"): string {
  return mode === "summary" ? "Summary" : "Reasoning";
}

export function reasoningPreviewText(text: string, maxLines = 3): string {
  const lines = text.split("\n");
  if (lines.length <= maxLines) return text;
  return `${lines.slice(0, maxLines).join("\n")}...`;
}

export function shouldToggleReasoningExpanded(key: string): boolean {
  return key === "Enter" || key === " " || key === "Spacebar";
}

function isActiveChildAgent(agent: ThreadAgentSummary): boolean {
  if (agent.lifecycleState === "closed") return false;
  return (
    agent.busy || agent.executionState === "pending_init" || agent.executionState === "running"
  );
}

export function countActiveChildAgents(agents: ThreadAgentSummary[]): number {
  return agents.filter(isActiveChildAgent).length;
}

export function filterFeedForDeveloperMode(feed: FeedItem[], developerMode: boolean): FeedItem[] {
  return developerMode
    ? feed
    : feed.filter((item) => item.kind !== "system" && item.kind !== "log");
}

export function formatSessionUsageHeadline(
  sessionUsage: SessionUsageSnapshot | null,
  lastTurnUsage: TurnUsageSnapshot | null,
  opts?: { showTokens?: boolean },
): string | null {
  const parts: string[] = [];
  const showTokens = opts?.showTokens === true;

  if (sessionUsage) {
    if (showTokens) {
      parts.push(`${sessionUsage.totalTurns} turn${sessionUsage.totalTurns === 1 ? "" : "s"}`);
      parts.push(`${formatTokenCount(sessionUsage.totalTokens)} tokens`);
    }
    if (sessionUsage.costTrackingAvailable && sessionUsage.estimatedTotalCostUsd !== null) {
      parts.push(`est. ${formatCost(sessionUsage.estimatedTotalCostUsd)}`);
    } else if (sessionUsage.totalTurns > 0) {
      parts.push("est. cost unavailable");
    }
  }

  if (showTokens && lastTurnUsage) {
    parts.push(`last ${formatTokenCount(lastTurnUsage.usage.totalTokens)} tokens`);
  }

  return parts.length > 0 ? parts.join(" • ") : null;
}

export function formatSessionBudgetLine(sessionUsage: SessionUsageSnapshot | null): string | null {
  const budget = sessionUsage?.budgetStatus;
  if (!budget?.configured) return null;

  if (budget.stopTriggered && budget.stopAtUsd !== null) {
    return `Hard cap exceeded at ${formatCost(budget.stopAtUsd)}`;
  }
  if (budget.warningTriggered && budget.warnAtUsd !== null) {
    return `Warning threshold reached at ${formatCost(budget.warnAtUsd)}`;
  }

  const parts: string[] = [];
  if (budget.warnAtUsd !== null) parts.push(`Warn ${formatCost(budget.warnAtUsd)}`);
  if (budget.stopAtUsd !== null) parts.push(`Cap ${formatCost(budget.stopAtUsd)}`);
  return parts.length > 0 ? `Budget ${parts.join(" • ")}` : null;
}

export function sessionUsageTone(sessionUsage: SessionUsageSnapshot | null): string {
  const budget = sessionUsage?.budgetStatus;
  if (budget?.stopTriggered) {
    return "border-destructive/40 bg-destructive/10 text-destructive";
  }
  if (budget?.warningTriggered) {
    return "border-warning/40 bg-warning/10 text-warning";
  }
  return "border-border/50 bg-background/80 text-muted-foreground";
}

export function canClearSessionHardCap(opts: {
  sessionUsage: SessionUsageSnapshot | null;
  transcriptOnly: boolean;
  connected: boolean;
  sessionId: string | null;
  threadStatus: ThreadStatus;
}): boolean {
  return (
    opts.sessionUsage?.budgetStatus.stopTriggered === true &&
    !opts.transcriptOnly &&
    opts.connected &&
    Boolean(opts.sessionId) &&
    opts.threadStatus === "active"
  );
}

export function getComposerSubmitState(opts: {
  busy: boolean;
  hasPromptModal: boolean;
  composerText: string;
  hasPendingAttachments: boolean;
  pendingAttachmentSignature: string;
  pendingTurnStart: ThreadPendingTurnStart | null;
  pendingSteer: ThreadPendingSteer | null;
  sessionId: string | null;
  threadStatus: ThreadStatus;
}): {
  status: "ready" | "pending" | "streaming";
  disabled: boolean;
  mode: "send" | "steer-ready" | "steer-pending";
} {
  const composerText = opts.composerText.trim();
  const hasComposerText = composerText.length > 0;
  const hasPendingInput = hasComposerText || opts.hasPendingAttachments;
  const startPending = opts.pendingTurnStart?.status === "sending";
  const steerPending =
    opts.busy &&
    hasPendingInput &&
    opts.pendingSteer?.status === "sending" &&
    opts.pendingSteer.text.trim() === composerText;
  const samePendingAttachments =
    (opts.pendingSteer?.attachmentSignature ?? "") === opts.pendingAttachmentSignature;

  if (opts.busy && !hasPendingInput) {
    return {
      status: "streaming",
      disabled: opts.hasPromptModal || !opts.sessionId || opts.threadStatus !== "active",
      mode: "send",
    };
  }

  if (startPending) {
    return {
      status: "pending",
      disabled: true,
      mode: "send",
    };
  }

  return {
    status: "ready",
    mode:
      opts.busy && steerPending && samePendingAttachments
        ? "steer-pending"
        : opts.busy
          ? "steer-ready"
          : "send",
    disabled:
      opts.hasPromptModal ||
      !hasPendingInput ||
      (steerPending && samePendingAttachments) ||
      (opts.busy && (!opts.sessionId || opts.threadStatus !== "active")),
  };
}

export function composerBusyHint(
  submitState: ReturnType<typeof getComposerSubmitState>,
): string | null {
  if (submitState.status === "pending") {
    return "Sending message. Waiting for the run to start.";
  }
  if (submitState.status === "streaming") {
    return "Type to steer, or use stop to cancel.";
  }
  if (submitState.mode === "steer-pending") {
    return "Steer sent. Waiting for the running turn to accept it.";
  }
  if (submitState.mode === "steer-ready") {
    return "Steer ready. Press Enter to inject it into the current run.";
  }
  return null;
}

export function resolveComposerBusyPolicy(busy: boolean): "reject" | "steer" {
  return busy ? "steer" : "reject";
}

/**
 * Precedence for the reasoning-effort selector value:
 *   pending composer selection → runtime effort (what the session is actually
 *   using) → configured session/workspace effort → model default.
 *
 * Runtime is authoritative over the config because the session may be running
 * an effort that differs from a stale config value. The config-ack handler
 * keeps the runtime effort in sync when a change is confirmed, so this order
 * does not snap the selector back to a pre-change value.
 */
export function resolveCurrentReasoningEffort<T>(opts: {
  composerEffort: T | null | undefined;
  runtimeEffort: T | null | undefined;
  configuredEffort: T | null | undefined;
  defaultEffort: T;
}): T {
  return opts.composerEffort ?? opts.runtimeEffort ?? opts.configuredEffort ?? opts.defaultEffort;
}
