import { createContext, memo, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";

import { AlertTriangleIcon, LoaderCircleIcon, MessageSquareIcon, RotateCcwIcon } from "lucide-react";
import coworkIconSvg from "../../build/icon.icon/Assets/svgviewer-output.svg";

import { useAppStore } from "../app/store";
import type { FeedItem, ThreadAgentSummary, ThreadPendingSteer, ThreadStatus } from "../app/types";
import {
  Conversation,
  ConversationContent,
  ConversationEmptyState,
} from "../components/ai-elements/conversation";
import {
  Message,
  MessageContent,
  MessageResponse,
} from "../components/ai-elements/message";
import {
  PromptInputBody,
  PromptInputFooter,
  PromptInputForm,
  PromptInputRoot,
  PromptInputSubmit,
  PromptInputTextarea,
  PromptInputTools,
} from "../components/ai-elements/prompt-input";
import { MessageBarResizer } from "./layout/MessageBarResizer";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Card, CardContent } from "../components/ui/card";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "../components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "../components/ui/dialog";
import {
  availableProvidersFromCatalog,
  modelChoicesFromCatalog,
  type CatalogVisibilityOptions,
} from "../lib/modelChoices";
import { readFile } from "../lib/desktopCommands";
import { PROVIDER_NAMES, type ProviderName } from "../lib/wsProtocol";
import { cn } from "../lib/utils";
import { defaultModelForProvider } from "@cowork/providers/catalog";
import { formatCost, formatTokenCount } from "../../../../src/session/pricing";
import {
  buildCitationOverflowFilePathsByMessageId,
  buildCitationSourcesByMessageId,
  buildCitationUrlsByMessageId,
  extractCitationSourcesFromWebSearchResult,
  extractCitationUrlsFromWebSearchResult,
} from "../../../../src/shared/displayCitationMarkers";
import type { CitationSource } from "../../../../src/shared/displayCitationMarkers";
import { SourcesCarousel } from "../components/ai-elements/sources-carousel";
import type { SessionUsageSnapshot, TurnUsageSnapshot } from "../app/types";
import { ActivityGroupCard } from "./chat/ActivityGroupCard";
import { buildChatRenderItems } from "./chat/activityGroups";
import { normalizeFeedForToolCards } from "./chat/toolCards/legacyToolLogs";
import { ToolCard } from "./chat/toolCards/ToolCard";

type ChatViewContextValue = {
  developerMode: boolean;
};

const ChatViewContext = createContext<ChatViewContextValue | null>(null);

function useChatViewContext(): ChatViewContextValue {
  const context = useContext(ChatViewContext);
  if (!context) {
    throw new Error("ChatViewContext is not available");
  }
  return context;
}

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

export function isActiveChildAgent(agent: ThreadAgentSummary): boolean {
  if (agent.lifecycleState === "closed") return false;
  return agent.busy || agent.executionState === "pending_init" || agent.executionState === "running";
}

export function countActiveChildAgents(agents: ThreadAgentSummary[]): number {
  return agents.filter(isActiveChildAgent).length;
}

export function filterFeedForDeveloperMode(feed: FeedItem[], developerMode: boolean): FeedItem[] {
  return developerMode ? feed : feed.filter((item) => item.kind !== "system" && item.kind !== "log");
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
    return "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300";
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
  return opts.sessionUsage?.budgetStatus.stopTriggered === true
    && !opts.transcriptOnly
    && opts.connected
    && Boolean(opts.sessionId)
    && opts.threadStatus === "active";
}

