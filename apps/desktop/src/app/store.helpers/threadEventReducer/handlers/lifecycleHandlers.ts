import type { SessionEvent } from "../../../../lib/wsProtocol";
import {
  getWorkspaceGoogleReasoningEffort,
  type ReasoningEffortValue,
  type WorkspaceProviderOptions,
} from "../../../openaiCompatibleProviderOptions";
import {
  developerDiagnosticSystemLineFromSessionEvent,
  upsertAgentSummary,
} from "../../../store.feedMapping";
import type { ApprovalPrompt, AskPrompt, SandboxApprovalPrompt } from "../../../types";
import {
  clearPendingThreadSteers,
  markPendingThreadSteerAccepted,
  prependPendingThreadMessageWithAttachments,
  RUNTIME,
  shiftPendingThreadAttachments,
  shiftPendingThreadReferences,
} from "../../runtimeState";
import { sortAgentSummaries } from "../../threadEventReducerContext";
import type { HandlerDispatch, HandlerModuleContext } from "./shared";

let sandboxApprovalSequence = 0;

function shouldClearComposerReasoningEffort(
  current: {
    composerReasoningEffort?: ReasoningEffortValue | null;
    config?: { provider?: unknown; model?: unknown } | null;
  },
  config: Extract<SessionEvent, { type: "session_config" }>["config"],
): boolean {
  const pendingEffort = current.composerReasoningEffort;
  if (!pendingEffort) return true;

  const provider = current.config?.provider;
  const providerOptions = config.providerOptions as WorkspaceProviderOptions | undefined;
  if (provider === "openai" || provider === "codex-cli") {
    return providerOptions?.[provider]?.reasoningEffort === pendingEffort;
  }

  if (provider === "google") {
    const model = typeof current.config?.model === "string" ? current.config.model : undefined;
    return getWorkspaceGoogleReasoningEffort(providerOptions, model) === pendingEffort;
  }

  return true;
}

