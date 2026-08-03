import {
  AlertCircleIcon,
  BotIcon,
  CheckCircle2Icon,
  CircleDashedIcon,
  CircleIcon,
} from "lucide-react";
import type { ReactNode } from "react";
import { memo, useCallback, useMemo, useState } from "react";
import {
  buildCitationSourcesByMessageId,
  buildCitationUrlsByMessageId,
} from "../../../../src/shared/displayCitationMarkers";
import { formatCost, formatTokenCount } from "../../../../src/session/pricing";
import { useAppStore } from "../app/store";
import type { ThreadRuntime } from "../app/types";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "../components/ui/dialog";
import { cn } from "../lib/utils";
import { buildChatRenderItems, shouldShowWorkingPlaceholder } from "./chat/activityGroups";
import { ChatFeed } from "./chat/ChatFeed";
import { activeChildAgentLabels } from "./chat/chatLogic";
import { promoteCitationSourcesToFinalAssistants } from "./chat/citationSourcesForTurn";
import { ChatViewContext } from "./chat/ChatViewContext";
import { buildMentionCatalog } from "./chat/composerMentions";
import {
  type FeedDerivationWindowState,
  prepareFeedDerivationFeed,
  resolveFeedDerivationVisibleCount,
  selectFeedDerivationWindow,
} from "./chat/feedWindow";

const FEED_DERIVATION_WINDOW = 80;
const FEED_DERIVATION_EXPAND_BATCH = 40;
const VIEWER_BOTTOM_OFFSET_PX = 24;
const EMPTY_FEED: never[] = [];
const EMPTY_INTERACTIONS: never[] = [];

function viewerStatusIcon(rt: ThreadRuntime | null): ReactNode {
  const className = "size-3.5 shrink-0";
  if (rt?.executionState === "errored") {
    return <AlertCircleIcon className={cn(className, "text-warning")} />;
  }
  if (rt?.busy || rt?.executionState === "running" || rt?.executionState === "pending_init") {
    return <CircleDashedIcon className={cn(className, "text-primary")} />;
  }
  if (rt?.executionState === "completed") {
    return <CheckCircle2Icon className={cn(className, "text-success")} />;
  }
  return <CircleIcon className={cn(className, "text-muted-foreground")} />;
}

function viewerStatusLabel(rt: ThreadRuntime | null): string {
  if (!rt) return "connecting";
  if (rt.busy) return "running";
  if (!rt.connected) return "connecting";
  return (rt.executionState ?? "idle").replace(/_/g, " ");
}

function viewerUsageLabel(rt: ThreadRuntime | null): string | null {
  const usage = rt?.sessionUsage;
  if (!usage) return null;
  const tokenLabel = `${formatTokenCount(usage.totalTokens)} tokens`;
  const costLabel =
    usage.costTrackingAvailable && typeof usage.estimatedTotalCostUsd === "number"
      ? formatCost(usage.estimatedTotalCostUsd)
      : "cost unavailable";
  return `${tokenLabel} · ${costLabel}`;
}

/**
 * Read-only slide-over for watching a subagent run. Opens from the subagents
 * sidebar or a workflow run without taking over the main chat view, and never
 * renders a composer — the transcript is view-only.
 */
