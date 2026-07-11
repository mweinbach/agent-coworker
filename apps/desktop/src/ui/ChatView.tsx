import { defaultModelForProvider } from "@cowork/providers/catalog";
import { LockKeyholeIcon } from "lucide-react";
import type { ChangeEvent, KeyboardEvent as ReactKeyboardEvent, ReactNode } from "react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { CitationSource } from "../../../../src/shared/displayCitationMarkers";
import {
  buildCitationOverflowFilePathsByMessageId,
  buildCitationSourcesByMessageId,
  buildCitationUrlsByMessageId,
} from "../../../../src/shared/displayCitationMarkers";
import {
  composerDraftKeyForThread,
  getComposerDraftAttachmentValidationMessage,
  hasComposerDraftState,
  resolveActiveComposerDraftKey,
  selectActiveComposerDraft,
} from "../app/composerDrafts";
import { selectActiveComposerSubmission } from "../app/composerSubmission";
import {
  getWorkspaceGoogleReasoningEffort,
  type ReasoningEffortValue,
} from "../app/openaiCompatibleProviderOptions";
import {
  isSandboxApprovalThreadVisible,
  resolveSandboxApprovalThreadTarget,
} from "../app/sandboxApprovalVisibility";
import { useAppStore } from "../app/store";
import { workspaceSupportsToolRetryLineage } from "../app/store.helpers/jsonRpcSocket";
import { Button } from "../components/ui/button";
import { buildComposerAttachmentSignature } from "../lib/composerAttachments";
import { modelDisplayNamesFromCatalog, reasoningConfigFromCatalog } from "../lib/modelChoices";
import type { ProviderName } from "../lib/wsProtocol";
import { buildChatRenderItems, shouldShowWorkingPlaceholder } from "./chat/activityGroups";
import { CancelSubagentsDialog } from "./chat/CancelSubagentsDialog";
import { ChatComposer } from "./chat/ChatComposer";
import { ChatFeed, type VisibleSandboxApproval } from "./chat/ChatFeed";
import { ChatViewContext } from "./chat/ChatViewContext";
import { isChatProviderName } from "./chat/ComposerModelSelector";
import {
  composerBusyHint,
  countActiveChildAgents,
  filterFeedForDeveloperMode,
  getComposerSubmitState,
  resolveCurrentReasoningEffort,
} from "./chat/chatLogic";
import { HIDDEN_RETRY_TURN_PROMPT, isHiddenRetryTurnMessage } from "./chat/chatRetry";
import { buildMentionCatalog, extractReferencesFromText } from "./chat/composerMentions";
import { selectFeedDerivationWindow } from "./chat/feedWindow";
import { NewChatLanding } from "./chat/NewChatLanding";
import { loadOverflowCitationContext } from "./chat/overflowCitationContext";
import { normalizeFeedForToolCards } from "./chat/toolCards/legacyToolLogs";
import { recordDesktopRenderMetric } from "./renderDiagnostics";

// Compact-state floor for the feed's bottom reservation and the composer
// overlay's min-height. The composer auto-grows and a ResizeObserver measures
// its real height, so this is only a floor — it must NOT scale with the resizer
// cap (messageBarHeight), or raising the cap would over-reserve empty feed space
// above a short bar.
const COMPOSER_OVERLAY_MIN_HEIGHT_PX = 140;
const FEED_DERIVATION_WINDOW = 80;
const FEED_DERIVATION_EXPAND_BATCH = 40;
// Stable empty reference so the sandbox-approvals selector doesn't allocate a new
// array each render (which would defeat zustand's reference equality check).
const EMPTY_SANDBOX_APPROVALS: VisibleSandboxApproval[] = [];
const ACTIVE_TASK_STATUSES = new Set([
  "draft",
  "planning",
  "working",
  "blocked",
  "awaiting_review",
]);

export {
  canClearSessionHardCap,
  composerBusyHint,
  countActiveChildAgents,
  filterFeedForDeveloperMode,
  formatSessionBudgetLine,
  formatSessionUsageHeadline,
  getComposerSubmitState,
  reasoningLabelForMode,
  reasoningPreviewText,
  resolveCurrentReasoningEffort,
  sessionUsageTone,
  shouldToggleReasoningExpanded,
} from "./chat/chatLogic";
export { loadOverflowCitationContext } from "./chat/overflowCitationContext";

