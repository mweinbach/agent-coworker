import { defaultModelForProvider } from "@cowork/providers/catalog";
import type { ChangeEvent, KeyboardEvent as ReactKeyboardEvent } from "react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { CitationSource } from "../../../../src/shared/displayCitationMarkers";
import {
  buildCitationOverflowFilePathsByMessageId,
  buildCitationSourcesByMessageId,
  buildCitationUrlsByMessageId,
} from "../../../../src/shared/displayCitationMarkers";
import {
  buildAttachmentSignature,
  getAttachmentPickerValidationMessage,
} from "../app/attachmentInputs";
import { useAppStore } from "../app/store";
import type { FileAttachmentInput } from "../app/store.helpers/jsonRpcSocket";
import { ConversationScrollButton } from "../components/ai-elements/conversation";
import {
  buildComposerAttachmentSignature,
  type ComposerAttachmentFile,
  createComposerAttachmentFile,
  resolveComposerAttachmentsForWorkspace,
  revokeComposerAttachmentPreview,
} from "../lib/composerAttachments";
import { modelDisplayNamesFromCatalog } from "../lib/modelChoices";
import type { ProviderName } from "../lib/wsProtocol";
import { A2uiSurfaceDock } from "./chat/a2ui/A2uiSurfaceDock";
import { buildChatRenderItems } from "./chat/activityGroups";
import { CancelSubagentsDialog } from "./chat/CancelSubagentsDialog";
import { ChatComposer } from "./chat/ChatComposer";
import { ChatFeed } from "./chat/ChatFeed";
import { ChatViewContext } from "./chat/ChatViewContext";
import { isChatProviderName } from "./chat/ComposerModelSelector";
import {
  composerBusyHint,
  countActiveChildAgents,
  filterFeedForDeveloperMode,
  getComposerSubmitState,
  parseA2uiActionMessage,
  resolveComposerBusyPolicy,
} from "./chat/chatLogic";
import { NewChatLanding } from "./chat/NewChatLanding";
import { loadOverflowCitationContext } from "./chat/overflowCitationContext";
import { normalizeFeedForToolCards } from "./chat/toolCards/legacyToolLogs";

const COMPOSER_OVERLAY_EXTRA_HEIGHT_PX = 24;
const SCROLL_BUTTON_BOTTOM_GAP_PX = 14;
const FEED_BOTTOM_STICKY_THRESHOLD_PX = 220;

