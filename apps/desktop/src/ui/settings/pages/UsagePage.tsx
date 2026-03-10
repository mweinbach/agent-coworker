import { useState } from "react";

import { AlertTriangleIcon, RotateCcwIcon } from "lucide-react";

import { useAppStore } from "../../../app/store";
import type { ThreadRecord, ThreadRuntime } from "../../../app/types";
import { Badge } from "../../../components/ui/badge";
import { Button } from "../../../components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "../../../components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "../../../components/ui/dialog";
import { formatCost, formatTokenCount } from "../../../../../../src/session/pricing";

type UsagePageProps = {
  thread?: ThreadRecord | null;
  runtime?: ThreadRuntime | null;
  estimateNoticeOpen?: boolean;
  onClearHardCap?: () => void | Promise<void>;
};

function formatTimestamp(value: string | null | undefined): string {
  if (!value) return "Unavailable";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return parsed.toLocaleString();
}

function formatEstimatedCost(value: number | null, available: boolean): string {
  if (available && value !== null) return `est. ${formatCost(value)}`;
  return "Estimate unavailable";
}

function budgetTone(runtime: ThreadRuntime | null): "destructive" | "secondary" | "outline" {
  const budget = runtime?.sessionUsage?.budgetStatus;
  if (budget?.stopTriggered) return "destructive";
  if (budget?.warningTriggered) return "secondary";
  return "outline";
}

function sessionSourceLabel(thread: ThreadRecord | null, runtime: ThreadRuntime | null): string {
  if (runtime?.transcriptOnly) return "Transcript snapshot";
  if (runtime?.connected) return "Live session";
  if (thread?.status === "active") return "Reconnecting";
  return "Disconnected snapshot";
}

function UsageStat(props: { label: string; value: string; detail?: string }) {
  return (
    <div className="rounded-xl border border-border/70 bg-background/70 p-4">
      <div className="text-[11px] uppercase tracking-[0.18em] text-muted-foreground">{props.label}</div>
      <div className="mt-2 text-lg font-semibold text-foreground">{props.value}</div>
      {props.detail ? <div className="mt-1 text-xs text-muted-foreground">{props.detail}</div> : null}
    </div>
  );
}

