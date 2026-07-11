import type { SessionEvent } from "../../../../lib/wsProtocol";
import { findComposerSubmissionById } from "../../../composerSubmission";
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

function reasoningEffortFromProviderOptions(
  provider: unknown,
  model: string | undefined,
  providerOptions: WorkspaceProviderOptions | undefined,
): ReasoningEffortValue | undefined {
  if (provider === "openai" || provider === "codex-cli") {
    return providerOptions?.[provider]?.reasoningEffort;
  }
  if (provider === "google") {
    return getWorkspaceGoogleReasoningEffort(providerOptions, model) ?? undefined;
  }
  return undefined;
}

/**
 * Decide what to do with an optimistic composer reasoning effort when a
 * `session_config` ack arrives.
 *
 * The optimistic value bridges the `set_config` round-trip. Clear it once the
 * server settles a value — either it confirms our request (incoming matches
 * pending) or it lands a different effort (the config's effort changed from a
 * previously-defined value). Preserve it only while the config is still lagging
 * (the effort is unchanged from the prior config and hasn't reached our value),
 * so the selector never shows a stale pending value indefinitely.
 *
 * When clearing for an openai/codex-cli thread — where the selector prefers the
 * runtime effort — sync the runtime fields to the authoritative incoming effort
 * (a server-clamped value wins, not the optimistic one). `syncRuntime` signals
 * that the runtime fields must be rewritten; `runtimeSyncEffort` is the value to
 * write, which is `null` when the settled config carries no effort so the stale
 * runtime value is cleared rather than left to shadow the config/default.
 */
function resolveComposerReasoningEffortUpdate(
  current: {
    composerReasoningEffort?: ReasoningEffortValue | null;
    draftComposerProvider?: unknown;
    draftComposerModel?: unknown;
    config?: { provider?: unknown; model?: unknown } | null;
    sessionConfig?: { providerOptions?: unknown } | null;
  },
  config: Extract<SessionEvent, { type: "session_config" }>["config"],
): {
  clear: boolean;
  syncRuntime: boolean;
  runtimeSyncEffort: Exclude<ReasoningEffortValue, "dynamic"> | null;
} {
  const pendingEffort = current.composerReasoningEffort;
  if (!pendingEffort) return { clear: true, syncRuntime: false, runtimeSyncEffort: null };

  // Draft threads track the composer's selection separately from the live
  // session config; compare against the provider the composer is showing.
  const draftProvider = current.draftComposerProvider ?? null;
  const provider = draftProvider ?? current.config?.provider;
  if (provider !== "openai" && provider !== "codex-cli" && provider !== "google") {
    return { clear: true, syncRuntime: false, runtimeSyncEffort: null };
  }
  const model = draftProvider
    ? typeof current.draftComposerModel === "string"
      ? current.draftComposerModel
      : undefined
    : typeof current.config?.model === "string"
      ? current.config.model
      : undefined;

  const incomingEffort = reasoningEffortFromProviderOptions(
    provider,
    model,
    config.providerOptions as WorkspaceProviderOptions | undefined,
  );
  const priorEffort = reasoningEffortFromProviderOptions(
    provider,
    model,
    (current.sessionConfig as { providerOptions?: WorkspaceProviderOptions } | undefined)
      ?.providerOptions,
  );

  const clear =
    incomingEffort === pendingEffort ||
    (priorEffort !== undefined && incomingEffort !== priorEffort);
  // The selector prefers runtime over config only for openai/codex-cli, so those
  // are the only threads whose runtime fields must track the settled config.
  const syncRuntime = clear && (provider === "openai" || provider === "codex-cli");
  const runtimeSyncEffort =
    syncRuntime && incomingEffort && incomingEffort !== "dynamic" ? incomingEffort : null;
  return { clear, syncRuntime, runtimeSyncEffort };
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
    const resumedBusy = evt.isResume ? Boolean(evt.busy) : false;
    const prevRt = get().threadRuntimeById[threadId];
    const resumedSameLiveTurn =
      resumedBusy &&
      prevRt?.busy === true &&
      (!evt.turnId || !prevRt.activeTurnId || evt.turnId === prevRt.activeTurnId);
    if (!resumedSameLiveTurn) {
      resetLiveModelStreamRuntime(threadId);
    }
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
            interruptPending: resumedSameLiveTurn ? rt.interruptPending : false,
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
            interruptPending: evt.busy ? rt.interruptPending : false,
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
      markPendingThreadSteerAccepted(threadId, evt.clientMessageId, evt.steerRequestId);
      const pendingSteer = get().threadRuntimeById[threadId]?.pendingSteer;
      const submissionId =
        pendingSteer?.clientMessageId === evt.clientMessageId
          ? pendingSteer.submissionId
          : undefined;
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
                ...(evt.steerRequestId ? { steerRequestId: evt.steerRequestId } : {}),
                status: "accepted",
              },
            },
          },
        };
      });
      if (submissionId) {
        const submission = findComposerSubmissionById(get().composerSubmissionsByKey, submissionId);
        if (submission) get().completeComposerSubmission(submission.owner);
      }
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
      const { clear, syncRuntime, runtimeSyncEffort } = resolveComposerReasoningEffortUpdate(
        rt,
        evt.config,
      );
      const composerReasoningEffort = clear ? null : (rt.composerReasoningEffort ?? null);
      // The selector prefers the runtime value over the config, so when the
      // pending effort resolves, sync the runtime fields to the authoritative
      // config value — including clearing them to null when the settled config
      // carries no effort; otherwise a stale runtime effort would keep showing.
      const runtimeEffortPatch = syncRuntime
        ? {
            requestedReasoningEffort: runtimeSyncEffort,
            effectiveReasoningEffort: runtimeSyncEffort,
          }
        : {};
      return {
        threadRuntimeById: {
          ...s.threadRuntimeById,
          [threadId]: {
            ...rt,
            sessionConfig: evt.config,
            composerReasoningEffort,
            ...runtimeEffortPatch,
          },
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
