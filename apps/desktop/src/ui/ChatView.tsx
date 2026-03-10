import { createContext, memo, useCallback, useContext, useEffect, useMemo, useRef } from "react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";

import { AlertTriangleIcon, MessageSquareIcon, RotateCcwIcon } from "lucide-react";
import coworkIconSvg from "../../build/icon.icon/Assets/svgviewer-output.svg";

import { useAppStore } from "../app/store";
import type { FeedItem, ThreadStatus } from "../app/types";
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
import { MODEL_CHOICES, UI_DISABLED_PROVIDERS } from "../lib/modelChoices";
import type { ProviderName } from "../lib/wsProtocol";
import { cn } from "../lib/utils";
import { formatCost, formatTokenCount } from "../../../../src/session/pricing";
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

const FeedRow = memo(function FeedRow(props: { item: FeedItem }) {
  const { developerMode } = useChatViewContext();
  const item = props.item;

  if (item.kind === "message") {
    return (
      <Message from={item.role}>
        <MessageContent>
          {item.role === "assistant" ? (
            <MessageResponse>{item.text}</MessageResponse>
          ) : (
            <div className="whitespace-pre-wrap">{item.text}</div>
          )}
        </MessageContent>
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
  anthropic: "Anthropic",
  "codex-cli": "Codex CLI",
};

function ThreadModelSelector({
  threadId,
  provider,
  model,
  disabled
}: {
  threadId: string;
  provider: ProviderName;
  model: string;
  disabled?: boolean;
}) {
  const setThreadModel = useAppStore((s) => s.setThreadModel);
  const providers = (Object.keys(MODEL_CHOICES) as ProviderName[]).filter(p => !UI_DISABLED_PROVIDERS.has(p));
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
        {providers.map(p => (
          <SelectGroup key={p}>
            <SelectLabel className="text-xs font-semibold px-2 py-1.5">{PROVIDER_LABELS[p] ?? p}</SelectLabel>
            {MODEL_CHOICES[p].map(m => (
              <SelectItem key={`${p}:${m}`} value={`${p}:${m}`} className="text-xs pl-6">
                {m}
              </SelectItem>
            ))}
            {p === provider && model && !MODEL_CHOICES[p].includes(model) ? (
              <SelectItem key={`${p}:${model}`} value={`${p}:${model}`} className="text-xs pl-6">
                {model} (custom)
              </SelectItem>
            ) : null}
          </SelectGroup>
        ))}
      </SelectContent>
    </Select>
  );
}

export function ChatView() {
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
  const renderItems = useMemo(() => buildChatRenderItems(visibleFeed), [visibleFeed]);
  const contextValue = useMemo<ChatViewContextValue>(
    () => ({
      developerMode,
    }),
    [developerMode],
  );

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
    if (selectedThreadId && textareaRef.current) {
      textareaRef.current.focus();
    }
  }, [selectedThreadId]);


  const onComposerKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLTextAreaElement>) => {
      if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        void sendMessage(composerText);
      }
    },
    [composerText, sendMessage],
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
  const disabled = busy || hasPromptModal;
  const transcriptOnly = rt?.transcriptOnly === true;
  const disconnected = !transcriptOnly && thread.status !== "active";
  const modelSelectorConfig = visibleFeed.length === 0 && rt?.config?.provider && rt?.config?.model ? rt.config : null;
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

  const placeholder = transcriptOnly
    ? "Continue in a new thread..."
    : disconnected
      ? "Reconnect to continue..."
      : busy
        ? "Working..."
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
              <ConversationEmptyState
                icon={<MessageSquareIcon className="size-6" />}
                title="New thread"
                description="Send a message to start."
              />
            ) : (
              renderItems.map((item) =>
                item.kind === "activity-group" ? (
                  <ActivityGroupCard key={item.id} items={item.items} />
                ) : (
                  <FeedRow key={item.item.id} item={item.item} />
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
                void sendMessage(composerText);
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
                  {modelSelectorConfig ? (
                    <ThreadModelSelector
                      threadId={selectedThreadId}
                      provider={modelSelectorConfig.provider}
                      model={modelSelectorConfig.model}
                      disabled={busy}
                    />
                  ) : null}
                </PromptInputTools>
                <div className={cn("flex shrink-0 items-center gap-2", busy ? "opacity-100" : "opacity-70")}>
                  <span className="hidden max-w-[18rem] text-right text-xs leading-tight text-muted-foreground sm:block">
                    {busy ? "Agent is working..." : "Press Enter to send, Shift+Enter for newline."}
                  </span>
                  <PromptInputSubmit
                    status={busy ? "streaming" : "ready"}
                    disabled={disabled || !composerText.trim()}
                    onStop={() => cancelThread(selectedThreadId)}
                  />
                </div>
              </PromptInputFooter>
            </PromptInputForm>
          </PromptInputRoot>
        </div>
      </div>
    </ChatViewContext.Provider>
  );
}