export function UsagePage(props: UsagePageProps = {}) {
  const selectedThreadIdFromStore = useAppStore((s) => s.selectedThreadId);
  const threadsFromStore = useAppStore((s) => s.threads);
  const threadRuntimeByIdFromStore = useAppStore((s) => s.threadRuntimeById);
  const clearThreadUsageHardCapFromStore = useAppStore((s) => s.clearThreadUsageHardCap);
  const serverState = typeof window === "undefined" ? useAppStore.getState() : null;

  const selectedThreadId = serverState?.selectedThreadId ?? selectedThreadIdFromStore;
  const threads = serverState?.threads ?? threadsFromStore;
  const threadRuntimeById = serverState?.threadRuntimeById ?? threadRuntimeByIdFromStore;

  const thread = props.thread !== undefined
    ? props.thread
    : (selectedThreadId ? threads.find((entry) => entry.id === selectedThreadId) ?? null : null);
  const runtime = props.runtime !== undefined ? props.runtime : (thread ? threadRuntimeById[thread.id] ?? null : null);
  const sessionUsage = runtime?.sessionUsage ?? null;
  const lastTurnUsage = runtime?.lastTurnUsage ?? null;

  const [estimateNoticeOpenInternal, setEstimateNoticeOpenInternal] = useState(false);
  const estimateNoticeOpen = props.estimateNoticeOpen ?? estimateNoticeOpenInternal;
  const handleEstimateNoticeOpenChange =
    props.estimateNoticeOpen === undefined ? setEstimateNoticeOpenInternal : undefined;

  const canClearHardCap = Boolean(
    thread
      && runtime?.connected
      && runtime.sessionId
      && sessionUsage?.budgetStatus.stopTriggered,
  );

  const clearHardCap =
    props.onClearHardCap
    ?? (thread ? () => clearThreadUsageHardCapFromStore(thread.id) : undefined);

  const recentTurns = sessionUsage ? [...sessionUsage.turns].slice(-8).reverse() : [];
  const budget = sessionUsage?.budgetStatus ?? null;
  const selectedThreadTitle = thread?.title ?? "No thread selected";
  const modelCount = sessionUsage?.byModel.length ?? 0;

  return (
    <div className="space-y-5" data-usage-page="true">
      <div className="flex items-start justify-between gap-3 max-[960px]:flex-col">
        <div className="space-y-2">
          <h1 className="text-3xl font-semibold tracking-tight text-foreground">Usage</h1>
          <p className="max-w-2xl text-sm text-muted-foreground">
            Thread-level token totals, model breakdowns, recent turn costs, and budget status.
          </p>
        </div>

        <Dialog open={estimateNoticeOpen} onOpenChange={handleEstimateNoticeOpenChange}>
          <DialogTrigger asChild>
            <Button type="button" variant="outline" className="gap-2">
              <AlertTriangleIcon className="h-4 w-4" />
              Estimate notice
            </Button>
          </DialogTrigger>
          <DialogContent showClose className="max-w-lg">
            <DialogHeader>
              <DialogTitle>Usage estimates</DialogTitle>
              <DialogDescription>
                These numbers are estimates based on provider-reported token usage and Cowork&apos;s local pricing
                catalog.
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-3 text-sm text-muted-foreground">
              <p>
                Billing may vary. Providers can round differently, apply cached-token discounts differently, or
                change prices independently of what is bundled in the app.
              </p>
              <p>
                Be careful while using these estimates for spend decisions. Treat hard caps and totals as protective
                guidance, not exact invoices.
              </p>
            </div>
            <DialogFooter>
              <Button type="button" variant="secondary" onClick={() => handleEstimateNoticeOpenChange?.(false)}>
                Got it
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>

      <Card className="border-border/80 bg-card/85">
        <CardHeader className="flex-row items-start justify-between gap-3 space-y-0 max-[960px]:flex-col">
          <div>
            <CardTitle>{selectedThreadTitle}</CardTitle>
            <CardDescription>
              {thread
                ? "Usage is scoped to the currently selected thread."
                : "Select a thread in the sidebar to inspect its session usage."}
            </CardDescription>
          </div>
          <Badge variant={budgetTone(runtime)}>{sessionSourceLabel(thread, runtime)}</Badge>
        </CardHeader>
        <CardContent className="grid gap-3 md:grid-cols-3">
          <div>
            <div className="text-xs uppercase tracking-wide text-muted-foreground">Thread status</div>
            <div className="text-sm font-medium text-foreground">
              {thread ? thread.status : "Unavailable"}
            </div>
          </div>
          <div>
            <div className="text-xs uppercase tracking-wide text-muted-foreground">Last usage update</div>
            <div className="text-sm text-foreground">{formatTimestamp(sessionUsage?.updatedAt)}</div>
          </div>
          <div>
            <div className="text-xs uppercase tracking-wide text-muted-foreground">Session source</div>
            <div className="text-sm text-foreground">{sessionSourceLabel(thread, runtime)}</div>
          </div>
        </CardContent>
      </Card>

      <Card className="border-border/80 bg-card/85">
        <CardHeader>
          <CardTitle>Overview</CardTitle>
          <CardDescription>High-level session totals from the selected thread.</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
          <UsageStat
            label="Estimated cost"
            value={formatEstimatedCost(sessionUsage?.estimatedTotalCostUsd ?? null, sessionUsage?.costTrackingAvailable === true)}
            detail={sessionUsage?.costTrackingAvailable ? "Based on current local pricing data." : "Pricing unavailable for this session."}
          />
          <UsageStat
            label="Total tokens"
            value={sessionUsage ? formatTokenCount(sessionUsage.totalTokens) : "0"}
            detail={sessionUsage ? `${formatTokenCount(sessionUsage.totalPromptTokens)} in • ${formatTokenCount(sessionUsage.totalCompletionTokens)} out` : "No turn usage recorded yet."}
          />
          <UsageStat
            label="Turns"
            value={sessionUsage ? String(sessionUsage.totalTurns) : "0"}
            detail={modelCount > 0 ? `${modelCount} model bucket${modelCount === 1 ? "" : "s"}` : "No model breakdown yet."}
          />
          <UsageStat
            label="Last turn"
            value={lastTurnUsage ? formatTokenCount(lastTurnUsage.usage.totalTokens) : "None"}
            detail={
              lastTurnUsage
                ? [
                    `${formatTokenCount(lastTurnUsage.usage.promptTokens)} in`,
                    `${formatTokenCount(lastTurnUsage.usage.completionTokens)} out`,
                    typeof lastTurnUsage.usage.cachedPromptTokens === "number"
                      ? `${formatTokenCount(lastTurnUsage.usage.cachedPromptTokens)} cached`
                      : null,
                    typeof lastTurnUsage.usage.estimatedCostUsd === "number"
                      ? `est. ${formatCost(lastTurnUsage.usage.estimatedCostUsd)}`
                      : null,
                  ].filter(Boolean).join(" • ")
                : "No completed turn captured yet."
            }
          />
        </CardContent>
      </Card>

      <Card className="border-border/80 bg-card/85">
        <CardHeader className="flex-row items-start justify-between gap-3 space-y-0 max-[960px]:flex-col">
          <div>
            <CardTitle>Budget status</CardTitle>
            <CardDescription>Current warning and hard-stop thresholds for this session.</CardDescription>
          </div>
          {canClearHardCap && clearHardCap ? (
            <Button type="button" variant="outline" size="sm" onClick={() => void clearHardCap()}>
              <RotateCcwIcon className="h-4 w-4" />
              Clear hard cap
            </Button>
          ) : null}
        </CardHeader>
        <CardContent className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
          <UsageStat
            label="Status"
            value={
              budget?.stopTriggered
                ? "Hard cap exceeded"
                : budget?.warningTriggered
                  ? "Warning triggered"
                  : budget?.configured
                    ? "Tracking"
                    : "Inactive"
            }
            detail={
              budget?.stopTriggered && !canClearHardCap
                ? "Reconnect the thread to clear the hard cap."
                : "Budget thresholds are optional session estimates."
            }
          />
          <UsageStat
            label="Current cost"
            value={formatEstimatedCost(budget?.currentCostUsd ?? null, sessionUsage?.costTrackingAvailable === true)}
            detail="Current cumulative estimate for the session."
          />
          <UsageStat
            label="Warning threshold"
            value={typeof budget?.warnAtUsd === "number" ? formatCost(budget.warnAtUsd) : "Not set"}
            detail={budget?.warningTriggered ? "Reached in this session." : "Soft warning only."}
          />
          <UsageStat
            label="Hard stop"
            value={typeof budget?.stopAtUsd === "number" ? formatCost(budget.stopAtUsd) : "Not set"}
            detail={budget?.stopTriggered ? "New turns are blocked until cleared." : "Blocks new turns when exceeded."}
          />
        </CardContent>
      </Card>

      <Card className="border-border/80 bg-card/85">
        <CardHeader>
          <CardTitle>Model breakdown</CardTitle>
          <CardDescription>Aggregated totals by provider and model.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {sessionUsage && sessionUsage.byModel.length > 0 ? (
            sessionUsage.byModel.map((summary) => (
              <div
                key={`${summary.provider}:${summary.model}`}
                className="rounded-xl border border-border/70 bg-background/70 p-4"
              >
                <div className="flex items-start justify-between gap-3 max-[960px]:flex-col">
                  <div>
                    <div className="text-sm font-medium text-foreground">{summary.model}</div>
                    <div className="mt-1 text-xs uppercase tracking-wide text-muted-foreground">
                      {summary.provider} • {summary.turns} turn{summary.turns === 1 ? "" : "s"}
                    </div>
                  </div>
                  <Badge variant="outline">
                    {formatEstimatedCost(summary.estimatedCostUsd, sessionUsage.costTrackingAvailable)}
                  </Badge>
                </div>
                <div className="mt-4 grid gap-3 md:grid-cols-3">
                  <UsageStat
                    label="Prompt"
                    value={formatTokenCount(summary.totalPromptTokens)}
                  />
                  <UsageStat
                    label="Completion"
                    value={formatTokenCount(summary.totalCompletionTokens)}
                  />
                  <UsageStat
                    label="Total"
                    value={formatTokenCount(summary.totalTokens)}
                  />
                </div>
              </div>
            ))
          ) : (
            <div className="rounded-xl border border-dashed border-border/70 bg-background/60 p-5 text-sm text-muted-foreground">
              {thread
                ? "No model usage has been recorded for this thread yet."
                : "Choose a thread first to see its model breakdown."}
            </div>
          )}
        </CardContent>
      </Card>

      <Card className="border-border/80 bg-card/85">
        <CardHeader>
          <CardTitle>Recent turns</CardTitle>
          <CardDescription>The latest recorded turns for this session.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {recentTurns.length > 0 ? (
            recentTurns.map((turn) => (
              <div
                key={turn.turnId}
                className="rounded-xl border border-border/70 bg-background/70 p-4"
              >
                <div className="flex items-start justify-between gap-3 max-[960px]:flex-col">
                  <div>
                    <div className="text-sm font-medium text-foreground">
                      #{turn.turnIndex + 1} • {turn.model}
                    </div>
                    <div className="mt-1 text-xs uppercase tracking-wide text-muted-foreground">
                      {turn.provider} • {formatTimestamp(turn.timestamp)}
                    </div>
                  </div>
                  <Badge variant="outline">
                    {formatEstimatedCost(turn.estimatedCostUsd, sessionUsage?.costTrackingAvailable === true)}
                  </Badge>
                </div>
                <div className="mt-4 grid gap-3 md:grid-cols-4">
                  <UsageStat label="Prompt" value={formatTokenCount(turn.usage.promptTokens)} />
                  <UsageStat label="Completion" value={formatTokenCount(turn.usage.completionTokens)} />
                  <UsageStat label="Total" value={formatTokenCount(turn.usage.totalTokens)} />
                  <UsageStat
                    label="Cached"
                    value={
                      typeof turn.usage.cachedPromptTokens === "number"
                        ? formatTokenCount(turn.usage.cachedPromptTokens)
                        : "—"
                    }
                    detail="Prompt tokens served from cache."
                  />
                </div>
              </div>
            ))
          ) : (
            <div className="rounded-xl border border-dashed border-border/70 bg-background/60 p-5 text-sm text-muted-foreground">
              {thread
                ? "Recent turn estimates will appear after the selected thread completes a turn."
                : "Choose a thread first to inspect recent turns."}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
