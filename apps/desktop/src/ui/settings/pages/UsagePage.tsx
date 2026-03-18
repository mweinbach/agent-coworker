import { useEffect, useMemo, useState } from "react";

import { AlertTriangleIcon, ChevronDownIcon, ChevronRightIcon } from "lucide-react";
import { useAutoAnimate } from "@formkit/auto-animate/react";

import { useAppStore } from "../../../app/store";
import type { ThreadRuntime } from "../../../app/types";
import { Badge } from "../../../components/ui/badge";
import { Button } from "../../../components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "../../../components/ui/dialog";
import { cn } from "../../../lib/utils";
import { formatCost, formatTokenCount } from "../../../../../../src/session/pricing";
import type { ModelUsageSummary } from "../../../../../../src/session/costTracker";

// ── Aggregation types ────────────────────────────────────────────────

type AggregateModelEntry = {
  provider: string;
  model: string;
  turns: number;
  sessions: number;
  totalPromptTokens: number;
  totalCompletionTokens: number;
  totalTokens: number;
  estimatedCostUsd: number | null;
};

type ProviderGroup = {
  provider: string;
  models: AggregateModelEntry[];
  totalTokens: number;
  totalTurns: number;
  estimatedCostUsd: number | null;
};

export type AggregateUsage = {
  totalCostUsd: number | null;
  costTrackingAvailable: boolean;
  totalTokens: number;
  totalPromptTokens: number;
  totalCompletionTokens: number;
  totalTurns: number;
  totalSessions: number;
  providers: ProviderGroup[];
};

// ── Pure aggregation (exported for testing) ──────────────────────────

export function aggregateUsageFromRuntimes(
  runtimes: Record<string, ThreadRuntime>,
): AggregateUsage {
  const byKey = new Map<string, AggregateModelEntry>();
  let totalCostUsd: number | null = null;
  let costTrackingAvailable = false;
  let totalTokens = 0;
  let totalPromptTokens = 0;
  let totalCompletionTokens = 0;
  let totalTurns = 0;
  let totalSessions = 0;

  for (const runtime of Object.values(runtimes)) {
    const usage = runtime.sessionUsage;
    if (!usage) continue;

    totalSessions++;
    totalTurns += usage.totalTurns;
    totalTokens += usage.totalTokens;
    totalPromptTokens += usage.totalPromptTokens;
    totalCompletionTokens += usage.totalCompletionTokens;

    if (usage.costTrackingAvailable) costTrackingAvailable = true;
    if (typeof usage.estimatedTotalCostUsd === "number") {
      totalCostUsd = (totalCostUsd ?? 0) + usage.estimatedTotalCostUsd;
    }

    for (const entry of usage.byModel) {
      const key = `${entry.provider}:${entry.model}`;
      const existing = byKey.get(key);
      if (existing) {
        existing.turns += entry.turns;
        existing.sessions += 1;
        existing.totalPromptTokens += entry.totalPromptTokens;
        existing.totalCompletionTokens += entry.totalCompletionTokens;
        existing.totalTokens += entry.totalTokens;
        if (typeof entry.estimatedCostUsd === "number") {
          existing.estimatedCostUsd = (existing.estimatedCostUsd ?? 0) + entry.estimatedCostUsd;
        }
      } else {
        byKey.set(key, {
          provider: entry.provider,
          model: entry.model,
          turns: entry.turns,
          sessions: 1,
          totalPromptTokens: entry.totalPromptTokens,
          totalCompletionTokens: entry.totalCompletionTokens,
          totalTokens: entry.totalTokens,
          estimatedCostUsd: entry.estimatedCostUsd,
        });
      }
    }
  }

  // Group by provider, sort providers by total cost desc, models within by cost desc
  const providerMap = new Map<string, AggregateModelEntry[]>();
  for (const entry of byKey.values()) {
    const list = providerMap.get(entry.provider) ?? [];
    list.push(entry);
    providerMap.set(entry.provider, list);
  }

  const providers: ProviderGroup[] = [];
  for (const [provider, models] of providerMap) {
    models.sort((a, b) => (b.estimatedCostUsd ?? 0) - (a.estimatedCostUsd ?? 0));
    let providerCost: number | null = null;
    let providerTokens = 0;
    let providerTurns = 0;
    for (const m of models) {
      providerTokens += m.totalTokens;
      providerTurns += m.turns;
      if (typeof m.estimatedCostUsd === "number") {
        providerCost = (providerCost ?? 0) + m.estimatedCostUsd;
      }
    }
    providers.push({
      provider,
      models,
      totalTokens: providerTokens,
      totalTurns: providerTurns,
      estimatedCostUsd: providerCost,
    });
  }
  providers.sort((a, b) => (b.estimatedCostUsd ?? 0) - (a.estimatedCostUsd ?? 0));

  return {
    totalCostUsd,
    costTrackingAvailable,
    totalTokens,
    totalPromptTokens,
    totalCompletionTokens,
    totalTurns,
    totalSessions,
    providers,
  };
}