type ChatViewReadOnlyNotice = {
  id?: string;
  title: string;
  detail: string;
  action?: {
    label: string;
    pendingLabel?: string;
    pending?: boolean;
    disabled?: boolean;
    icon?: ReactNode;
    pendingIcon?: ReactNode;
    onClick: () => void;
  };
};

type ChatViewProps = {
  readOnlyNotice?: ChatViewReadOnlyNotice;
};

export function ChatView({ readOnlyNotice }: ChatViewProps = {}) {
  const bootstrapPhase = useAppStore((s) => s.bootstrapPhase);
  const selectedThreadId = useAppStore((s) => s.selectedThreadId);
  const thread = useAppStore((s) => {
    if (!s.selectedThreadId) return null;
    return s.threads.find((t) => t.id === s.selectedThreadId) ?? null;
  });
  const rt = useAppStore((s) => {
    if (!s.selectedThreadId) return null;
    return s.threadRuntimeById[s.selectedThreadId] ?? null;
  });
  const composerDraft = useAppStore(selectActiveComposerDraft);
  const composerSubmission = useAppStore(selectActiveComposerSubmission);
  const composerDraftKey = useAppStore(resolveActiveComposerDraftKey);
  const attachmentIngestionPending = useAppStore(
    (state) => (state.composerAttachmentIngestionCountByKey[composerDraftKey] ?? 0) > 0,
  );
  const composerText = composerDraft.text;
  const pendingAttachments = composerDraft.attachments;
  const composerWorkspaceId = thread?.workspaceId ?? "";
  const workspaceSkills = useAppStore((s) => s.workspaceRuntimeById[composerWorkspaceId]?.skills);
  const workspacePluginsCatalog = useAppStore(
    (s) => s.workspaceRuntimeById[composerWorkspaceId]?.pluginsCatalog ?? null,
  );
  const mentionCatalog = useMemo(
    () => buildMentionCatalog(workspaceSkills, workspacePluginsCatalog),
    [workspaceSkills, workspacePluginsCatalog],
  );
  const hasPromptModal = useAppStore((s) => s.promptModal !== null);
  const view = useAppStore((s) => s.view);
  const selectedTaskId = useAppStore((s) => s.selectedTaskId);
  const allThreads = useAppStore((s) => s.threads);
  const tasksById = useAppStore((s) => s.tasksById);
  const sandboxApprovalsByThread = useAppStore((s) => s.sandboxApprovalsByThread);
  const sandboxApprovals = useMemo(() => {
    const entries = Object.entries(sandboxApprovalsByThread);
    if (entries.length === 0) return EMPTY_SANDBOX_APPROVALS;

    const visibilityContext = {
      view,
      selectedTaskId,
      selectedThreadId,
      threads: allThreads,
      tasksById,
    };

    const visible: VisibleSandboxApproval[] = [];
    if (selectedThreadId && isSandboxApprovalThreadVisible(visibilityContext, selectedThreadId)) {
      const selectedPrompts = sandboxApprovalsByThread[selectedThreadId] ?? [];
      for (const prompt of selectedPrompts) {
        visible.push({ threadId: selectedThreadId, prompt });
      }
    }
    for (const [threadId, prompts] of entries) {
      if (
        threadId === selectedThreadId ||
        !isSandboxApprovalThreadVisible(visibilityContext, threadId)
      ) {
        continue;
      }
      for (const prompt of prompts) {
        visible.push({ threadId, prompt });
      }
    }

    return visible.length > 0 ? visible : EMPTY_SANDBOX_APPROVALS;
  }, [allThreads, sandboxApprovalsByThread, selectedTaskId, selectedThreadId, tasksById, view]);
  const answerApproval = useAppStore((s) => s.answerApproval);
  const selectThread = useAppStore((s) => s.selectThread);
  const selectTask = useAppStore((s) => s.selectTask);
  const selectTaskThread = useAppStore((s) => s.selectTaskThread);
  const selectApprovalThread = useCallback(
    (threadId: string) => {
      const target = resolveSandboxApprovalThreadTarget(
        { selectedThreadId, threads: allThreads, tasksById },
        threadId,
      );
      if (target?.kind === "task") {
        if (target.taskThreadId) {
          void selectTaskThread(target.taskId, target.taskThreadId);
        } else {
          void selectTask(target.taskId);
        }
        return;
      }
      if (target?.kind === "chat") void selectThread(threadId);
    },
    [allThreads, selectTask, selectTaskThread, selectThread, selectedThreadId, tasksById],
  );
  const threadTitleById = useMemo(() => {
    const onlyOtherThreads = sandboxApprovals.some((a) => a.threadId !== selectedThreadId);
    if (!onlyOtherThreads) return undefined;
    const map = new Map<string, string>();
    for (const t of allThreads) map.set(t.id, t.title);
    return map;
  }, [allThreads, sandboxApprovals, selectedThreadId]);
  const hasFilePreview = useAppStore((s) => s.filePreview !== null);
  const developerMode = useAppStore((s) => s.developerMode);
  const messageBarHeight = useAppStore((s) => s.messageBarHeight);
  const composerOverlayMinHeight = COMPOSER_OVERLAY_MIN_HEIGHT_PX;
  const [overflowCitationUrlsByMessageId, setOverflowCitationUrlsByMessageId] = useState<
    Map<string, Map<number, string>>
  >(() => new Map());
  const [overflowCitationSourcesByMessageId, setOverflowCitationSourcesByMessageId] = useState<
    Map<string, CitationSource[]>
  >(() => new Map());
  const [cancelScopeDialogOpen, setCancelScopeDialogOpen] = useState(false);
  const [attachmentPickerErrors, setAttachmentPickerErrors] = useState<Record<string, string>>({});
  const [composerOverlayHeight, setComposerOverlayHeight] = useState(composerOverlayMinHeight);
  const attachmentPickerError = attachmentPickerErrors[composerDraftKey] ?? null;
  const preparingAttachments = composerSubmission?.phase === "preparing";
  const setAttachmentPickerError = useCallback(
    (message: string | null) => {
      setAttachmentPickerErrors((current) => {
        if (message === null) {
          if (!(composerDraftKey in current)) return current;
          const next = { ...current };
          delete next[composerDraftKey];
          return next;
        }
        return { ...current, [composerDraftKey]: message };
      });
    },
    [composerDraftKey],
  );
  const [feedDerivationWindow, setFeedDerivationWindow] = useState({
    threadId: selectedThreadId,
    visibleCount: FEED_DERIVATION_WINDOW,
  });

  const pendingTurnStart = rt?.pendingTurnStart ?? null;
  const isUploading =
    composerSubmission?.phase === "preparing" ||
    composerSubmission?.phase === "sending" ||
    pendingTurnStart?.status === "sending";

  const setComposerText = useAppStore((s) => s.setComposerText);
  const updateComposerText = useCallback(
    (text: string) => {
      setComposerText(text, extractReferencesFromText(text, mentionCatalog));
    },
    [mentionCatalog, setComposerText],
  );
  const addComposerAttachments = useAppStore((s) => s.addComposerAttachments);
  const removeComposerAttachment = useAppStore((s) => s.removeComposerAttachment);
  const sendMessage = useAppStore((s) => s.sendMessage);
  const submitComposerDraft = useAppStore((s) => s.submitComposerDraft);
  const retryComposerSubmission = useAppStore((s) => s.retryComposerSubmission);
  const editAcceptedComposerSubmission = useAppStore((s) => s.editAcceptedComposerSubmission);
  const dismissComposerSubmission = useAppStore((s) => s.dismissComposerSubmission);
  const cancelThread = useAppStore((s) => s.cancelThread);
  const setThreadReasoningEffort = useAppStore((s) => s.setThreadReasoningEffort);
  const taskSummariesByWorkspaceId = useAppStore((s) => s.taskSummariesByWorkspaceId);
  const sourceTask = useMemo(() => {
    if (!selectedThreadId) return null;
    const record = Object.values(tasksById).find(
      (task) => task.sourceSessionId === selectedThreadId && ACTIVE_TASK_STATUSES.has(task.status),
    );
    if (record) return { id: record.id, title: record.title };
    for (const summaries of Object.values(taskSummariesByWorkspaceId)) {
      const summary = summaries.find(
        (task) =>
          task.sourceSessionId === selectedThreadId && ACTIVE_TASK_STATUSES.has(task.status),
      );
      if (summary) return { id: summary.id, title: summary.title };
    }
    return null;
  }, [selectedThreadId, taskSummariesByWorkspaceId, tasksById]);

  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [messageBarOverlayElement, setMessageBarOverlayElement] = useState<HTMLDivElement | null>(
    null,
  );
  const messageBarOverlayRef = useCallback((element: HTMLDivElement | null) => {
    setMessageBarOverlayElement(element);
  }, []);
  useLayoutEffect(() => {
    const el = messageBarOverlayElement;
    if (!el) {
      // Source-task lock bar is in-flow (not absolute), so the feed must not
      // also reserve overlay space — that double-counts bottom chrome.
      setComposerOverlayHeight(sourceTask && !readOnlyNotice ? 0 : composerOverlayMinHeight);
      return;
    }

    const updateHeight = () => {
      const measuredHeight = Math.ceil(el.getBoundingClientRect().height);
      const nextHeight = Math.max(composerOverlayMinHeight, measuredHeight);
      setComposerOverlayHeight((current) => (current === nextHeight ? current : nextHeight));
    };

    updateHeight();

    const ResizeObserverCtor = globalThis.ResizeObserver;
    if (!ResizeObserverCtor) return;

    const observer = new ResizeObserverCtor(updateHeight);
    observer.observe(el);
    return () => observer.disconnect();
  }, [composerOverlayMinHeight, messageBarOverlayElement, readOnlyNotice, sourceTask]);

  const ingestAttachmentFiles = useCallback(
    async (selectedFiles: File[]) => {
      if (selectedFiles.length === 0) return;

      const validationMessage = getComposerDraftAttachmentValidationMessage(
        useAppStore.getState().composerDraftsByKey,
        composerDraftKey,
        selectedFiles,
      );
      if (validationMessage) {
        setAttachmentPickerError(validationMessage);
        return;
      }

      setAttachmentPickerError(null);
      try {
        await addComposerAttachments(selectedFiles);
      } catch (error) {
        setAttachmentPickerError(error instanceof Error ? error.message : String(error));
      }
    },
    [addComposerAttachments, composerDraftKey, setAttachmentPickerError],
  );

  const handleFileSelect = useCallback(
    async (event: ChangeEvent<HTMLInputElement>) => {
      const files = event.target.files;
      if (!files || files.length === 0) return;
      await ingestAttachmentFiles(Array.from(files));
      if (fileInputRef.current) fileInputRef.current.value = "";
    },
    [ingestAttachmentFiles],
  );

  const removeAttachment = useCallback(
    (index: number) => {
      setAttachmentPickerError(null);
      removeComposerAttachment(index);
    },
    [removeComposerAttachment, setAttachmentPickerError],
  );

  const feed = rt?.feed ?? [];
  const feedDerivationVisibleCount =
    feedDerivationWindow.threadId === selectedThreadId
      ? feedDerivationWindow.visibleCount
      : FEED_DERIVATION_WINDOW;
  const windowedSourceFeed = useMemo(
    () => selectFeedDerivationWindow(feed, feedDerivationVisibleCount),
    [feed, feedDerivationVisibleCount],
  );
  recordDesktopRenderMetric(
    "feed-derivation",
    selectedThreadId ?? undefined,
    windowedSourceFeed.feed.length,
  );
  const expandOlderFeed = useCallback(() => {
    setFeedDerivationWindow((current) => {
      const currentVisibleCount =
        current.threadId === selectedThreadId ? current.visibleCount : FEED_DERIVATION_WINDOW;
      return {
        threadId: selectedThreadId,
        visibleCount: Math.min(feed.length, currentVisibleCount + FEED_DERIVATION_EXPAND_BATCH),
      };
    });
  }, [feed.length, selectedThreadId]);
  const showAllOlderFeed = useCallback(() => {
    setFeedDerivationWindow({ threadId: selectedThreadId, visibleCount: feed.length });
  }, [feed.length, selectedThreadId]);
  const normalizedFeed = useMemo(
    () => normalizeFeedForToolCards(windowedSourceFeed.feed, developerMode),
    [developerMode, windowedSourceFeed.feed],
  );
  const visibleFeed = useMemo(() => {
    return filterFeedForDeveloperMode(normalizedFeed, developerMode).filter(
      (item) => !isHiddenRetryTurnMessage(item),
    );
  }, [developerMode, normalizedFeed]);
  const inlineCitationUrlsByMessageId = useMemo(
    () => buildCitationUrlsByMessageId(visibleFeed),
    [visibleFeed],
  );
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
  const inlineCitationSourcesByMessageId = useMemo(
    () => buildCitationSourcesByMessageId(visibleFeed),
    [visibleFeed],
  );
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
  const liveActivityGroupId = useMemo(() => {
    if (rt?.busy !== true) return null;
    for (let i = renderItems.length - 1; i >= 0; i--) {
      const entry = renderItems[i];
      if (entry?.kind === "activity-group") {
        return entry.id;
      }
    }
    return null;
  }, [renderItems, rt?.busy]);
  const streamingAssistantMessageId = useMemo(() => {
    if (rt?.busy !== true) return null;
    for (let i = renderItems.length - 1; i >= 0; i--) {
      const entry = renderItems[i];
      if (!entry) continue;
      if (entry.kind === "activity-group") continue;
      if (entry.item.kind === "message" && entry.item.role === "assistant") {
        return entry.item.id;
      }
      if (entry.item.kind === "message" && entry.item.role === "user") {
        return null;
      }
    }
    return null;
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
  const activeChildAgentCount = useMemo(
    () => countActiveChildAgents(rt?.agents ?? []),
    [rt?.agents],
  );
  const contextValue = useMemo(
    () => ({
      developerMode,
      mentionCatalog,
    }),
    [developerMode, mentionCatalog],
  );

  const workspace = useAppStore((s) => {
    if (!s.selectedThreadId) return null;
    const th = s.threads.find((t) => t.id === s.selectedThreadId);
    if (!th) return null;
    return s.workspaces.find((w) => w.id === th.workspaceId) ?? null;
  });
  const providerCatalog = useAppStore((s) => s.providerCatalog);
  const modelDisplayNames = useMemo(
    () => modelDisplayNamesFromCatalog(providerCatalog),
    [providerCatalog],
  );

  const threadModelConfig = useMemo(() => {
    if (!selectedThreadId || !thread) return null;
    if (!rt || rt.sessionKind === "agent") return null;
    if (rt.transcriptOnly === true) return null;

    const resolveConfig = (provider: ProviderName, model: string) => {
      const reasoningConfig = reasoningConfigFromCatalog(providerCatalog, provider, model);
      if (!reasoningConfig) return { provider, model, reasoning: null };
      const providerOptions = thread.draft
        ? workspace?.providerOptions
        : rt.sessionConfig?.providerOptions;
      const configuredEffort =
        provider === "openai" || provider === "codex-cli"
          ? providerOptions?.[provider]?.reasoningEffort
          : provider === "google"
            ? getWorkspaceGoogleReasoningEffort(providerOptions, model)
            : undefined;
      const runtimeEffort =
        !thread.draft && (provider === "openai" || provider === "codex-cli")
          ? (rt.effectiveReasoningEffort ?? rt.requestedReasoningEffort)
          : undefined;
      const currentEffort = resolveCurrentReasoningEffort({
        composerEffort: rt.composerReasoningEffort,
        configuredEffort,
        runtimeEffort,
        defaultEffort: reasoningConfig.defaultEffort,
      });
      return {
        provider,
        model,
        reasoning: {
          value: currentEffort as ReasoningEffortValue,
          options: reasoningConfig.availableEfforts,
        },
      };
    };

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
      return resolveConfig(provider, modelRaw);
    }

    if (rt.config?.provider && rt.config.model) {
      return resolveConfig(rt.config.provider as ProviderName, rt.config.model);
    }
    return null;
  }, [providerCatalog, selectedThreadId, thread, rt, workspace]);

  const handleReasoningEffortChange = useCallback(
    (effort: ReasoningEffortValue) => {
      if (!selectedThreadId || !threadModelConfig?.reasoning) return;
      setThreadReasoningEffort(selectedThreadId, threadModelConfig.provider, effort);
    },
    [selectedThreadId, setThreadReasoningEffort, threadModelConfig],
  );

  const handleStop = useCallback(() => {
    if (!selectedThreadId) return;
    if (activeChildAgentCount > 0) {
      setCancelScopeDialogOpen(true);
      return;
    }
    cancelThread(selectedThreadId);
  }, [activeChildAgentCount, cancelThread, selectedThreadId]);

  const cancelWithScope = useCallback(
    (includeSubagents: boolean) => {
      if (!selectedThreadId) return;
      cancelThread(selectedThreadId, { includeSubagents });
      setCancelScopeDialogOpen(false);
    },
    [cancelThread, selectedThreadId],
  );

  useEffect(() => {
    let cancelled = false;

    const entries = [...citationOverflowFilePathsByMessageId.entries()];
    if (entries.length === 0) {
      setOverflowCitationUrlsByMessageId((current) => (current.size === 0 ? current : new Map()));
      setOverflowCitationSourcesByMessageId((current) =>
        current.size === 0 ? current : new Map(),
      );
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

  const didAutoFocusRef = useRef(false);
  useEffect(() => {
    // Focus the composer once on first mount so the user can type immediately,
    // but don't steal focus on every thread switch (that disrupts reading
    // history and races the scroll-restore below).
    if (selectedThreadId && !didAutoFocusRef.current && textareaRef.current) {
      textareaRef.current.focus();
      didAutoFocusRef.current = true;
    }
  }, [selectedThreadId]);

  useEffect(() => {
    if (!rt?.busy || activeChildAgentCount === 0) {
      setCancelScopeDialogOpen(false);
    }
  }, [activeChildAgentCount, rt?.busy]);

  const pendingAttachmentSignature = useMemo(
    () => buildComposerAttachmentSignature(pendingAttachments),
    [pendingAttachments],
  );
  const hasPendingAttachments = pendingAttachments.length > 0;

  const submitComposer = useCallback(() => {
    if (!thread) return;
    setAttachmentPickerError(null);
    submitComposerDraft({ kind: "thread", threadId: thread.id });
  }, [setAttachmentPickerError, submitComposerDraft, thread]);
  const retrySubmission = useCallback(() => {
    retryComposerSubmission(composerDraftKey);
  }, [composerDraftKey, retryComposerSubmission]);
  const editAcceptedSubmission = useCallback(() => {
    if (!editAcceptedComposerSubmission(composerDraftKey)) return;
    requestAnimationFrame(() => textareaRef.current?.focus());
  }, [composerDraftKey, editAcceptedComposerSubmission]);
  const dismissSubmission = useCallback(() => {
    dismissComposerSubmission(composerDraftKey);
  }, [composerDraftKey, dismissComposerSubmission]);

  const onComposerKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLTextAreaElement>) => {
      const isComposing =
        event.nativeEvent.isComposing ||
        // keyCode 229 is the classic IME composition signal (some browsers still rely on it).
        event.nativeEvent.keyCode === 229;

      if (
        event.key === "Enter" &&
        !event.shiftKey &&
        !event.metaKey &&
        !event.ctrlKey &&
        !event.altKey
      ) {
        if (isComposing) return;

        const busy = rt?.busy === true;
        const hasPendingInput = Boolean(composerText.trim() || pendingAttachments.length > 0);
        const submitState = getComposerSubmitState({
          busy,
          hasPromptModal:
            hasPromptModal ||
            hasFilePreview ||
            attachmentIngestionPending ||
            sourceTask !== null ||
            readOnlyNotice !== undefined,
          composerText,
          hasPendingAttachments: pendingAttachments.length > 0,
          pendingAttachmentSignature,
          pendingTurnStart,
          pendingSteer: rt?.pendingSteer ?? null,
          submission: composerSubmission,
          sessionId: rt?.sessionId ?? null,
          threadStatus: thread?.status ?? "active",
        });
        if (submitState.disabled || !hasPendingInput) {
          event.preventDefault();
          return;
        }

        event.preventDefault();
        submitComposer();
      } else if (event.key === "Enter" && (event.metaKey || event.ctrlKey) && !isComposing) {
        event.preventDefault();
        const textarea = event.currentTarget;
        const start = textarea.selectionStart;
        const end = textarea.selectionEnd;
        const value = textarea.value;
        const newValue = `${value.substring(0, start)}\n${value.substring(end)}`;
        updateComposerText(newValue);
        requestAnimationFrame(() => {
          textarea.selectionStart = textarea.selectionEnd = start + 1;
        });
      }
    },
    [
      composerText,
      composerSubmission,
      attachmentIngestionPending,
      hasFilePreview,
      hasPromptModal,
      pendingAttachmentSignature,
      pendingAttachments.length,
      pendingTurnStart,
      readOnlyNotice,
      rt?.busy,
      rt?.pendingSteer,
      rt?.sessionId,
      sourceTask,
      submitComposer,
      thread?.status,
      updateComposerText,
    ],
  );

  const retryFailedTurn = useCallback(
    async (toolItemIds: string[]): Promise<boolean> => {
      if (!thread || useAppStore.getState().selectedThreadId !== thread.id) return false;
      if (toolItemIds.length === 0) return false;
      if (!workspaceSupportsToolRetryLineage(thread.workspaceId)) return false;
      const draftKey = composerDraftKeyForThread(thread.id);
      const draftBeforeRetry = useAppStore.getState().composerDraftsByKey[draftKey]?.text ?? "";
      const accepted = await sendMessage(HIDDEN_RETRY_TURN_PROMPT, "reject", undefined, undefined, {
        targetThreadId: thread.id,
        retryToolItemIds: toolItemIds,
      });
      const stateAfterRetry = useAppStore.getState();
      if (
        accepted &&
        draftBeforeRetry &&
        stateAfterRetry.selectedThreadId === thread.id &&
        (stateAfterRetry.composerDraftsByKey[draftKey]?.text ?? "") === ""
      ) {
        setComposerText(draftBeforeRetry);
      }
      return accepted;
    },
    [sendMessage, setComposerText, thread],
  );

  if (!selectedThreadId || !thread) {
    return <NewChatLanding />;
  }

  const busy = rt?.busy === true;
  const inputDisabled =
    hasPromptModal || hasFilePreview || sourceTask !== null || readOnlyNotice !== undefined;
  const transcriptOnly = rt?.transcriptOnly === true;
  const hydrating =
    rt?.hydrating === true ||
    (bootstrapPhase === "loading" && Boolean(selectedThreadId) && Boolean(thread) && rt === null);
  const supportsToolRetryLineage =
    workspace !== null && workspaceSupportsToolRetryLineage(workspace.id);
  const retryUnavailableReason =
    !supportsToolRetryLineage &&
    !hydrating &&
    !transcriptOnly &&
    thread.status === "active" &&
    workspace !== null
      ? "Exact retry isn’t available with this server."
      : undefined;
  const disconnected = !hydrating && !transcriptOnly && thread.status !== "active";
  const modelSelectorDisabled =
    !threadModelConfig ||
    inputDisabled ||
    (thread.draft !== true &&
      (busy ||
        hydrating ||
        transcriptOnly ||
        thread.status !== "active" ||
        rt?.sessionKind === "agent" ||
        !rt?.sessionId));
  const composerSubmitState = getComposerSubmitState({
    busy,
    hasPromptModal: inputDisabled || attachmentIngestionPending,
    composerText,
    hasPendingAttachments,
    pendingAttachmentSignature,
    pendingTurnStart,
    pendingSteer: rt?.pendingSteer ?? null,
    submission: composerSubmission,
    sessionId: rt?.sessionId ?? null,
    threadStatus: thread.status,
  });

  const placeholder = transcriptOnly
    ? "Continue in a new thread..."
    : disconnected
      ? "Reconnect to continue..."
      : busy
        ? "Steer..."
        : pendingTurnStart
          ? "Sending..."
          : "Message...";
  const composerHint = composerBusyHint(composerSubmitState);

  return (
    <ChatViewContext.Provider value={contextValue}>
      <div className="relative flex h-full min-h-0 flex-col bg-panel">
        <ChatFeed
          transcriptOnly={transcriptOnly}
          disconnected={disconnected}
          visibleFeedLength={visibleFeed.length}
          hydrating={hydrating}
          renderItems={renderItems}
          liveActivityGroupId={liveActivityGroupId}
          liveStartedAt={rt?.busySince ?? null}
          showWorkingPlaceholder={workingPlaceholderVisible}
          streamingAssistantMessageId={streamingAssistantMessageId}
          citationUrlsByMessageId={citationUrlsByMessageId}
          citationSourcesByMessageId={citationSourcesByMessageId}
          desktopBasePath={workspace?.path ?? null}
          composerOverlayHeight={composerOverlayHeight}
          sandboxApprovals={sandboxApprovals}
          onAnswerApproval={answerApproval}
          selectedThreadId={selectedThreadId}
          threadTitleById={threadTitleById}
          onSelectThread={selectApprovalThread}
          onRetryFailedTurn={supportsToolRetryLineage ? retryFailedTurn : undefined}
          retryUnavailableReason={retryUnavailableReason}
          retryFailedTurnDisabled={
            busy || inputDisabled || hydrating || transcriptOnly || pendingTurnStart !== null
          }
          hiddenFeedItemCount={windowedSourceFeed.hiddenCount}
          onExpandOlderFeed={expandOlderFeed}
          onShowAllOlderFeed={showAllOlderFeed}
        />

        {readOnlyNotice ? (
          <div
            ref={messageBarOverlayRef}
            id={readOnlyNotice.id}
            role="status"
            aria-live="polite"
            aria-atomic="true"
            data-slot="message-bar-overlay"
            className="absolute inset-x-0 bottom-0 z-20 border-t border-border bg-background/95 px-4 py-3 shadow-lg backdrop-blur"
            style={{ minHeight: composerOverlayMinHeight }}
          >
            <div className="mx-auto flex max-w-3xl flex-col gap-3 rounded-lg border border-border bg-muted/30 px-4 py-3 sm:flex-row sm:items-center">
              <LockKeyholeIcon className="size-4 shrink-0 text-muted-foreground" />
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium">{readOnlyNotice.title}</p>
                <p className="text-xs leading-5 text-muted-foreground">{readOnlyNotice.detail}</p>
              </div>
              {readOnlyNotice.action ? (
                <Button
                  type="button"
                  size="sm"
                  className="w-full shrink-0 sm:w-auto"
                  disabled={readOnlyNotice.action.disabled || readOnlyNotice.action.pending}
                  aria-busy={readOnlyNotice.action.pending || undefined}
                  onClick={readOnlyNotice.action.onClick}
                >
                  {readOnlyNotice.action.pending
                    ? readOnlyNotice.action.pendingIcon
                    : readOnlyNotice.action.icon}
                  {readOnlyNotice.action.pending
                    ? (readOnlyNotice.action.pendingLabel ?? readOnlyNotice.action.label)
                    : readOnlyNotice.action.label}
                </Button>
              ) : null}
            </div>
          </div>
        ) : sourceTask ? (
          <div className="shrink-0 border-t border-border bg-background px-4 py-3">
            <div className="mx-auto flex max-w-3xl items-center gap-3 rounded-lg border border-border bg-muted/30 px-4 py-3">
              <LockKeyholeIcon className="size-4 shrink-0 text-muted-foreground" />
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium">This chat is locked while its task is active.</p>
                <p className="truncate text-xs text-muted-foreground">{sourceTask.title}</p>
              </div>
              <Button type="button" size="sm" onClick={() => void selectTask(sourceTask.id)}>
                Open task
              </Button>
            </div>
          </div>
        ) : (
          <ChatComposer
            messageBarOverlayRef={messageBarOverlayRef}
            composerOverlayMinHeight={composerOverlayMinHeight}
            messageBarHeight={messageBarHeight}
            inputDisabled={inputDisabled}
            transcriptOnly={transcriptOnly}
            ingestAttachmentFiles={ingestAttachmentFiles}
            isUploading={isUploading}
            pendingAttachments={pendingAttachments}
            removeAttachment={removeAttachment}
            submitComposer={submitComposer}
            busy={busy}
            composerHint={composerHint}
            composerSubmitState={composerSubmitState}
            attachmentPickerError={attachmentPickerError}
            composerText={composerText}
            setComposerText={updateComposerText}
            onComposerKeyDown={onComposerKeyDown}
            mentionCatalog={mentionCatalog}
            placeholder={placeholder}
            textareaRef={textareaRef}
            fileInputRef={fileInputRef}
            handleFileSelect={handleFileSelect}
            threadModelConfig={threadModelConfig}
            reasoningSelector={threadModelConfig?.reasoning ?? null}
            onReasoningEffortChange={handleReasoningEffortChange}
            modelSelectorDisabled={modelSelectorDisabled}
            selectedThreadId={selectedThreadId}
            modelDisplayNames={modelDisplayNames}
            preparingAttachments={preparingAttachments}
            submission={composerSubmission}
            canEditAcceptedSubmission={!hasComposerDraftState(composerDraft)}
            interruptPending={rt?.interruptPending === true}
            onRetrySubmission={retrySubmission}
            onEditSubmission={editAcceptedSubmission}
            onDismissSubmission={dismissSubmission}
            onStop={selectedThreadId ? handleStop : undefined}
          />
        )}

        <CancelSubagentsDialog
          open={cancelScopeDialogOpen}
          onOpenChange={setCancelScopeDialogOpen}
          activeChildAgentCount={activeChildAgentCount}
          onCancelWithScope={cancelWithScope}
        />
      </div>
    </ChatViewContext.Provider>
  );
}