export { ChatThreadHeader } from "./chat/ChatThreadHeader";
export {
  type A2uiActionMessage,
  canClearSessionHardCap,
  composerBusyHint,
  countActiveChildAgents,
  filterFeedForDeveloperMode,
  formatSessionBudgetLine,
  formatSessionUsageHeadline,
  getComposerSubmitState,
  isActiveChildAgent,
  parseA2uiActionMessage,
  reasoningLabelForMode,
  reasoningPreviewText,
  resolveComposerBusyPolicy,
  sessionUsageTone,
  shouldToggleReasoningExpanded,
  summarizeA2uiActionMessage,
} from "./chat/chatLogic";
export { loadOverflowCitationContext } from "./chat/overflowCitationContext";

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
  const hasFilePreview = useAppStore((s) => s.filePreview !== null);
  const developerMode = useAppStore((s) => s.developerMode);
  const desktopA2uiEnabled = useAppStore((s) => s.desktopFeatureFlags.a2ui);
  const messageBarHeight = useAppStore((s) => s.messageBarHeight);
  const composerOverlayMinHeight = messageBarHeight + COMPOSER_OVERLAY_EXTRA_HEIGHT_PX;
  const [overflowCitationUrlsByMessageId, setOverflowCitationUrlsByMessageId] = useState<
    Map<string, Map<number, string>>
  >(() => new Map());
  const [overflowCitationSourcesByMessageId, setOverflowCitationSourcesByMessageId] = useState<
    Map<string, CitationSource[]>
  >(() => new Map());
  const [cancelScopeDialogOpen, setCancelScopeDialogOpen] = useState(false);
  const [pendingAttachments, setPendingAttachments] = useState<ComposerAttachmentFile[]>([]);
  const [attachmentPickerError, setAttachmentPickerError] = useState<string | null>(null);
  const [preparingAttachments, setPreparingAttachments] = useState(false);
  const [showScrollButton, setShowScrollButton] = useState(false);
  const [composerOverlayHeight, setComposerOverlayHeight] = useState(composerOverlayMinHeight);
  const [submittedAttachmentSignature, setSubmittedAttachmentSignature] = useState<string | null>(
    null,
  );

  const pendingTurnStart = rt?.pendingTurnStart ?? null;
  const isUploading = preparingAttachments || pendingTurnStart?.status === "sending";
  const [uploadProgress, setUploadProgress] = useState(0);

  useEffect(() => {
    let timer: ReturnType<typeof setInterval> | undefined;
    if (isUploading) {
      setUploadProgress(10);
      timer = setInterval(() => {
        setUploadProgress((prev) => {
          if (prev >= 95) return prev;
          return prev + Math.floor(Math.random() * 5) + 1;
        });
      }, 500);
    } else {
      setUploadProgress(100);
    }
    return () => {
      if (timer) clearInterval(timer);
    };
  }, [isUploading]);

  const setComposerText = useAppStore((s) => s.setComposerText);
  const sendMessage = useAppStore((s) => s.sendMessage);
  const cancelThread = useAppStore((s) => s.cancelThread);
  const reconnectThread = useAppStore((s) => s.reconnectThread);

  const feedRef = useRef<HTMLDivElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const messageBarOverlayRef = useRef<HTMLDivElement | null>(null);
  const lastCountRef = useRef<number>(0);
  const autoScrolledThreadIdRef = useRef<string | null>(null);
  const pendingAttachmentsRef = useRef<ComposerAttachmentFile[]>([]);
  const scrollButtonBottomOffset = composerOverlayHeight + SCROLL_BUTTON_BOTTOM_GAP_PX;

  const updateScrollButtonVisibility = useCallback(() => {
    const el = feedRef.current;
    if (!el) {
      setShowScrollButton(false);
      return;
    }

    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    const nextVisible = distanceFromBottom > FEED_BOTTOM_STICKY_THRESHOLD_PX;
    setShowScrollButton((current) => (current === nextVisible ? current : nextVisible));
  }, []);

  const scrollFeedToBottom = useCallback(() => {
    const el = feedRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
    setShowScrollButton(false);
  }, []);

  useEffect(() => {
    pendingAttachmentsRef.current = pendingAttachments;
  }, [pendingAttachments]);

  useLayoutEffect(() => {
    const el = messageBarOverlayRef.current;
    if (!el) {
      setComposerOverlayHeight(composerOverlayMinHeight);
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
  }, [composerOverlayMinHeight]);

  useEffect(() => {
    return () => {
      pendingAttachmentsRef.current.forEach(revokeComposerAttachmentPreview);
    };
  }, []);

  const clearPendingAttachments = useCallback(() => {
    setPendingAttachments((current) => {
      current.forEach(revokeComposerAttachmentPreview);
      return [];
    });
    setSubmittedAttachmentSignature(null);
  }, []);

  useEffect(() => {
    clearPendingAttachments();
    setAttachmentPickerError(null);
    setPreparingAttachments(false);
  }, [clearPendingAttachments, selectedThreadId]);

  const ingestAttachmentFiles = useCallback(
    async (selectedFiles: File[]) => {
      if (selectedFiles.length === 0) return;

      const validationMessage = getAttachmentPickerValidationMessage(
        pendingAttachments,
        selectedFiles,
      );
      if (validationMessage) {
        setAttachmentPickerError(validationMessage);
        return;
      }

      setAttachmentPickerError(null);
      setSubmittedAttachmentSignature(null);
      setPendingAttachments((prev) => [
        ...prev,
        ...selectedFiles.map(createComposerAttachmentFile),
      ]);
    },
    [pendingAttachments],
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

  const removeAttachment = useCallback((index: number) => {
    setAttachmentPickerError(null);
    setSubmittedAttachmentSignature(null);
    setPendingAttachments((prev) => {
      const next = [...prev];
      const [removed] = next.splice(index, 1);
      if (removed) {
        revokeComposerAttachmentPreview(removed);
      }
      return next;
    });
  }, []);

  const feed = rt?.feed ?? [];
  const normalizedFeed = normalizeFeedForToolCards(feed, developerMode);
  const a2uiEnabled = useMemo(() => {
    if (typeof rt?.sessionConfig?.enableA2ui === "boolean") {
      return rt.sessionConfig.enableA2ui;
    }
    if (typeof rt?.sessionConfig?.featureFlags?.workspace?.a2ui === "boolean") {
      return rt.sessionConfig.featureFlags.workspace.a2ui;
    }
    return desktopA2uiEnabled === true;
  }, [
    desktopA2uiEnabled,
    rt?.sessionConfig?.enableA2ui,
    rt?.sessionConfig?.featureFlags?.workspace?.a2ui,
  ]);
  const visibleFeed = useMemo(() => {
    const baseVisibleFeed = filterFeedForDeveloperMode(normalizedFeed, developerMode);
    if (a2uiEnabled) {
      return baseVisibleFeed;
    }
    return baseVisibleFeed.filter((item) => {
      if (item.kind === "ui_surface") {
        return false;
      }
      if (item.kind === "message" && item.role === "user" && parseA2uiActionMessage(item.text)) {
        return false;
      }
      return true;
    });
  }, [a2uiEnabled, developerMode, normalizedFeed]);
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
  const latestUiSurfaceItemId = useMemo(() => {
    for (let i = renderItems.length - 1; i >= 0; i--) {
      const entry = renderItems[i];
      if (
        entry &&
        entry.kind === "feed-item" &&
        entry.item.kind === "ui_surface" &&
        !entry.item.deleted
      ) {
        return entry.item.id;
      }
    }
    return null;
  }, [renderItems]);
  const activeChildAgentCount = useMemo(
    () => countActiveChildAgents(rt?.agents ?? []),
    [rt?.agents],
  );
  const contextValue = useMemo(
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
  const modelDisplayNames = useMemo(
    () => modelDisplayNamesFromCatalog(providerCatalog),
    [providerCatalog],
  );

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

  const cancelWithScope = useCallback(
    (includeSubagents: boolean) => {
      if (!selectedThreadId) return;
      cancelThread(selectedThreadId, { includeSubagents });
      setCancelScopeDialogOpen(false);
    },
    [cancelThread, selectedThreadId],
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
      setShowScrollButton(false);
      return;
    }

    const previousCount = lastCountRef.current;
    lastCountRef.current = visibleFeed.length;

    if (previousCount === 0 && visibleFeed.length > 0) {
      window.requestAnimationFrame(() => {
        const nextEl = feedRef.current;
        if (nextEl) {
          nextEl.scrollTop = nextEl.scrollHeight;
        }
      });
      setShowScrollButton(false);
      return;
    }

    const distFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    if (distFromBottom < FEED_BOTTOM_STICKY_THRESHOLD_PX) {
      window.requestAnimationFrame(() => {
        const nextEl = feedRef.current;
        if (nextEl) {
          nextEl.scrollTop = nextEl.scrollHeight;
        }
      });
      setShowScrollButton(false);
    } else {
      setShowScrollButton(true);
    }
  }, [selectedThreadId, visibleFeed]);

  useEffect(() => {
    updateScrollButtonVisibility();
  }, [composerOverlayHeight, updateScrollButtonVisibility]);

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
    async (
      workspaceId: string,
      attachments: readonly ComposerAttachmentFile[],
    ): Promise<FileAttachmentInput[]> => {
      const resolved = await resolveComposerAttachmentsForWorkspace(
        useAppStore.getState,
        useAppStore.setState,
        workspaceId,
        attachments,
      );
      if (resolved.skippedNotes.length > 0) {
        const detail = resolved.skippedNotes.join(" ");
        throw new Error(detail);
      }
      return resolved.attachments;
    },
    [],
  );

  const pendingAttachmentSignature = useMemo(
    () => submittedAttachmentSignature ?? buildComposerAttachmentSignature(pendingAttachments),
    [pendingAttachments, submittedAttachmentSignature],
  );
  const hasPendingAttachments = pendingAttachments.length > 0;

  const submitComposer = useCallback(
    (busyPolicy: "reject" | "steer") => {
      if (!thread) return;
      if (preparingAttachments) return;
      if (pendingTurnStart?.status === "sending") return;
      if (!composerText.trim() && pendingAttachments.length === 0) return;

      const targetThreadId = thread.id;
      const targetWorkspaceId = thread.workspaceId;
      setPreparingAttachments(true);
      setAttachmentPickerError(null);
      void (async () => {
        try {
          const attachments =
            pendingAttachments.length > 0
              ? await resolvePendingAttachmentsForSend(targetWorkspaceId, pendingAttachments)
              : undefined;
          const attachmentSignature =
            attachments && attachments.length > 0 ? buildAttachmentSignature(attachments) : null;
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
    },
    [
      clearPendingAttachments,
      composerText,
      pendingAttachments,
      pendingTurnStart?.status,
      preparingAttachments,
      resolvePendingAttachmentsForSend,
      sendMessage,
      thread,
    ],
  );

  useEffect(() => {
    if (pendingAttachments.length === 0) return;
    if (rt?.pendingSteer?.status !== "accepted") return;
    if ((rt.pendingSteer.attachmentSignature ?? "") !== pendingAttachmentSignature) return;
    clearPendingAttachments();
    setAttachmentPickerError(null);
  }, [
    clearPendingAttachments,
    pendingAttachmentSignature,
    pendingAttachments.length,
    rt?.pendingSteer,
  ]);

  const onComposerKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLTextAreaElement>) => {
      if (
        event.key === "Enter" &&
        !event.shiftKey &&
        !event.metaKey &&
        !event.ctrlKey &&
        !event.altKey
      ) {
        event.preventDefault();
        submitComposer(resolveComposerBusyPolicy(rt?.busy === true));
      } else if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        const textarea = event.currentTarget;
        const start = textarea.selectionStart;
        const end = textarea.selectionEnd;
        const value = textarea.value;
        const newValue = `${value.substring(0, start)}\n${value.substring(end)}`;
        setComposerText(newValue);
        requestAnimationFrame(() => {
          textarea.selectionStart = textarea.selectionEnd = start + 1;
        });
      }
    },
    [rt?.busy, submitComposer, setComposerText],
  );

  if (!selectedThreadId || !thread) {
    return <NewChatLanding />;
  }

  const busy = rt?.busy === true;
  const inputDisabled = hasPromptModal || hasFilePreview || preparingAttachments;
  const transcriptOnly = rt?.transcriptOnly === true;
  const hydrating =
    rt?.hydrating === true ||
    (bootstrapPending && Boolean(selectedThreadId) && Boolean(thread) && rt === null);
  const disconnected = !hydrating && !transcriptOnly && thread.status !== "active";
  const composerSubmitState = getComposerSubmitState({
    busy,
    hasPromptModal: inputDisabled,
    composerText,
    hasPendingAttachments,
    pendingAttachmentSignature,
    pendingTurnStart,
    pendingSteer: rt?.pendingSteer ?? null,
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
          feedRef={feedRef}
          onScroll={updateScrollButtonVisibility}
          transcriptOnly={transcriptOnly}
          disconnected={disconnected}
          onReconnect={() => void reconnectThread(selectedThreadId)}
          visibleFeedLength={visibleFeed.length}
          hydrating={hydrating}
          renderItems={renderItems}
          liveActivityGroupId={liveActivityGroupId}
          liveStartedAt={rt?.busySince ?? null}
          citationUrlsByMessageId={citationUrlsByMessageId}
          citationSourcesByMessageId={citationSourcesByMessageId}
          desktopBasePath={workspace?.path ?? null}
          latestUiSurfaceItemId={latestUiSurfaceItemId}
          a2uiEnabled={a2uiEnabled}
          composerOverlayHeight={composerOverlayHeight}
        />
        <ConversationScrollButton
          bottomOffset={scrollButtonBottomOffset}
          visible={showScrollButton}
          onClick={scrollFeedToBottom}
        />

        {selectedThreadId && a2uiEnabled ? (
          <div className="shrink-0 bg-panel px-4">
            <A2uiSurfaceDock threadId={selectedThreadId} />
          </div>
        ) : null}

        <ChatComposer
          messageBarOverlayRef={messageBarOverlayRef}
          composerOverlayMinHeight={composerOverlayMinHeight}
          messageBarHeight={messageBarHeight}
          inputDisabled={inputDisabled}
          transcriptOnly={transcriptOnly}
          ingestAttachmentFiles={ingestAttachmentFiles}
          isUploading={isUploading}
          uploadProgress={uploadProgress}
          pendingAttachments={pendingAttachments}
          removeAttachment={removeAttachment}
          submitComposer={submitComposer}
          busy={busy}
          composerHint={composerHint}
          composerSubmitState={composerSubmitState}
          attachmentPickerError={attachmentPickerError}
          composerText={composerText}
          setComposerText={setComposerText}
          onComposerKeyDown={onComposerKeyDown}
          placeholder={placeholder}
          textareaRef={textareaRef}
          fileInputRef={fileInputRef}
          handleFileSelect={handleFileSelect}
          threadModelConfig={threadModelConfig}
          threadDraft={thread.draft === true}
          selectedThreadId={selectedThreadId}
          modelDisplayNames={modelDisplayNames}
          preparingAttachments={preparingAttachments}
          onStop={selectedThreadId ? handleStop : undefined}
        />

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