// ── Helpers ──────────────────────────────────────────────────────────

function formatEstimatedCost(value: number | null, available: boolean): string {
  if (available && value !== null) return formatCost(value);
  return "—";
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

// ── Component ────────────────────────────────────────────────────────

export type UsagePageProps = {
  aggregate?: AggregateUsage | null;
  estimateNoticeOpen?: boolean;
};

export function UsagePage(props: UsagePageProps = {}) {
  const threadRuntimeByIdFromStore = useAppStore((s) => s.threadRuntimeById);
  const loadAllThreadUsage = useAppStore((s) => s.loadAllThreadUsage);
  const serverState = typeof window === "undefined" ? useAppStore.getState() : null;
  const threadRuntimeById = serverState?.threadRuntimeById ?? threadRuntimeByIdFromStore;

  // Load usage data for all threads on mount so the aggregate view is complete
  useEffect(() => {
    if (props.aggregate !== undefined) return; // skip when overridden (tests)
    void loadAllThreadUsage();
  }, []);

  const computedAggregate = useMemo(() => aggregateUsageFromRuntimes(threadRuntimeById), [threadRuntimeById]);
  const aggregate = props.aggregate ?? computedAggregate;

  const [estimateNoticeOpenInternal, setEstimateNoticeOpenInternal] = useState(false);
  const estimateNoticeOpen = props.estimateNoticeOpen ?? estimateNoticeOpenInternal;
  const handleEstimateNoticeOpenChange =
    props.estimateNoticeOpen === undefined ? setEstimateNoticeOpenInternal : undefined;

  const [expandedProviders, setExpandedProviders] = useState<Record<string, boolean>>({});
  const toggleProvider = (provider: string) => {
    setExpandedProviders((prev) => ({ ...prev, [provider]: !prev[provider] }));
  };

  const [parent] = useAutoAnimate();

  const hasUsage = aggregate && aggregate.totalSessions > 0;

  return (
    <div className="space-y-5" data-usage-page="true">
      <div className="flex items-start justify-between gap-3 max-[960px]:flex-col">
        <div className="space-y-2">
          <h1 className="text-3xl font-semibold tracking-tight text-foreground">Usage</h1>
          <p className="max-w-2xl text-sm text-muted-foreground">
            Token usage and estimated costs across all sessions, broken down by provider and model.
          </p>
        </div>

        <Dialog open={estimateNoticeOpen} onOpenChange={handleEstimateNoticeOpenChange}>
          <DialogTrigger asChild>
            <Button type="button" variant="outline" className="gap-2">
              <AlertTriangleIcon className="h-4 w-4" />
              How estimates work
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
                Be careful while using these estimates for spend decisions. Treat totals as protective
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

      {/* ── Overview stats ──────────────────────────────────────────── */}
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
        <UsageStat
          label="Estimated total cost"
          value={hasUsage ? formatEstimatedCost(aggregate.totalCostUsd, aggregate.costTrackingAvailable) : "—"}
          detail={hasUsage && aggregate.costTrackingAvailable ? "Based on local pricing data" : hasUsage ? "Pricing unavailable for some models" : "No usage recorded yet"}
        />
        <UsageStat
          label="Total tokens"
          value={hasUsage ? formatTokenCount(aggregate.totalTokens) : "0"}
          detail={hasUsage ? `${formatTokenCount(aggregate.totalPromptTokens)} in · ${formatTokenCount(aggregate.totalCompletionTokens)} out` : "No usage recorded yet"}
        />
        <UsageStat
          label="Total turns"
          value={hasUsage ? String(aggregate.totalTurns) : "0"}
          detail={hasUsage ? `Across ${aggregate.totalSessions} session${aggregate.totalSessions === 1 ? "" : "s"}` : "No sessions yet"}
        />
        <UsageStat
          label="Providers"
          value={hasUsage ? String(aggregate.providers.length) : "0"}
          detail={hasUsage ? `${aggregate.providers.reduce((n, p) => n + p.models.length, 0)} model${aggregate.providers.reduce((n, p) => n + p.models.length, 0) === 1 ? "" : "s"} used` : "No models used yet"}
        />
      </div>

      {/* ── Provider / model breakdown ──────────────────────────────── */}
      {hasUsage && aggregate.providers.length > 0 ? (
        <div className="space-y-3" ref={parent}>
          <h2 className="text-lg font-medium text-foreground">By provider</h2>
          <div className="rounded-xl border border-border/70 overflow-hidden bg-background/50">
            {aggregate.providers.map((group) => {
              const isExpanded = expandedProviders[group.provider] ?? true;
              return (
                <div key={group.provider} className="border-b border-border/70 last:border-b-0">
                  {/* Provider header */}
                  <div
                    className="flex items-center justify-between p-4 cursor-pointer hover:bg-card/60 transition-colors"
                    onClick={() => toggleProvider(group.provider)}
                  >
                    <div className="flex items-center gap-3">
                      {isExpanded ? (
                        <ChevronDownIcon className="w-4 h-4 text-muted-foreground" />
                      ) : (
                        <ChevronRightIcon className="w-4 h-4 text-muted-foreground" />
                      )}
                      <span className="font-medium text-foreground text-sm capitalize">{group.provider}</span>
                      <Badge variant="secondary" className="text-[10px] uppercase h-5">
                        {group.models.length} model{group.models.length === 1 ? "" : "s"}
                      </Badge>
                    </div>
                    <div className="flex items-center gap-4 text-xs text-muted-foreground">
                      <span>{formatTokenCount(group.totalTokens)} tokens</span>
                      <span>{group.totalTurns} turn{group.totalTurns === 1 ? "" : "s"}</span>
                      {typeof group.estimatedCostUsd === "number" ? (
                        <Badge variant="outline">{formatCost(group.estimatedCostUsd)}</Badge>
                      ) : null}
                    </div>
                  </div>

                  {/* Model rows */}
                  {isExpanded && (
                    <div className="border-t border-border/50">
                      {group.models.map((model) => (
                        <div
                          key={model.model}
                          className="px-10 py-3 border-b border-border/40 last:border-b-0 bg-card/20"
                        >
                          <div className="flex items-center justify-between mb-2">
                            <div className="flex items-center gap-2">
                              <span className="text-sm font-medium text-foreground">{model.model}</span>
                              <span className="text-xs text-muted-foreground">
                                {model.turns} turn{model.turns === 1 ? "" : "s"} across {model.sessions} session{model.sessions === 1 ? "" : "s"}
                              </span>
                            </div>
                            {typeof model.estimatedCostUsd === "number" ? (
                              <Badge variant="outline">{formatCost(model.estimatedCostUsd)}</Badge>
                            ) : (
                              <span className="text-xs text-muted-foreground">No pricing</span>
                            )}
                          </div>
                          <div className="grid gap-2 grid-cols-3 text-xs">
                            <div>
                              <span className="text-muted-foreground">Prompt: </span>
                              <span className="text-foreground font-medium">{formatTokenCount(model.totalPromptTokens)}</span>
                            </div>
                            <div>
                              <span className="text-muted-foreground">Completion: </span>
                              <span className="text-foreground font-medium">{formatTokenCount(model.totalCompletionTokens)}</span>
                            </div>
                            <div>
                              <span className="text-muted-foreground">Total: </span>
                              <span className="text-foreground font-medium">{formatTokenCount(model.totalTokens)}</span>
                            </div>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      ) : (
        <div className="rounded-xl border border-dashed border-border/70 bg-background/60 p-8 text-center text-sm text-muted-foreground">
          No usage data recorded yet. Usage will appear here as you use models across sessions.
        </div>
      )}
    </div>
  );
}