export function getComposerSubmitState(opts: {
  busy: boolean;
  hasPromptModal: boolean;
  composerText: string;
  pendingSteer: ThreadPendingSteer | null;
  sessionId: string | null;
  threadStatus: ThreadStatus;
}): { status: "ready" | "streaming"; disabled: boolean; mode: "send" | "steer-ready" | "steer-pending" } {
  const composerText = opts.composerText.trim();
  const hasComposerText = composerText.length > 0;
  const steerPending = opts.busy
    && hasComposerText
    && opts.pendingSteer?.status === "sending"
    && opts.pendingSteer.text.trim() === composerText;

  if (opts.busy && !hasComposerText) {
    return {
      status: "streaming",
      disabled: opts.hasPromptModal || !opts.sessionId || opts.threadStatus !== "active",
      mode: "send",
    };
  }

  return {
    status: "ready",
    mode: opts.busy ? (steerPending ? "steer-pending" : "steer-ready") : "send",
    disabled:
      opts.hasPromptModal
      || !hasComposerText
      || steerPending
      || (opts.busy && (!opts.sessionId || opts.threadStatus !== "active")),
  };
}

export function composerBusyHint(submitState: ReturnType<typeof getComposerSubmitState>): string {
  if (submitState.status === "streaming") {
    return "Type to steer, or use stop to cancel.";
  }
  if (submitState.mode === "steer-pending") {
    return "Steer sent. Waiting for the running turn to accept it.";
  }
  if (submitState.mode === "steer-ready") {
    return "Steer ready. Press Enter to inject it into the current run.";
  }
  return "Press Enter to send, Shift+Enter for newline.";
}

export function resolveComposerBusyPolicy(busy: boolean): "reject" | "steer" {
  return busy ? "steer" : "reject";
}

type OverflowCitationContext = {
  sourcesByMessageId: Map<string, CitationSource[]>;
  urlsByMessageId: Map<string, Map<number, string>>;
};

export async function loadOverflowCitationContext(
  entries: Array<[messageId: string, filePath: string]>,
  readFileFn: (input: { path: string }) => Promise<string> = readFile,
): Promise<OverflowCitationContext> {
  const urlsByMessageId = new Map<string, Map<number, string>>();
  const sourcesByMessageId = new Map<string, CitationSource[]>();
  const textByPath = new Map<string, string>();

  for (const [messageId, filePath] of entries) {
    try {
      let content = textByPath.get(filePath);
      if (content === undefined) {
        content = await readFileFn({ path: filePath });
        textByPath.set(filePath, content);
      }

      urlsByMessageId.set(messageId, extractCitationUrlsFromWebSearchResult(content));

      const sources = extractCitationSourcesFromWebSearchResult(content);
      if (sources.length > 0) {
        sourcesByMessageId.set(messageId, sources);
      }
    } catch {
      urlsByMessageId.set(messageId, new Map());
    }
  }

  return { urlsByMessageId, sourcesByMessageId };
}