export const AgentRunViewer = memo(function AgentRunViewer() {
  const agentViewerThreadId = useAppStore((s) => s.agentViewerThreadId);
  const closeAgentViewer = useAppStore((s) => s.closeAgentViewer);
  const developerMode = useAppStore((s) => s.developerMode);
  const thread = useAppStore((s) =>
    s.agentViewerThreadId
      ? (s.threads.find((candidate) => candidate.id === s.agentViewerThreadId) ?? null)
      : null,
  );
  const rt = useAppStore((s) =>
    s.agentViewerThreadId ? (s.threadRuntimeById[s.agentViewerThreadId] ?? null) : null,
  );
  const workspaceId = thread?.workspaceId ?? null;
  const workspace = useAppStore((s) =>
    workspaceId ? (s.workspaces.find((candidate) => candidate.id === workspaceId) ?? null) : null,
  );
  const workspaceSkills = useAppStore((s) =>
    workspaceId ? (s.workspaceRuntimeById[workspaceId]?.skills ?? null) : null,
  );
  const workspacePluginsCatalog = useAppStore((s) =>
    workspaceId ? (s.workspaceRuntimeById[workspaceId]?.pluginsCatalog ?? null) : null,
  );
  const mentionCatalog = useMemo(
    () => buildMentionCatalog(workspaceSkills, workspacePluginsCatalog),
    [workspacePluginsCatalog, workspaceSkills],
  );
  const contextValue = useMemo(
    () => ({ developerMode, mentionCatalog }),
    [developerMode, mentionCatalog],
  );

  const feed = rt?.feed ?? EMPTY_FEED;
  const derivationFeed = useMemo(
    () => prepareFeedDerivationFeed(feed, developerMode),
    [developerMode, feed],
  );
  const [feedWindows, setFeedWindows] = useState<Map<string, FeedDerivationWindowState>>(
    () => new Map(),
  );
  const savedFeedWindow = agentViewerThreadId ? feedWindows.get(agentViewerThreadId) : undefined;
  const feedVisibleCount = resolveFeedDerivationVisibleCount(
    savedFeedWindow,
    derivationFeed.length,
    FEED_DERIVATION_WINDOW,
  );
  const windowedSourceFeed = useMemo(
    () => selectFeedDerivationWindow(derivationFeed, feedVisibleCount),
    [derivationFeed, feedVisibleCount],
  );
  const visibleFeed = windowedSourceFeed.feed;
  const expandOlderFeed = useCallback(() => {
    if (!agentViewerThreadId) return;
    setFeedWindows((current) => {
      const next = new Map(current);
      next.set(agentViewerThreadId, {
        feedLength: derivationFeed.length,
        visibleCount: Math.min(
          derivationFeed.length,
          feedVisibleCount + FEED_DERIVATION_EXPAND_BATCH,
        ),
      });
      return next;
    });
  }, [agentViewerThreadId, derivationFeed.length, feedVisibleCount]);
  const showAllOlderFeed = useCallback(() => {
    if (!agentViewerThreadId) return;
    setFeedWindows((current) => {
      const next = new Map(current);
      next.set(agentViewerThreadId, {
        feedLength: derivationFeed.length,
        visibleCount: derivationFeed.length,
      });
      return next;
    });
  }, [agentViewerThreadId, derivationFeed.length]);

  const citationUrlsByMessageId = useMemo(() => buildCitationUrlsByMessageId(visibleFeed), [
    visibleFeed,
  ]);
  const inlineCitationSourcesByMessageId = useMemo(
    () => buildCitationSourcesByMessageId(visibleFeed),
    [visibleFeed],
  );
  const citationSourcesByMessageId = useMemo(
    () => promoteCitationSourcesToFinalAssistants(visibleFeed, inlineCitationSourcesByMessageId),
    [inlineCitationSourcesByMessageId, visibleFeed],
  );
  const renderItems = useMemo(() => buildChatRenderItems(visibleFeed), [visibleFeed]);
  // One visual live owner per busy turn: the latest top-level render item wins
  // so activity cards and assistant bubbles are never simultaneously "live".
  const liveOwnership = useMemo(() => {
    if (rt?.busy !== true) {
      return { activityGroupId: null as string | null, assistantMessageId: null as string | null };
    }
    for (let i = renderItems.length - 1; i >= 0; i--) {
      const entry = renderItems[i];
      if (!entry) continue;
      if (entry.kind === "activity-group") {
        return { activityGroupId: entry.id, assistantMessageId: null };
      }
      if (entry.item.kind === "message" && entry.item.role === "assistant") {
        return { activityGroupId: null, assistantMessageId: entry.item.id };
      }
      if (entry.item.kind === "message" && entry.item.role === "user") {
        return { activityGroupId: null, assistantMessageId: null };
      }
    }
    return { activityGroupId: null, assistantMessageId: null };
  }, [renderItems, rt?.busy]);
  const workingPlaceholderVisible = useMemo(
    () =>
      shouldShowWorkingPlaceholder({
        busy: rt?.busy === true,
        turnStartPending: rt?.pendingTurnStart != null,
        renderItems,
      }),
    [renderItems, rt?.busy, rt?.pendingTurnStart],
  );
  const activeAgentLabels = useMemo(() => activeChildAgentLabels(rt?.agents ?? []), [rt?.agents]);
  const noopInteractionHandler = useCallback(() => false, []);

  const busy = rt?.busy === true;
  const connected = rt?.connected === true;
  const hydrating = rt?.hydrating === true || (!connected && visibleFeed.length === 0);
  const disconnected = !hydrating && !connected;

  const title = thread?.title?.trim() || "Subagent run";
  const metaLine = [
    rt?.role ?? null,
    rt ? `depth ${rt.depth}` : null,
    rt?.effectiveModel ?? null,
  ]
    .filter((part): part is string => typeof part === "string" && part.length > 0)
    .join(" · ");
  const usageLabel = viewerUsageLabel(rt);

  return (
    <Dialog
      open={agentViewerThreadId !== null}
      onOpenChange={(open) => {
        if (!open) closeAgentViewer();
      }}
    >
      <DialogContent
        data-slot="agent-run-viewer"
        overlayClassName="bg-transparent"
        className="top-3 right-3 bottom-3 left-auto flex h-auto w-full max-w-[calc(100%-1.5rem)] translate-x-0 translate-y-0 flex-col gap-0 rounded-2xl border bg-background/80 p-0 shadow-2xl backdrop-blur-xl data-[state=closed]:fade-out-0 data-[state=closed]:slide-out-to-right data-[state=closed]:zoom-out-100 data-[state=open]:fade-in-0 data-[state=open]:slide-in-from-right data-[state=open]:zoom-in-100 sm:max-w-md"
      >
        <div className="flex items-start gap-3 border-b border-border/60 px-4 py-3 pr-12">
          <div className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted/60 text-muted-foreground">
            <BotIcon className="size-4" />
          </div>
          <div className="min-w-0 flex-1">
            <DialogTitle className="truncate text-base">{title}</DialogTitle>
            <DialogDescription className="mt-0.5 truncate text-xs">
              {metaLine || "Read-only view of this subagent run."}
            </DialogDescription>
            <div className="mt-1.5 flex items-center gap-3 text-xs text-muted-foreground">
              <span className="flex items-center gap-1.5" data-slot="agent-run-status">
                {viewerStatusIcon(rt)}
                <span>{viewerStatusLabel(rt)}</span>
              </span>
              {usageLabel ? <span className="tabular-nums">{usageLabel}</span> : null}
            </div>
          </div>
        </div>
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
          <ChatViewContext.Provider value={contextValue}>
            <ChatFeed
              busy={busy}
              transcriptOnly={false}
              disconnected={disconnected}
              visibleFeedLength={visibleFeed.length}
              hydrating={hydrating}
              renderItems={renderItems}
              liveActivityGroupId={liveOwnership.activityGroupId}
              liveStartedAt={rt?.busySince ?? null}
              activeAgentLabels={activeAgentLabels}
              showWorkingPlaceholder={workingPlaceholderVisible}
              streamingAssistantMessageId={liveOwnership.assistantMessageId}
              citationUrlsByMessageId={citationUrlsByMessageId}
              citationSourcesByMessageId={citationSourcesByMessageId}
              desktopBasePath={workspace?.path ?? null}
              bottomOffset={VIEWER_BOTTOM_OFFSET_PX}
              interactions={EMPTY_INTERACTIONS}
              onAnswerAsk={noopInteractionHandler}
              onAnswerApproval={noopInteractionHandler}
              onRetryInteraction={noopInteractionHandler}
              selectedThreadId={agentViewerThreadId}
              hiddenFeedItemCount={windowedSourceFeed.hiddenCount}
              onExpandOlderFeed={expandOlderFeed}
              onShowAllOlderFeed={showAllOlderFeed}
            />
          </ChatViewContext.Provider>
        </div>
      </DialogContent>
    </Dialog>
  );
});
