import { createContext, memo, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";

import { AlertTriangleIcon, RotateCcwIcon } from "lucide-react";

import { useAppStore } from "../app/store";
import type { FeedItem } from "../app/types";
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
  PromptInputForm,
  PromptInputRoot,
  PromptInputSubmit,
  PromptInputTextarea,
} from "../components/ai-elements/prompt-input";
import {
  Reasoning,
  ReasoningContent,
  ReasoningTrigger,
} from "../components/ai-elements/reasoning";
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

const ReasoningFeedItem = memo(function ReasoningFeedItem(props: { item: Extract<FeedItem, { kind: "reasoning" }> }) {
  const [expanded, setExpanded] = useState(false);
  const label = reasoningLabelForMode(props.item.mode);

  return (
    <Reasoning open={expanded} onOpenChange={setExpanded}>
      <ReasoningTrigger label={label} />
      <ReasoningContent>{props.item.text}</ReasoningContent>
    </Reasoning>
  );
});

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
    return <ReasoningFeedItem item={item} />;
  }

  if (item.kind === "todos") {
    return null;
  }

  if (item.kind === "tool") {
    return (
      <ToolCard
        name={item.name}
        args={item.args}
        result={item.result}
        status={item.status}
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
      <SelectTrigger className="h-7 text-xs w-auto max-w-[200px] px-2.5 bg-transparent border-none shadow-none focus:ring-0 text-muted-foreground hover:text-foreground hover:bg-muted/50 transition-colors">
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
  const reconnectThread = useAppStore((s) => s.reconnectThread);
  const newThread = useAppStore((s) => s.newThread);

  const feedRef = useRef<HTMLDivElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const lastCountRef = useRef<number>(0);
  const autoScrolledThreadIdRef = useRef<string | null>(null);

  const feed = rt?.feed ?? [];
  const normalizedFeed = normalizeFeedForToolCards(feed, developerMode);
  const visibleFeed = filterFeedForDeveloperMode(normalizedFeed, developerMode);
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
      <div className="flex h-full flex-col items-center justify-center gap-4 px-6 text-center">
        <div className="h-14 w-14 rounded-2xl border border-border/80 bg-gradient-to-br from-primary/35 to-transparent" />
        <h2 className="text-3xl font-semibold tracking-tight">Let&apos;s build</h2>
        <p className="max-w-xl text-muted-foreground">Pick a workspace and start a new thread.</p>
        <Button type="button" onClick={() => void newThread()}>New thread</Button>
      </div>
    );
  }

  const busy = rt?.busy === true;
  const disabled = busy || hasPromptModal;
  const transcriptOnly = rt?.transcriptOnly === true;
  const disconnected = !transcriptOnly && thread.status !== "active";

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
        <div className="absolute top-0 left-0 right-0 z-10 flex items-center justify-center pointer-events-none p-3 pb-8 bg-gradient-to-b from-panel via-panel/80 to-transparent">
          <div className="bg-background/80 backdrop-blur-md px-4 py-1.5 rounded-full border border-border/50 shadow-sm text-sm font-medium text-foreground max-w-lg truncate pointer-events-auto">
            {thread.title || "New thread"}
          </div>
        </div>
        <Conversation className="min-h-0" ref={feedRef}>
          <ConversationContent className="pt-24">
            {transcriptOnly ? (
              <Card className="max-w-3xl border-border/70 bg-muted/30">
                <CardContent className="flex items-start gap-3 p-3">
                  <AlertTriangleIcon className="mt-0.5 h-4 w-4 text-primary" />
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
                    <RotateCcwIcon className="h-3.5 w-3.5" />
                    Reconnect
                  </Button>
                </CardContent>
              </Card>
            ) : null}

            {visibleFeed.length === 0 ? (
              <ConversationEmptyState
                title="New thread"
                description="Send a message to start."
              />
            ) : (
              visibleFeed.map((item) => <FeedRow key={item.id} item={item} />)
            )}
          </ConversationContent>
        </Conversation>

        <div className="relative border-t border-border/60 px-4 py-3 flex flex-col shrink-0" style={{ height: messageBarHeight }}>
          <MessageBarResizer />
          <PromptInputRoot>
            <PromptInputForm
              onSubmit={(event) => {
                event.preventDefault();
                if (!composerText.trim()) return;
                void sendMessage(composerText);
              }}
            >
              {visibleFeed.length === 0 && rt?.config?.provider && rt?.config?.model && (
                <div className="flex items-center self-end mb-1.5 ml-1">
                  <ThreadModelSelector
                    threadId={selectedThreadId}
                    provider={rt.config.provider}
                    model={rt.config.model}
                    disabled={busy}
                  />
                  <div className="w-px h-5 bg-border/60 ml-1.5 mr-1" />
                </div>
              )}
              <PromptInputTextarea
                value={composerText}
                disabled={disabled}
                placeholder={placeholder}
                onChange={setComposerText}
                onKeyDown={onComposerKeyDown}
                textareaRef={textareaRef}
              />
              <PromptInputSubmit
                busy={busy}
                disabled={disabled || !composerText.trim()}
                onStop={() => cancelThread(selectedThreadId)}
              />
            </PromptInputForm>
          </PromptInputRoot>
          <div className={cn("mx-auto mt-2 max-w-3xl shrink-0 text-center text-xs text-muted-foreground", busy ? "opacity-100" : "opacity-70")}>
            {busy ? "Agent is working..." : "Press Enter to send, Shift+Enter for newline."}
          </div>
        </div>
      </div>
    </ChatViewContext.Provider>
  );
}