export function handleLifecycleThreadEvent(
  module: HandlerModuleContext,
  dispatch: HandlerDispatch,
  evt: SessionEvent,
): boolean {
  const {
    ctx,
    pushFeedItem,
    sendUserMessageToThread,
    flushOneQueuedThreadMessageIfReady,
    hasPendingWorkspaceDefaultApply,
    resetLiveModelStreamRuntime,
  } = module;
  const { get, set, threadId, pendingFirstMessage, pendingFirstMessageQueued = false } = dispatch;

  if (evt.type === "server_hello") {
    resetLiveModelStreamRuntime(threadId);
    const resumedBusy = evt.isResume ? Boolean(evt.busy) : false;
    const prevRt = get().threadRuntimeById[threadId];
    const draftModelSelection =
      prevRt?.draftComposerProvider != null &&
      typeof prevRt.draftComposerModel === "string" &&
      prevRt.draftComposerModel.trim()
        ? {
            provider: prevRt.draftComposerProvider,
            model: prevRt.draftComposerModel.trim(),
            ...(prevRt.composerReasoningEffort
              ? { reasoningEffort: prevRt.composerReasoningEffort }
              : {}),
          }
        : null;
    set((s) => {
      const rt = s.threadRuntimeById[threadId];
      if (!rt) return {};
      const sessionKind = evt.sessionKind ?? "root";
      return {
        threadRuntimeById: {
          ...s.threadRuntimeById,
          [threadId]: {
            ...rt,
            connected: true,
            sessionId: evt.sessionId,
            config: evt.config,
            sessionKind,
            parentSessionId: evt.parentSessionId ?? null,
            role: evt.role ?? null,
            mode: evt.mode ?? null,
            depth: typeof evt.depth === "number" ? evt.depth : 0,
            nickname: evt.nickname ?? null,
            requestedModel: evt.requestedModel ?? null,
            effectiveModel: evt.effectiveModel ?? null,
            requestedReasoningEffort: evt.requestedReasoningEffort ?? null,
            effectiveReasoningEffort: evt.effectiveReasoningEffort ?? null,
            executionState: evt.executionState ?? null,
            lastMessagePreview: evt.lastMessagePreview ?? null,
            agents: sessionKind === "agent" ? [] : evt.isResume ? rt.agents : [],
            busy: resumedBusy,
            busySince: resumedBusy ? (rt.busySince ?? ctx.deps.nowIso()) : null,
            activeTurnId: resumedBusy ? (evt.turnId ?? null) : null,
            pendingSteer: resumedBusy ? rt.pendingSteer : null,
            transcriptOnly: false,
            draftComposerProvider: null,
            draftComposerModel: null,
          },
        },
        threads: s.threads.map((t) =>
          t.id === threadId
            ? { ...t, status: "active", sessionId: evt.sessionId, draft: false }
            : t,
        ),
      };
    });
    ctx.deps.persist(get);
    if (!resumedBusy) {
      clearPendingThreadSteers(threadId);
    }

    void get().applyWorkspaceDefaultsToThread(
      threadId,
      evt.isResume ? "auto-resume" : "auto",
      draftModelSelection,
      { allowBeforeHydration: !evt.isResume },
    );
    let acceptedPendingFirstMessage = false;
    if (pendingFirstMessage?.trim()) {
      if (resumedBusy) {
        if (!pendingFirstMessageQueued) {
          prependPendingThreadMessageWithAttachments(threadId, pendingFirstMessage);
        }
      } else if (hasPendingWorkspaceDefaultApply(threadId)) {
        if (!pendingFirstMessageQueued) {
          prependPendingThreadMessageWithAttachments(threadId, pendingFirstMessage);
        }
      } else {
        if (pendingFirstMessageQueued) {
          acceptedPendingFirstMessage = flushOneQueuedThreadMessageIfReady(get, set, threadId);
        } else {
          const firstMsgAttachments = shiftPendingThreadAttachments(threadId);
          const firstMsgReferences = shiftPendingThreadReferences(threadId);
          acceptedPendingFirstMessage = sendUserMessageToThread(
            get,
            set,
            threadId,
            pendingFirstMessage,
            undefined,
            firstMsgAttachments,
            firstMsgReferences,
          );
        }
      }
    }

    if (!resumedBusy && !acceptedPendingFirstMessage) {
      flushOneQueuedThreadMessageIfReady(get, set, threadId);
    }
    return true;
  }

  if (evt.type === "observability_status") {
    pushFeedItem(set, threadId, {
      id: ctx.deps.makeId(),
      kind: "system",
      ts: ctx.deps.nowIso(),
      line: developerDiagnosticSystemLineFromSessionEvent(evt),
    });
    return true;
  }

  if (evt.type === "session_settings") {
    set((s) => {
      const rt = s.threadRuntimeById[threadId];
      if (!rt) return {};
      return {
        threadRuntimeById: {
          ...s.threadRuntimeById,
          [threadId]: { ...rt, enableMcp: evt.enableMcp },
        },
      };
    });
    const pendingApply = RUNTIME.pendingWorkspaceDefaultApplyByThread.get(threadId);
    if (pendingApply && !pendingApply.inFlight) {
      void get().applyWorkspaceDefaultsToThread(
        threadId,
        pendingApply.mode,
        pendingApply.draftModelSelection,
      );
      flushOneQueuedThreadMessageIfReady(get, set, threadId);
    }
    return true;
  }

  if (evt.type === "session_busy") {
    resetLiveModelStreamRuntime(threadId);
    set((s) => {
      const rt = s.threadRuntimeById[threadId];
      if (!rt) return {};
      return {
        threadRuntimeById: {
          ...s.threadRuntimeById,
          [threadId]: {
            ...rt,
            busy: evt.busy,
            busySince: evt.busy ? (rt.busySince ?? ctx.deps.nowIso()) : null,
            activeTurnId: evt.busy ? (evt.turnId ?? rt.activeTurnId) : null,
            pendingTurnStart: null,
            pendingSteer: evt.busy ? rt.pendingSteer : null,
          },
        },
      };
    });
    if (!evt.busy) {
      const pendingApply = RUNTIME.pendingWorkspaceDefaultApplyByThread.get(threadId);
      if (pendingApply && !pendingApply.inFlight) {
        void get().applyWorkspaceDefaultsToThread(
          threadId,
          pendingApply.mode,
          pendingApply.draftModelSelection,
        );
      }
    }
    if (!evt.busy) {
      clearPendingThreadSteers(threadId);
      flushOneQueuedThreadMessageIfReady(get, set, threadId);
    }
    return true;
  }

  if (evt.type === "steer_accepted") {
    if (typeof evt.clientMessageId === "string") {
      markPendingThreadSteerAccepted(threadId, evt.clientMessageId);
      set((s) => {
        const rt = s.threadRuntimeById[threadId];
        const pendingSteer = rt?.pendingSteer;
        if (!rt || !pendingSteer || pendingSteer.clientMessageId !== evt.clientMessageId) return {};
        return {
          threadRuntimeById: {
            ...s.threadRuntimeById,
            [threadId]: {
              ...rt,
              pendingSteer: {
                ...pendingSteer,
                status: "accepted",
              },
            },
          },
        };
      });
    }
    const activeThreadId = get().selectedThreadId;
    const composerText = get().composerText.trim();
    if (
      activeThreadId === threadId &&
      composerText.length > 0 &&
      composerText === evt.text.trim()
    ) {
      set({ composerText: "" });
    }
    return true;
  }

  if (evt.type === "config_updated") {
    set((s) => {
      const rt = s.threadRuntimeById[threadId];
      if (!rt) return {};
      return {
        threadRuntimeById: {
          ...s.threadRuntimeById,
          [threadId]: { ...rt, config: evt.config },
        },
      };
    });
    const pendingApply = RUNTIME.pendingWorkspaceDefaultApplyByThread.get(threadId);
    if (pendingApply && !pendingApply.inFlight) {
      void get().applyWorkspaceDefaultsToThread(
        threadId,
        pendingApply.mode,
        pendingApply.draftModelSelection,
      );
    }
    return true;
  }

  if (evt.type === "session_config") {
    set((s) => {
      const rt = s.threadRuntimeById[threadId];
      if (!rt) return {};
      const composerReasoningEffort = shouldClearComposerReasoningEffort(rt, evt.config)
        ? null
        : (rt.composerReasoningEffort ?? null);
      return {
        threadRuntimeById: {
          ...s.threadRuntimeById,
          [threadId]: { ...rt, sessionConfig: evt.config, composerReasoningEffort },
        },
      };
    });
    const pendingApply = RUNTIME.pendingWorkspaceDefaultApplyByThread.get(threadId);
    if (pendingApply && !pendingApply.inFlight) {
      void get().applyWorkspaceDefaultsToThread(
        threadId,
        pendingApply.mode,
        pendingApply.draftModelSelection,
      );
      flushOneQueuedThreadMessageIfReady(get, set, threadId);
    }
    return true;
  }

  if (evt.type === "session_info") {
    let titleChanged = false;
    set((s) => {
      const rt = s.threadRuntimeById[threadId];
      const nextConfig = rt?.config
        ? {
            ...rt.config,
            provider: rt.config.provider ?? evt.provider,
            model: rt.config.model ?? evt.model,
          }
        : (rt?.config ?? null);
      const incomingTitle = evt.title.trim();
      const incomingSource = ctx.deps.normalizeThreadTitleSource(
        evt.titleSource,
        incomingTitle || evt.title,
      );
      const nextThreads = s.threads.map((t) => {
        if (t.id !== threadId) return t;
        const currentSource = ctx.deps.normalizeThreadTitleSource(t.titleSource, t.title);
        if (
          !ctx.deps.shouldAdoptServerTitle({
            currentSource,
            incomingTitle,
            incomingSource,
          })
        ) {
          return t;
        }

        const nextTitle = incomingTitle || t.title;
        if (nextTitle === t.title && currentSource === incomingSource) {
          return t;
        }

        titleChanged = true;
        return {
          ...t,
          title: nextTitle,
          titleSource: incomingSource,
        };
      });
      return {
        threads: nextThreads,
        ...(rt
          ? {
              threadRuntimeById: {
                ...s.threadRuntimeById,
                [threadId]: {
                  ...rt,
                  config: nextConfig,
                  sessionKind: evt.sessionKind ?? rt.sessionKind,
                  parentSessionId: evt.parentSessionId ?? rt.parentSessionId,
                  role: evt.role ?? rt.role,
                  mode: evt.mode ?? rt.mode,
                  depth: typeof evt.depth === "number" ? evt.depth : rt.depth,
                  nickname: evt.nickname ?? rt.nickname,
                  requestedModel: evt.requestedModel ?? rt.requestedModel,
                  effectiveModel: evt.effectiveModel ?? rt.effectiveModel,
                  requestedReasoningEffort:
                    evt.requestedReasoningEffort ?? rt.requestedReasoningEffort,
                  effectiveReasoningEffort:
                    evt.effectiveReasoningEffort ?? rt.effectiveReasoningEffort,
                  executionState: evt.executionState ?? rt.executionState,
                  lastMessagePreview: evt.lastMessagePreview ?? rt.lastMessagePreview,
                  agents: (evt.sessionKind ?? rt.sessionKind) === "agent" ? [] : rt.agents,
                },
              },
            }
          : {}),
      };
    });
    if (titleChanged) {
      void ctx.deps.persist(get);
    }
    return true;
  }

  if (evt.type === "session_backup_state" || evt.type === "harness_context") {
    pushFeedItem(set, threadId, {
      id: ctx.deps.makeId(),
      kind: "system",
      ts: ctx.deps.nowIso(),
      line: developerDiagnosticSystemLineFromSessionEvent(evt),
    });
    return true;
  }

  if (evt.type === "agent_list") {
    set((s) => {
      const rt = s.threadRuntimeById[threadId];
      if (!rt) return {};
      return {
        threadRuntimeById: {
          ...s.threadRuntimeById,
          [threadId]: {
            ...rt,
            agents: sortAgentSummaries(evt.agents),
          },
        },
      };
    });
    return true;
  }

  if (evt.type === "agent_spawned" || evt.type === "agent_status") {
    set((s) => {
      const rt = s.threadRuntimeById[threadId];
      if (!rt) return {};
      return {
        threadRuntimeById: {
          ...s.threadRuntimeById,
          [threadId]: {
            ...rt,
            agents: upsertAgentSummary(rt.agents, evt.agent),
          },
        },
      };
    });
    return true;
  }

  if (evt.type === "agent_wait_result") {
    set((s) => {
      const rt = s.threadRuntimeById[threadId];
      if (!rt) return {};
      let nextAgents = rt.agents;
      for (const agent of evt.agents) {
        nextAgents = upsertAgentSummary(nextAgents, agent);
      }
      return {
        threadRuntimeById: {
          ...s.threadRuntimeById,
          [threadId]: {
            ...rt,
            agents: nextAgents,
          },
        },
      };
    });
    return true;
  }

  if (evt.type === "ask") {
    const prompt: AskPrompt = {
      requestId: evt.requestId,
      question: evt.question,
      options: evt.options,
    };
    set(() => ({ promptModal: { kind: "ask", threadId, prompt } }));
    return true;
  }

  if (evt.type === "approval") {
    // Sandbox-denial escalations render inline in the chat feed (a sandbox-aware
    // approve/deny on the running command), not the generic centered modal.
    // Ordinary approvals (requires_manual_review) keep using the modal.
    if (evt.reasonCode === "sandbox_denied_escalation") {
      const prompt: SandboxApprovalPrompt = {
        requestId: evt.requestId,
        command: evt.command,
        receivedSequence: ++sandboxApprovalSequence,
        ...(evt.detail ? { detail: evt.detail } : {}),
        ...(evt.category ? { category: evt.category } : {}),
      };
      set((s) => ({
        promptModal:
          s.promptModal?.kind === "approval" && s.promptModal.threadId === threadId
            ? null
            : s.promptModal,
        sandboxApprovalsByThread: {
          ...s.sandboxApprovalsByThread,
          [threadId]: [
            ...(s.sandboxApprovalsByThread[threadId] ?? []).filter(
              (p) => p.requestId !== prompt.requestId,
            ),
            prompt,
          ],
        },
      }));
      return true;
    }
    const prompt: ApprovalPrompt = {
      requestId: evt.requestId,
      command: evt.command,
      dangerous: evt.dangerous,
      reasonCode: evt.reasonCode,
    };
    set(() => ({ promptModal: { kind: "approval", threadId, prompt } }));
    return true;
  }

  return false;
}