export function ChatThreadHeader(props: {
  title: string;
  sessionUsage: SessionUsageSnapshot | null;
  usageHeadline: string | null;
  usageBudgetLine: string | null;
  canClearHardCap: boolean;
  onClearHardCap: () => void;
}) {
  const {
    title,
    sessionUsage,
    usageHeadline,
    usageBudgetLine,
    canClearHardCap,
    onClearHardCap,
  } = props;
  const hasUsageSummary = Boolean(usageHeadline || usageBudgetLine);

  return (
    <div className="absolute top-0 left-0 right-0 z-10 flex items-start justify-center pointer-events-none p-3 pb-8 bg-gradient-to-b from-panel via-panel/80 to-transparent">
      <div
        className={cn(
          "pointer-events-auto relative flex flex-col items-center outline-none",
          hasUsageSummary ? "group" : null,
        )}
        tabIndex={hasUsageSummary ? 0 : undefined}
      >
        <div
          className={cn(
            "max-w-lg truncate rounded-full border border-border/50 bg-background/80 px-4 py-1.5 text-sm font-medium text-foreground shadow-sm backdrop-blur-md",
            hasUsageSummary
              ? "transition-[border-color,box-shadow,background-color] group-hover:border-border group-focus-within:border-border group-focus-within:ring-2 group-focus-within:ring-ring/40"
              : null,
          )}
        >
          {title}
        </div>
        {hasUsageSummary ? (
          <div
            className={cn(
              "absolute top-full mt-2 flex max-w-3xl flex-wrap items-center justify-center gap-2 rounded-full border px-4 py-1.5 text-xs shadow-sm backdrop-blur-md opacity-0 -translate-y-1 pointer-events-none transition-all duration-150 ease-out group-hover:pointer-events-auto group-hover:translate-y-0 group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:translate-y-0 group-focus-within:opacity-100",
              sessionUsageTone(sessionUsage),
            )}
          >
            <span className="text-[10px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">Usage</span>
            {usageHeadline ? <span>{usageHeadline}</span> : null}
            {usageBudgetLine ? <span className="font-medium">{usageBudgetLine}</span> : null}
            {canClearHardCap ? (
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="h-7 rounded-full px-3 text-[11px]"
                onClick={onClearHardCap}
              >
                Clear hard cap
              </Button>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}

const FeedRow = memo(function FeedRow(props: {
  item: FeedItem;
  citationUrlsByIndex?: ReadonlyMap<number, string>;
  citationSources?: CitationSource[];
}) {
  const { developerMode } = useChatViewContext();
  const item = props.item;
  const hasSources = props.citationSources && props.citationSources.length > 0;

  if (item.kind === "message") {
    return (
      <Message from={item.role}>
        <MessageContent>
          {item.role === "assistant" ? (
            <MessageResponse
              citationAnnotations={item.annotations}
              citationUrlsByIndex={props.citationUrlsByIndex}
              normalizeDisplayCitations
              fallbackToSourcesFooter={!hasSources}
            >
              {item.text}
            </MessageResponse>
          ) : (
            <div className="whitespace-pre-wrap">{item.text}</div>
          )}
        </MessageContent>
        {hasSources && (
          <SourcesCarousel sources={props.citationSources!} className="mt-1" />
        )}
      </Message>
    );
  }

  if (item.kind === "reasoning") {
    return null;
  }

  if (item.kind === "todos") {
    return null;
  }

  if (item.kind === "tool") {
    return (
      <ToolCard
        name={item.name}
        args={item.args}
        approval={item.approval}
        result={item.result}
        state={item.state}
      />
    );
  }

  if (item.kind === "log") {
    if (!developerMode) return null;
    return (
      <Card className="max-w-3xl border-border/70 bg-muted/30">
        <CardContent className="select-text p-3 text-xs text-muted-foreground">
          <div className="mb-1 font-semibold uppercase tracking-wide text-primary">Log</div>
          <div className="whitespace-pre-wrap">{item.line}</div>
        </CardContent>
      </Card>
    );
  }

  if (item.kind === "error") {
    return (
      <Card className="max-w-3xl border-destructive/40 bg-destructive/10">
        <CardContent className="select-text p-3 text-sm">
          <div className="mb-1 font-semibold uppercase tracking-wide text-destructive">Error</div>
          <div>{item.message}</div>
        </CardContent>
      </Card>
    );
  }

  if (item.kind === "system") {
    return (
      <Card className="max-w-3xl border-border/70 bg-muted/30">
        <CardContent className="select-text p-3 text-xs text-muted-foreground">
          <div className="mb-1 font-semibold uppercase tracking-wide text-primary">System</div>
          <div className="whitespace-pre-wrap">{item.line}</div>
        </CardContent>
      </Card>
    );
  }

  return null;
});

const PROVIDER_LABELS: Record<ProviderName, string> = {
  google: "Google",
  openai: "OpenAI",
  "aws-bedrock-proxy": "AWS Bedrock Proxy",
  anthropic: "Anthropic",
  baseten: "Baseten",
  together: "Together AI",
  nvidia: "NVIDIA",
  lmstudio: "LM Studio",
  "opencode-go": "OpenCode Go",
  "opencode-zen": "OpenCode Zen",
  "codex-cli": "ChatGPT Subscription",
};

function isChatProviderName(value: unknown): value is ProviderName {
  return typeof value === "string" && (PROVIDER_NAMES as readonly string[]).includes(value);
}

function DraftThreadModelSelector({
  threadId,
  provider,
  model,
  disabled,
}: {
  threadId: string;
  provider: ProviderName;
  model: string;
  disabled?: boolean;
}) {
  const setThreadModel = useAppStore((s) => s.setThreadModel);
  const providerCatalog = useAppStore((s) => s.providerCatalog);
  const providerConnected = useAppStore((s) => s.providerConnected);
  const providerUiState = useAppStore((s) => s.providerUiState);
  const chatCatalogVisibility = useMemo<CatalogVisibilityOptions>(() => ({
    hiddenProviders: providerUiState.lmstudio.enabled ? [] : (["lmstudio"] as const),
    hiddenModelsByProvider: {
      lmstudio: providerUiState.lmstudio.hiddenModels,
    },
  }), [providerUiState]);
  const choices = useMemo(
    () => modelChoicesFromCatalog(providerCatalog, chatCatalogVisibility),
    [providerCatalog, chatCatalogVisibility],
  );
  const providers = useMemo(
    () => availableProvidersFromCatalog(providerCatalog, providerConnected, provider, {
      ...chatCatalogVisibility,
      visibleModelsByProvider: choices,
    }),
    [providerCatalog, providerConnected, provider, chatCatalogVisibility, choices],
  );
  const value = `${provider}:${model}`;

  return (
    <Select
      value={value}
      disabled={disabled}
      onValueChange={(val) => {
        const [p, ...mParts] = val.split(":");
        setThreadModel(threadId, p as ProviderName, mParts.join(":"));
      }}
    >
      <SelectTrigger
        size="sm"
        className="h-7 w-auto min-w-0 max-w-[220px] border-none bg-transparent px-1.5 text-xs text-muted-foreground shadow-none transition-colors hover:bg-muted/50 hover:text-foreground focus:ring-0"
      >
        <span className="truncate"><SelectValue placeholder="Model" /></span>
      </SelectTrigger>
      <SelectContent>
        {providers.map((p) => (
          <SelectGroup key={p}>
            <SelectLabel className="px-2 py-1.5 text-xs font-semibold">{PROVIDER_LABELS[p] ?? p}</SelectLabel>
            {(choices[p] ?? []).map((m) => (
              <SelectItem key={`${p}:${m}`} value={`${p}:${m}`} className="pl-6 text-xs">
                {m}
              </SelectItem>
            ))}
            {p === provider && model && !(choices[p] ?? []).includes(model) ? (
              <SelectItem key={`${p}:${model}`} value={`${p}:${model}`} className="pl-6 text-xs">
                {model} (custom)
              </SelectItem>
            ) : null}
          </SelectGroup>
        ))}
      </SelectContent>
    </Select>
  );
}

function ThreadModelIndicator({
  provider,
  model,
}: {
  provider: ProviderName;
  model: string;
}) {
  const label = model.trim();
  if (!label) return null;
  const title = `${PROVIDER_LABELS[provider] ?? provider} / ${label}`;

  return (
    <Badge
      variant="outline"
      title={title}
      aria-label={`Session model ${title}`}
      className="h-7 max-w-[220px] rounded-full border-border/60 bg-muted/30 px-2.5 font-normal text-muted-foreground shadow-none"
    >
      <span className="truncate">{label}</span>
    </Badge>
  );
}

export function ChatView() {
  const bootstrapPending = useAppStore((s) => s.bootstrapPending);
  const selectedThreadId = useAppStore((s) => s.selectedThreadId);
  const thread = useAppStore((s) => {
    if (!s.selectedThreadId) return null;
    return s.threads.find((t) => t.id === s.selectedThreadId) ?? null;
  });
  const rt = useAppStore((s) => {
    if (!s.selectedThreadId) return null;
    return s.threadRuntimeById[s.selectedThreadId] ?? null;
  });
  const composerText = useAppStore((s) => s.composerText);
  const hasPromptModal = useAppStore((s) => s.promptModal !== null);
  const developerMode = useAppStore((s) => s.developerMode);
  const messageBarHeight = useAppStore((s) => s.messageBarHeight);
  const [overflowCitationUrlsByMessageId, setOverflowCitationUrlsByMessageId] = useState<Map<string, Map<number, string>>>(
    () => new Map(),
  );
  const [overflowCitationSourcesByMessageId, setOverflowCitationSourcesByMessageId] = useState<Map<string, CitationSource[]>>(
    () => new Map(),
  );
  const [cancelScopeDialogOpen, setCancelScopeDialogOpen] = useState(false);

  const setComposerText = useAppStore((s) => s.setComposerText);
  const sendMessage = useAppStore((s) => s.sendMessage);
  const cancelThread = useAppStore((s) => s.cancelThread);
  const clearThreadUsageHardCap = useAppStore((s) => s.clearThreadUsageHardCap);
  const reconnectThread = useAppStore((s) => s.reconnectThread);
  const newThread = useAppStore((s) => s.newThread);

  const feedRef = useRef<HTMLDivElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const lastCountRef = useRef<number>(0);
  const autoScrolledThreadIdRef = useRef<string | null>(null);

  const feed = rt?.feed ?? [];
  const normalizedFeed = normalizeFeedForToolCards(feed, developerMode);
  const visibleFeed = filterFeedForDeveloperMode(normalizedFeed, developerMode);
  const inlineCitationUrlsByMessageId = useMemo(() => buildCitationUrlsByMessageId(visibleFeed), [visibleFeed]);
  const citationOverflowFilePathsByMessageId = useMemo(
    () => buildCitationOverflowFilePathsByMessageId(visibleFeed),
    [visibleFeed],
  );
  const citationUrlsByMessageId = useMemo(() => {
    const merged = new Map(inlineCitationUrlsByMessageId);
    for (const [messageId, urls] of overflowCitationUrlsByMessageId) {
      if (urls.size > 0) {
        merged.set(messageId, urls);
      }
    }
    return merged;
  }, [inlineCitationUrlsByMessageId, overflowCitationUrlsByMessageId]);
  const inlineCitationSourcesByMessageId = useMemo(() => buildCitationSourcesByMessageId(visibleFeed), [visibleFeed]);
  const citationSourcesByMessageId = useMemo(() => {
    const merged = new Map(inlineCitationSourcesByMessageId);
    for (const [messageId, sources] of overflowCitationSourcesByMessageId) {
      if (sources.length > 0) {
        merged.set(messageId, sources);
      }
    }
    return merged;
  }, [inlineCitationSourcesByMessageId, overflowCitationSourcesByMessageId]);
  const renderItems = useMemo(() => buildChatRenderItems(visibleFeed), [visibleFeed]);
  const activeChildAgentCount = useMemo(
    () => countActiveChildAgents(rt?.agents ?? []),
    [rt?.agents],
  );
  const contextValue = useMemo<ChatViewContextValue>(
    () => ({
      developerMode,
    }),
    [developerMode],
  );

  const workspace = useAppStore((s) => {
    if (!s.selectedThreadId) return null;
    const th = s.threads.find((t) => t.id === s.selectedThreadId);
    if (!th) return null;
    return s.workspaces.find((w) => w.id === th.workspaceId) ?? null;
  });

  const threadModelConfig = useMemo(() => {
    if (!selectedThreadId || !thread) return null;
    if (!rt || rt.sessionKind === "agent") return null;
    if (rt.transcriptOnly === true) return null;

    if (thread.draft) {
      if (!workspace) return null;
      const baseProvider =
        workspace.defaultProvider && isChatProviderName(workspace.defaultProvider)
          ? workspace.defaultProvider
          : "google";
      const provider =
        rt.draftComposerProvider != null && isChatProviderName(rt.draftComposerProvider)
          ? rt.draftComposerProvider
          : baseProvider;
      const modelRaw =
        typeof rt.draftComposerModel === "string" && rt.draftComposerModel.trim()
          ? rt.draftComposerModel.trim()
          : workspace.defaultModel?.trim() || defaultModelForProvider(provider) || "";
      if (!modelRaw) return null;
      return { provider, model: modelRaw };
    }

    if (rt.config?.provider && rt.config.model) {
      return { provider: rt.config.provider as ProviderName, model: rt.config.model };
    }
    return null;
  }, [selectedThreadId, thread, rt, workspace]);

  const handleStop = useCallback(() => {
    if (!selectedThreadId) return;
    if (activeChildAgentCount > 0) {
      setCancelScopeDialogOpen(true);
      return;
    }
    cancelThread(selectedThreadId);
  }, [activeChildAgentCount, cancelThread, selectedThreadId]);

  const cancelWithScope = useCallback((includeSubagents: boolean) => {
    if (!selectedThreadId) return;
    cancelThread(selectedThreadId, { includeSubagents });
    setCancelScopeDialogOpen(false);
  }, [cancelThread, selectedThreadId]);

  useEffect(() => {
    const el = feedRef.current;
    if (!el) return;

    const isThreadChange = autoScrolledThreadIdRef.current !== selectedThreadId;
    if (isThreadChange) {
      autoScrolledThreadIdRef.current = selectedThreadId;
      lastCountRef.current = visibleFeed.length;
      window.requestAnimationFrame(() => {
        const nextEl = feedRef.current;
        if (nextEl) {
          nextEl.scrollTop = nextEl.scrollHeight;
        }
      });
      return;
    }

    if (visibleFeed.length === lastCountRef.current) return;

    const previousCount = lastCountRef.current;
    lastCountRef.current = visibleFeed.length;

    if (previousCount === 0 && visibleFeed.length > 0) {
      window.requestAnimationFrame(() => {
        const nextEl = feedRef.current;
        if (nextEl) {
          nextEl.scrollTop = nextEl.scrollHeight;
        }
      });
      return;
    }

    const distFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    if (distFromBottom < 220) {
      el.scrollTop = el.scrollHeight;
    }
  }, [selectedThreadId, visibleFeed.length]);

  useEffect(() => {
    let cancelled = false;

    const entries = [...citationOverflowFilePathsByMessageId.entries()];
    if (entries.length === 0) {
      setOverflowCitationUrlsByMessageId((current) => (current.size === 0 ? current : new Map()));
      setOverflowCitationSourcesByMessageId((current) => (current.size === 0 ? current : new Map()));
      return;
    }

    void (async () => {
      const { urlsByMessageId, sourcesByMessageId } = await loadOverflowCitationContext(entries);

      if (!cancelled) {
        setOverflowCitationUrlsByMessageId(urlsByMessageId);
        setOverflowCitationSourcesByMessageId(sourcesByMessageId);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [citationOverflowFilePathsByMessageId]);

  useEffect(() => {
    if (selectedThreadId && textareaRef.current) {
      textareaRef.current.focus();
    }
  }, [selectedThreadId]);

  useEffect(() => {
    if (!rt?.busy || activeChildAgentCount === 0) {
      setCancelScopeDialogOpen(false);
    }
  }, [activeChildAgentCount, rt?.busy]);


  const onComposerKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLTextAreaElement>) => {
      if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        void sendMessage(composerText, resolveComposerBusyPolicy(rt?.busy === true));
      }
    },
    [composerText, rt?.busy, sendMessage],
  );

  if (!selectedThreadId || !thread) {
    return (
      <div className="flex h-full items-center justify-center px-6">
        <div className="flex -translate-y-12 flex-col items-center justify-center gap-4 text-center">
          <img
            src={coworkIconSvg}
            alt=""
            aria-hidden="true"
            className="h-36 w-36 select-none object-contain"
          />
          <h2 className="text-3xl font-semibold tracking-tight">Let&apos;s build</h2>
          <p className="max-w-xl text-muted-foreground">Pick a workspace and start a new thread.</p>
          <Button type="button" onClick={() => void newThread()}>New thread</Button>
        </div>
      </div>
    );
  }

  const busy = rt?.busy === true;
  const disabled = hasPromptModal;
  const transcriptOnly = rt?.transcriptOnly === true;
  const hydrating = rt?.hydrating === true || (bootstrapPending && Boolean(selectedThreadId) && Boolean(thread) && rt === null);
  const disconnected = !hydrating && !transcriptOnly && thread.status !== "active";
  const usageHeadline = formatSessionUsageHeadline(rt?.sessionUsage ?? null, rt?.lastTurnUsage ?? null, {
    showTokens: developerMode,
  });
  const usageBudgetLine = formatSessionBudgetLine(rt?.sessionUsage ?? null);
  const hasUsageSummary = Boolean(usageHeadline || usageBudgetLine);
  const canClearHardCap = canClearSessionHardCap({
    sessionUsage: rt?.sessionUsage ?? null,
    transcriptOnly,
    connected: rt?.connected === true,
    sessionId: rt?.sessionId ?? null,
    threadStatus: thread.status,
  });
  const composerSubmitState = getComposerSubmitState({
    busy,
    hasPromptModal,
    composerText,
    pendingSteer: rt?.pendingSteer ?? null,
    sessionId: rt?.sessionId ?? null,
    threadStatus: thread.status,
  });

  const placeholder = transcriptOnly
    ? "Continue in a new thread..."
    : disconnected
      ? "Reconnect to continue..."
      : busy
        ? "Type to steer the current run..."
        : "Message...";

  return (
    <ChatViewContext.Provider value={contextValue}>
      <div className="flex h-full min-h-0 flex-col bg-panel relative">
        <ChatThreadHeader
          title={thread.title || "New thread"}
          sessionUsage={rt?.sessionUsage ?? null}
          usageHeadline={usageHeadline}
          usageBudgetLine={usageBudgetLine}
          canClearHardCap={canClearHardCap}
          onClearHardCap={() => clearThreadUsageHardCap(selectedThreadId)}
        />
        <Conversation className="min-h-0" ref={feedRef}>
          <ConversationContent className="pt-24">
            {transcriptOnly ? (
              <Card className="max-w-3xl border-border/70 bg-muted/30">
                <CardContent className="flex items-start gap-3 p-3">
                  <AlertTriangleIcon className="mt-0.5 size-4 text-primary" />
                  <div>
                    <div className="font-semibold">Transcript view</div>
                    <div className="text-sm text-muted-foreground">Sending a message will continue in a new thread.</div>
                  </div>
                </CardContent>
              </Card>
            ) : null}

            {disconnected ? (
              <Card className="max-w-3xl border-border/70 bg-muted/30">
                <CardContent className="flex items-center justify-between gap-3 p-3">
                  <div>
                    <div className="font-semibold">Disconnected</div>
                    <div className="text-sm text-muted-foreground">Reconnect to continue this thread.</div>
                  </div>
                  <Button type="button" variant="outline" size="sm" onClick={() => void reconnectThread(selectedThreadId)}>
                    <RotateCcwIcon data-icon="inline-start" />
                    Reconnect
                  </Button>
                </CardContent>
              </Card>
            ) : null}

            {visibleFeed.length === 0 ? (
              hydrating ? (
                <ConversationEmptyState
                  icon={<LoaderCircleIcon className="size-6 animate-spin" />}
                  title="Loading thread"
                  description="Restoring messages and reconnecting the session."
                />
              ) : (
                <ConversationEmptyState
                  icon={<MessageSquareIcon className="size-6" />}
                  title="New thread"
                  description="Send a message to start."
                />
              )
            ) : (
              renderItems.map((item) =>
                item.kind === "activity-group" ? (
                  <ActivityGroupCard key={item.id} items={item.items} />
                ) : (
                  <FeedRow
                    key={item.item.id}
                    item={item.item}
                    citationUrlsByIndex={citationUrlsByMessageId.get(item.item.id)}
                    citationSources={citationSourcesByMessageId.get(item.item.id)}
                  />
                )
              )
            )}
          </ConversationContent>
        </Conversation>

      <div className="relative border-t border-border/60 px-4 py-1.5 flex flex-col shrink-0" style={{ height: messageBarHeight }}>
        <MessageBarResizer />
        <PromptInputRoot>
            <PromptInputForm
              onSubmit={(event) => {
                event.preventDefault();
                if (!composerText.trim()) return;
                void sendMessage(composerText, resolveComposerBusyPolicy(busy));
              }}
            >
              <PromptInputBody>
                <PromptInputTextarea
                  ref={textareaRef}
                  value={composerText}
                  disabled={disabled}
                  placeholder={placeholder}
                  onChange={(event) => setComposerText(event.currentTarget.value)}
                  onKeyDown={onComposerKeyDown}
                  aria-label="Message input"
                />
              </PromptInputBody>
              <PromptInputFooter>
                <PromptInputTools>
                  {threadModelConfig ? (
                    thread.draft ? (
                      <DraftThreadModelSelector
                        threadId={selectedThreadId}
                        provider={threadModelConfig.provider}
                        model={threadModelConfig.model}
                        disabled={disabled}
                      />
                    ) : (
                      <ThreadModelIndicator
                        provider={threadModelConfig.provider}
                        model={threadModelConfig.model}
                      />
                    )
                  ) : null}
                </PromptInputTools>
                <div className={cn("flex shrink-0 items-center gap-2", busy ? "opacity-100" : "opacity-70")}>
                  <span className="hidden max-w-[18rem] text-right text-xs leading-tight text-muted-foreground sm:block">
                    {composerBusyHint(composerSubmitState)}
                  </span>
                  <PromptInputSubmit
                    mode={composerSubmitState.mode}
                    status={composerSubmitState.status}
                    disabled={composerSubmitState.disabled}
                    onStop={selectedThreadId ? handleStop : undefined}
                  />
                </div>
              </PromptInputFooter>
            </PromptInputForm>
          </PromptInputRoot>
        </div>
        <Dialog open={cancelScopeDialogOpen} onOpenChange={setCancelScopeDialogOpen}>
          <DialogContent showClose className="max-w-md">
            <DialogHeader>
              <DialogTitle>Stop Subagents Too?</DialogTitle>
            </DialogHeader>
            <div className="space-y-4">
              <p className="text-sm text-muted-foreground">
                This run currently has {activeChildAgentCount} active subagent{activeChildAgentCount === 1 ? "" : "s"}.
                You can stop only the main agent turn or cancel the subagents as well.
              </p>
              <div className="flex flex-wrap justify-end gap-2">
                <Button type="button" variant="outline" onClick={() => setCancelScopeDialogOpen(false)}>
                  Keep running
                </Button>
                <Button type="button" variant="secondary" onClick={() => cancelWithScope(false)}>
                  Stop main agent only
                </Button>
                <Button type="button" variant="destructive" onClick={() => cancelWithScope(true)}>
                  Stop subagents too
                </Button>
              </div>
            </div>
          </DialogContent>
        </Dialog>
      </div>
    </ChatViewContext.Provider>
  );
}
