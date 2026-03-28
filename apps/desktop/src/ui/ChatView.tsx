import { createContext, memo, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import type { ChangeEvent, KeyboardEvent as ReactKeyboardEvent } from "react";

import { AlertTriangleIcon, LoaderCircleIcon, MessageSquareIcon, MicIcon, PlusIcon, RotateCcwIcon } from "lucide-react";
import coworkIconSvg from "../../build/icon.icon/Assets/svgviewer-output.svg";

import {
  buildAttachmentSignature,
  encodeArrayBufferToBase64,
  getAttachmentPickerValidationMessage,
  getAttachmentUploadValidationMessage,
} from "../app/attachmentInputs";
import { useAppStore } from "../app/store";
import { uploadJsonRpcWorkspaceFile } from "../app/store.helpers/jsonRpcSocket";
import type { FileAttachmentInput } from "../app/store.helpers/jsonRpcSocket";
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
  PromptInputAttachmentPreviews,
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
  MAX_ATTACHMENT_INLINE_BYTE_SIZE,
  MAX_TURN_ATTACHMENT_TOTAL_INLINE_BYTE_SIZE,
} from "../../../../src/shared/attachments";
import {
  availableProvidersFromCatalog,
  decodeProviderModelSelection,
  encodeProviderModelSelection,
  modelChoicesFromCatalog,
  modelDisplayNamesFromCatalog,
  resolveModelDisplayLabel,
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
  extractCitationUrlsFromAnnotations,
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
  hasPendingAttachments: boolean;
  pendingAttachmentSignature: string;
  pendingSteer: ThreadPendingSteer | null;
  sessionId: string | null;
  threadStatus: ThreadStatus;
}): { status: "ready" | "streaming"; disabled: boolean; mode: "send" | "steer-ready" | "steer-pending" } {
  const composerText = opts.composerText.trim();
  const hasComposerText = composerText.length > 0;
  const hasPendingInput = hasComposerText || opts.hasPendingAttachments;
  const steerPending = opts.busy
    && hasPendingInput
    && opts.pendingSteer?.status === "sending"
    && opts.pendingSteer.text.trim() === composerText;
  const samePendingAttachments =
    (opts.pendingSteer?.attachmentSignature ?? "") === opts.pendingAttachmentSignature;

  if (opts.busy && !hasPendingInput) {
    return {
      status: "streaming",
      disabled: opts.hasPromptModal || !opts.sessionId || opts.threadStatus !== "active",
      mode: "send",
    };
  }

  return {
    status: "ready",
    mode: opts.busy && steerPending && samePendingAttachments ? "steer-pending" : (opts.busy ? "steer-ready" : "send"),
    disabled:
      opts.hasPromptModal
      || !hasPendingInput
      || (steerPending && samePendingAttachments)
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

type PendingComposerAttachment = {
  filename: string;
  mimeType: string;
  size: number;
  file: File;
  previewUrl?: string;
  signature: string;
};

function buildPendingComposerAttachmentSignature(attachments: readonly PendingComposerAttachment[]): string {
  if (attachments.length === 0) {
    return "";
  }
  return attachments
    .map((attachment) => (
      `${attachment.filename}\u0000${attachment.mimeType}\u0000${attachment.signature}`
    ))
    .join("\u0001");
}

function createPendingComposerAttachment(file: File): PendingComposerAttachment {
  const previewUrl = file.type.startsWith("image/") && file instanceof Blob
    ? URL.createObjectURL(file)
    : undefined;
  return {
    filename: file.name,
    mimeType: file.type || "application/octet-stream",
    size: file.size,
    file,
    previewUrl,
    signature: `${file.name}\u0000${file.type}\u0000${file.size}\u0000${file.lastModified}`,
  };
}

function revokePendingComposerAttachmentPreview(attachment: PendingComposerAttachment) {
  if (attachment.previewUrl) {
    URL.revokeObjectURL(attachment.previewUrl);
  }
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
    <div className="pointer-events-none absolute top-0 left-0 right-0 z-10 flex items-start justify-center bg-gradient-to-b from-panel via-panel/88 to-transparent px-3 pt-2.5 pb-6">
      <div
        className={cn(
          "pointer-events-auto relative flex flex-col items-center outline-none",
          hasUsageSummary ? "group" : null,
        )}
        tabIndex={hasUsageSummary ? 0 : undefined}
      >
        <div
          className={cn(
            "max-w-lg truncate rounded-[calc(var(--radius)*1.35)] border border-border/45 bg-background/86 px-3 py-1 text-[13px] font-medium text-foreground shadow-none backdrop-blur-sm",
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
              "pointer-events-none absolute top-full mt-2 flex max-w-3xl flex-wrap items-center justify-center gap-2 rounded-[calc(var(--radius)*1.35)] border px-3 py-1 text-[11px] shadow-none backdrop-blur-sm opacity-0 -translate-y-1 transition-all duration-150 ease-out group-hover:pointer-events-auto group-hover:translate-y-0 group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:translate-y-0 group-focus-within:opacity-100",
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
                className="h-6 rounded-md px-2.5 text-[11px]"
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
  const hasInlineCitationChip = item.kind === "message"
    && item.role === "assistant"
    && extractCitationUrlsFromAnnotations(item.annotations).size > 0;

  if (item.kind === "message") {
    return (
      <Message from={item.role}>
        <MessageContent>
          {item.role === "assistant" ? (
            <MessageResponse
              citationAnnotations={item.annotations}
              citationSources={props.citationSources}
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
        {hasSources && !hasInlineCitationChip && (
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
  anthropic: "Anthropic",
  baseten: "Baseten",
  together: "Together AI",
  fireworks: "Fireworks AI",
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
  modelDisplayNames,
  disabled,
}: {
  threadId: string;
  provider: ProviderName;
  model: string;
  modelDisplayNames: Record<ProviderName, Record<string, string>>;
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
  const value = encodeProviderModelSelection(provider, model);

  return (
    <Select
      value={value}
      disabled={disabled}
      onValueChange={(val) => {
        const parsed = decodeProviderModelSelection(val);
        if (!parsed) return;
        setThreadModel(threadId, parsed.provider, parsed.modelId);
      }}
    >
      <SelectTrigger
        size="sm"
        className="h-6 w-auto min-w-0 max-w-[220px] rounded-md border-none bg-transparent px-1.5 text-[11px] text-muted-foreground shadow-none transition-colors hover:bg-muted/40 hover:text-foreground focus:ring-0"
      >
        <span className="truncate"><SelectValue placeholder="Model" /></span>
      </SelectTrigger>
      <SelectContent>
        {providers.map((p) => (
          <SelectGroup key={p}>
            <SelectLabel className="px-2 py-1.5 text-xs font-semibold">{PROVIDER_LABELS[p] ?? p}</SelectLabel>
            {(choices[p] ?? []).map((m) => {
              const sel = encodeProviderModelSelection(p, m);
              const label = resolveModelDisplayLabel(p, m, modelDisplayNames);
              return (
                <SelectItem key={sel} value={sel} className="pl-6 text-xs">
                  <span title={m}>{label}</span>
                </SelectItem>
              );
            })}
            {p === provider && model && !(choices[p] ?? []).includes(model) ? (
              <SelectItem
                key={encodeProviderModelSelection(p, model)}
                value={encodeProviderModelSelection(p, model)}
                className="pl-6 text-xs"
              >
                <span title={model}>{resolveModelDisplayLabel(p, model, modelDisplayNames)} (custom)</span>
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
  modelDisplayNames,
}: {
  provider: ProviderName;
  model: string;
  modelDisplayNames: Record<ProviderName, Record<string, string>>;
}) {
  const id = model.trim();
  if (!id) return null;
  const friendly = resolveModelDisplayLabel(provider, id, modelDisplayNames);
  const title =
    friendly !== id ? `${PROVIDER_LABELS[provider] ?? provider} / ${friendly} (${id})` : `${PROVIDER_LABELS[provider] ?? provider} / ${id}`;

  return (
    <Badge
      variant="outline"
      title={title}
      aria-label={`Session model ${title}`}
      className="h-8 max-w-[220px] rounded-none border-0 bg-transparent px-1.5 text-[13px] font-medium text-foreground/80 shadow-none"
    >
      <span className="truncate">{friendly}</span>
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
  const [pendingAttachments, setPendingAttachments] = useState<PendingComposerAttachment[]>([]);
  const [attachmentPickerError, setAttachmentPickerError] = useState<string | null>(null);
  const [preparingAttachments, setPreparingAttachments] = useState(false);
  const [submittedAttachmentSignature, setSubmittedAttachmentSignature] = useState<string | null>(null);

  const setComposerText = useAppStore((s) => s.setComposerText);
  const sendMessage = useAppStore((s) => s.sendMessage);
  const cancelThread = useAppStore((s) => s.cancelThread);
  const reconnectThread = useAppStore((s) => s.reconnectThread);
  const newThread = useAppStore((s) => s.newThread);

  const feedRef = useRef<HTMLDivElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const lastCountRef = useRef<number>(0);
  const autoScrolledThreadIdRef = useRef<string | null>(null);
  const pendingAttachmentsRef = useRef<PendingComposerAttachment[]>([]);

  useEffect(() => {
    pendingAttachmentsRef.current = pendingAttachments;
  }, [pendingAttachments]);

  useEffect(() => {
    return () => {
      pendingAttachmentsRef.current.forEach(revokePendingComposerAttachmentPreview);
    };
  }, []);

  const clearPendingAttachments = useCallback(() => {
    setPendingAttachments((current) => {
      current.forEach(revokePendingComposerAttachmentPreview);
      return [];
    });
    setSubmittedAttachmentSignature(null);
  }, []);

  useEffect(() => {
    clearPendingAttachments();
    setAttachmentPickerError(null);
    setPreparingAttachments(false);
  }, [clearPendingAttachments, selectedThreadId]);

  const ingestAttachmentFiles = useCallback(async (selectedFiles: File[]) => {
    if (selectedFiles.length === 0) return;

    const validationMessage = getAttachmentPickerValidationMessage(pendingAttachments, selectedFiles);
    if (validationMessage) {
      setAttachmentPickerError(validationMessage);
      return;
    }

    setAttachmentPickerError(null);
    setSubmittedAttachmentSignature(null);
    setPendingAttachments((prev) => [...prev, ...selectedFiles.map(createPendingComposerAttachment)]);
  }, [pendingAttachments]);

  const handleFileSelect = useCallback(
    async (event: ChangeEvent<HTMLInputElement>) => {
      const files = event.target.files;
      if (!files || files.length === 0) return;
      await ingestAttachmentFiles(Array.from(files));
      if (fileInputRef.current) fileInputRef.current.value = "";
    },
    [ingestAttachmentFiles],
  );

  const removeAttachment = useCallback((index: number) => {
    setAttachmentPickerError(null);
    setSubmittedAttachmentSignature(null);
    setPendingAttachments((prev) => {
      const next = [...prev];
      const [removed] = next.splice(index, 1);
      if (removed) {
        revokePendingComposerAttachmentPreview(removed);
      }
      return next;
    });
  }, []);

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
  const providerCatalog = useAppStore((s) => s.providerCatalog);
  const modelDisplayNames = useMemo(() => modelDisplayNamesFromCatalog(providerCatalog), [providerCatalog]);

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

  const resolvePendingAttachmentsForSend = useCallback(
    async (workspaceId: string, attachments: readonly PendingComposerAttachment[]): Promise<FileAttachmentInput[]> => {
      let inlineByteLength = 0;
      const resolvedAttachments: FileAttachmentInput[] = [];

      for (const attachment of attachments) {
        const uploadValidationMessage = getAttachmentUploadValidationMessage(attachment.size);
        if (uploadValidationMessage) {
          throw new Error(`${attachment.filename}: ${uploadValidationMessage}`);
        }
        const buffer = await attachment.file.arrayBuffer();
        const base64 = encodeArrayBufferToBase64(buffer);
        const canInline = (
          attachment.size <= MAX_ATTACHMENT_INLINE_BYTE_SIZE
          && inlineByteLength + attachment.size <= MAX_TURN_ATTACHMENT_TOTAL_INLINE_BYTE_SIZE
        );
        if (canInline) {
          inlineByteLength += attachment.size;
          resolvedAttachments.push({
            filename: attachment.filename,
            contentBase64: base64,
            mimeType: attachment.mimeType,
          });
          continue;
        }

        const uploaded = await uploadJsonRpcWorkspaceFile(
          useAppStore.getState,
          useAppStore.setState,
          workspaceId,
          attachment.filename,
          base64,
        );
        if (!uploaded.path) {
          throw new Error(`Failed to upload ${attachment.filename}`);
        }
        resolvedAttachments.push({
          filename: uploaded.filename,
          path: uploaded.path,
          mimeType: attachment.mimeType,
        });
      }

      return resolvedAttachments;
    },
    [],
  );

  const pendingAttachmentSignature = useMemo(
    () => submittedAttachmentSignature ?? buildPendingComposerAttachmentSignature(pendingAttachments),
    [pendingAttachments, submittedAttachmentSignature],
  );
  const hasPendingAttachments = pendingAttachments.length > 0;

  const submitComposer = useCallback((busyPolicy: "reject" | "steer") => {
    if (!thread) return;
    if (preparingAttachments) return;
    if (!composerText.trim() && pendingAttachments.length === 0) return;

    const targetThreadId = thread.id;
    const targetWorkspaceId = thread.workspaceId;
    setPreparingAttachments(true);
    setAttachmentPickerError(null);
    void (async () => {
      try {
        const attachments = pendingAttachments.length > 0
          ? await resolvePendingAttachmentsForSend(targetWorkspaceId, pendingAttachments)
          : undefined;
        const attachmentSignature = attachments && attachments.length > 0
          ? buildAttachmentSignature(attachments)
          : null;
        setSubmittedAttachmentSignature(attachmentSignature);

        if (useAppStore.getState().selectedThreadId !== targetThreadId) {
          setSubmittedAttachmentSignature(null);
          return;
        }

        const accepted = await sendMessage(composerText, busyPolicy, attachments);
        if (accepted && busyPolicy !== "steer") {
          clearPendingAttachments();
          setAttachmentPickerError(null);
          return;
        }
        if (!accepted) {
          setSubmittedAttachmentSignature(null);
        }
      } catch (error) {
        setSubmittedAttachmentSignature(null);
        const message = error instanceof Error ? error.message : String(error);
        setAttachmentPickerError(message);
      } finally {
        setPreparingAttachments(false);
      }
    })();
  }, [
    clearPendingAttachments,
    composerText,
    pendingAttachments,
    preparingAttachments,
    resolvePendingAttachmentsForSend,
    sendMessage,
    thread,
  ]);

  useEffect(() => {
    if (pendingAttachments.length === 0) return;
    if (rt?.pendingSteer?.status !== "accepted") return;
    if ((rt.pendingSteer.attachmentSignature ?? "") !== pendingAttachmentSignature) return;
    clearPendingAttachments();
    setAttachmentPickerError(null);
  }, [clearPendingAttachments, pendingAttachmentSignature, pendingAttachments.length, rt?.pendingSteer]);

  const onComposerKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLTextAreaElement>) => {
      if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        submitComposer(resolveComposerBusyPolicy(rt?.busy === true));
      }
    },
    [rt?.busy, submitComposer],
  );

  if (!selectedThreadId || !thread) {
    return (
      <div className="flex h-full items-center justify-center px-6">
        <div className="flex -translate-y-10 flex-col items-center justify-center gap-3.5 text-center">
          <img
            src={coworkIconSvg}
            alt=""
            aria-hidden="true"
            className="h-24 w-24 select-none object-contain opacity-95"
          />
          <h2 className="text-[2rem] font-semibold tracking-tight">Let&apos;s build</h2>
          <p className="max-w-xl text-sm text-muted-foreground">Pick a workspace and start a new thread.</p>
          <Button type="button" onClick={() => void newThread()}>New thread</Button>
        </div>
      </div>
    );
  }

  const busy = rt?.busy === true;
  const inputDisabled = hasPromptModal || preparingAttachments;
  const transcriptOnly = rt?.transcriptOnly === true;
  const hydrating = rt?.hydrating === true || (bootstrapPending && Boolean(selectedThreadId) && Boolean(thread) && rt === null);
  const disconnected = !hydrating && !transcriptOnly && thread.status !== "active";
  const composerSubmitState = getComposerSubmitState({
    busy,
    hasPromptModal: inputDisabled,
    composerText,
    hasPendingAttachments,
    pendingAttachmentSignature,
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
  const composerHint = composerBusyHint(composerSubmitState);

  return (
    <ChatViewContext.Provider value={contextValue}>
      <div className="relative flex h-full min-h-0 flex-col bg-panel">
        <Conversation className="min-h-0" ref={feedRef}>
          <ConversationContent className="pt-6">
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

        <div className="relative flex shrink-0 flex-col bg-panel px-4 pb-3 pt-2" style={{ height: messageBarHeight }}>
          <MessageBarResizer />
          <PromptInputRoot
            className="max-w-[70rem]"
            fileDrop={
              inputDisabled || transcriptOnly ? undefined : { onFiles: (files) => void ingestAttachmentFiles(files) }
            }
          >
            <PromptInputAttachmentPreviews
              attachments={pendingAttachments}
              onRemove={removeAttachment}
              className="px-0"
            />
            <PromptInputForm
              onSubmit={(event) => {
                event.preventDefault();
                submitComposer(resolveComposerBusyPolicy(busy));
              }}
            >
              <PromptInputBody>
                {attachmentPickerError ? (
                  <div className="flex items-center gap-1.5 px-1 pb-1 text-xs text-destructive">
                    <AlertTriangleIcon className="size-3.5 shrink-0" />
                    <span>{attachmentPickerError}</span>
                  </div>
                ) : null}
                <PromptInputTextarea
                  ref={textareaRef}
                  value={composerText}
                  disabled={inputDisabled}
                  placeholder={placeholder}
                  onChange={(event) => setComposerText(event.currentTarget.value)}
                  onKeyDown={onComposerKeyDown}
                  aria-label="Message input"
                />
              </PromptInputBody>
              {composerSubmitState.status === "streaming" || composerSubmitState.mode !== "send" ? (
                <div className="px-1 pb-1 text-[11px] text-muted-foreground">
                  {composerHint}
                </div>
              ) : null}
              <PromptInputFooter>
                <PromptInputTools>
                  <input
                    ref={fileInputRef}
                    type="file"
                    multiple
                    className="hidden"
                    onChange={handleFileSelect}
                  />
                  <button
                    type="button"
                    onClick={() => fileInputRef.current?.click()}
                    disabled={inputDisabled}
                    className="inline-flex size-9 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-muted/45 hover:text-foreground disabled:opacity-50"
                    aria-label="Attach files"
                    title="Attach files"
                  >
                    <PlusIcon className="h-4 w-4" />
                  </button>
                  {threadModelConfig ? (
                    thread.draft ? (
                      <DraftThreadModelSelector
                        threadId={selectedThreadId}
                        provider={threadModelConfig.provider}
                        model={threadModelConfig.model}
                        modelDisplayNames={modelDisplayNames}
                        disabled={inputDisabled}
                      />
                    ) : (
                      <ThreadModelIndicator
                        provider={threadModelConfig.provider}
                        model={threadModelConfig.model}
                        modelDisplayNames={modelDisplayNames}
                      />
                    )
                  ) : null}
                </PromptInputTools>
                <div className={cn("flex shrink-0 items-center gap-2", busy ? "opacity-100" : "opacity-80")}>
                  <button
                    type="button"
                    disabled
                    aria-label="Voice input unavailable"
                    title="Voice input unavailable"
                    className="hidden size-9 items-center justify-center rounded-full text-muted-foreground/70 sm:inline-flex"
                  >
                    <MicIcon className="size-4" />
                  </button>
                  <PromptInputSubmit
                    mode={composerSubmitState.mode}
                    status={composerSubmitState.status}
                    disabled={composerSubmitState.disabled || preparingAttachments}
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
