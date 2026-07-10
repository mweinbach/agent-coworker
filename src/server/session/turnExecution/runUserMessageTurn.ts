import type { AgentExecutionState } from "../../../shared/agents";
import { supportsProviderManagedContinuationProvider } from "../../../shared/providerContinuation";
import { captureProductEvent } from "../../../telemetry/productAnalytics";
import type { ApproveCommandOptions, TurnReference } from "../../../types";
import type { FileAttachment, OrderedInputPart } from "../../jsonrpc/routes/shared";
import { reasoningModeForProvider } from "../../modelStream";
import type { HistoryManager } from "../HistoryManager";
import type { InteractionManager } from "../InteractionManager";
import type { SessionBackupController } from "../SessionBackupController";
import type { SessionContext } from "../SessionContext";
import type { SessionMetadataManager } from "../SessionMetadataManager";
import { getSessionTaskLock } from "../taskLocks";
import { isInvalidProviderManagedContinuationError } from "./continuationPolicy";
import {
  getPartialTurnProviderState,
  getPartialTurnResponseMessages,
  resolvePartialTurnProgressSource,
} from "./partialTurnError";
import {
  renderReferencedSkillsInjection,
  resolveReferencedPlugins,
  resolveReferencedSkills,
} from "./referenceInjection";
import { createRunTurnInvocation } from "./runTurnInvocation";
import type { SteerCoordinator } from "./steerCoordinator";
import {
  detectMalformedToolCallFailure,
  extractAssistantTextFromResponseMessages,
  normalizePreviewText,
} from "./turnResponseParsing";
import { createTurnUsageAggregator } from "./turnUsageAggregator";
import {
  type ClassifiedTurnError,
  createUserContentMaterializationTransaction,
  getTurnAttachmentValidationMessage,
  type UserMessageAttachmentHelpers,
} from "./userMessageAttachments";
import {
  getTaskLockAbortSessionError,
  isAbortLikeError,
  makeTaskLockAbortError,
  makeTurnId,
  resolveUserInputDisplayText,
} from "./userMessageTurnHelpers";

export type UserMessageTurnRunnerDeps = {
  context: SessionContext;
  historyManager: HistoryManager;
  metadataManager: SessionMetadataManager;
  backupController: SessionBackupController;
  interactionManager: InteractionManager;
  flushPendingExternalSkillRefresh: () => Promise<void>;
  triggerMemoryGeneration?: () => void;
  triggerSkillImprovementUsage?: () => void;
  steerCoordinator: SteerCoordinator;
  classifyTurnError: (err: unknown) => ClassifiedTurnError;
  buildUserMessageContent: UserMessageAttachmentHelpers["buildUserMessageContent"];
  validateUploadedFileAttachments: UserMessageAttachmentHelpers["validateUploadedFileAttachments"];
  onAdvancedMemoryChanged?: (folder: string) => Promise<void>;
  waitForLiveSteerSettlement?: () => Promise<void>;
  onUserMessageAccepted?: (clientMessageId: string | undefined, turnId: string) => void;
};

export type UserMessageTurnRunner = {
  sendUserMessage: (
    text: string,
    clientMessageId?: string,
    displayText?: string,
    attachments?: FileAttachment[],
    inputParts?: OrderedInputPart[],
    references?: TurnReference[],
    opts?: { allowThreadManagementTools?: boolean },
  ) => Promise<void>;
};

export type UserMessageTurnFinalizerCheckpoint = {
  phase: "steer_admission_closed";
  sessionId: string;
  turnId: string;
};

type UserMessageTurnFinalizerCheckpointHook = (
  checkpoint: UserMessageTurnFinalizerCheckpoint,
) => void | Promise<void>;

let userMessageTurnFinalizerCheckpointHook: UserMessageTurnFinalizerCheckpointHook | null = null;

async function runUserMessageTurnFinalizerCheckpoint(
  checkpoint: UserMessageTurnFinalizerCheckpoint,
): Promise<void> {
  const hook = userMessageTurnFinalizerCheckpointHook;
  if (hook) await hook(checkpoint);
}

export function createUserMessageTurnRunner(
  deps: UserMessageTurnRunnerDeps,
): UserMessageTurnRunner {
  const {
    context,
    historyManager,
    metadataManager,
    backupController,
    interactionManager,
    flushPendingExternalSkillRefresh,
    triggerMemoryGeneration,
    triggerSkillImprovementUsage,
    steerCoordinator,
    classifyTurnError,
    buildUserMessageContent,
    validateUploadedFileAttachments,
    onAdvancedMemoryChanged,
    waitForLiveSteerSettlement,
    onUserMessageAccepted,
  } = deps;

  const updateSessionExecutionState = (executionState: AgentExecutionState) => {
    if (context.state.sessionInfo.executionState === undefined) return;
    metadataManager.updateSessionInfo({ executionState });
  };

  const settledExecutionState = (): AgentExecutionState => {
    if (context.state.persistenceStatus === "closed") return "closed";
    return context.state.currentTurnOutcome === "error" ? "errored" : "completed";
  };

  const log = (line: string) => {
    context.emit({ type: "log", sessionId: context.id, line });
  };

  const askUser = async (question: string, options?: string[]) => {
    return await interactionManager.askUser(question, options);
  };

  const approveCommand = async (command: string, opts?: ApproveCommandOptions) => {
    return await interactionManager.approveCommand(command, opts);
  };

  const updateTodos = (todos: import("../../../types").TodoItem[]) => {
    context.state.todos = todos;
    context.emit({ type: "todos", sessionId: context.id, todos });
    context.queuePersistSessionSnapshot("session.todos_updated");
  };

  const emitTaskLockIfPresent = (): boolean => {
    const taskLock = getSessionTaskLock(
      context.deps.sessionDb,
      context.id,
      context.deps.getLiveSessionParentIdImpl,
    );
    if (!taskLock) return false;
    context.emitError("task_locked", "session", taskLock.message, taskLock.data);
    return true;
  };
  const makeAssertCanMaterializeUserContent = () => {
    return () => {
      const taskLock = getSessionTaskLock(
        context.deps.sessionDb,
        context.id,
        context.deps.getLiveSessionParentIdImpl,
      );
      const interrupted = context.state.abortController?.signal.aborted === true;
      if (taskLock || interrupted) {
        context.state.pendingSteers.splice(0);
        context.state.currentTurnOutcome = "cancelled";
        context.state.acceptingSteers = false;
        if (taskLock) {
          throw makeTaskLockAbortError(taskLock.message, {
            code: "task_locked",
            source: "session",
            message: taskLock.message,
            data: taskLock.data,
          });
        }
        const message = "Turn was interrupted before it could be started.";
        throw makeTaskLockAbortError(message, {
          code: "validation_failed",
          source: "session",
          message,
        });
      }
    };
  };

  const sendUserMessage = async (
    text: string,
    clientMessageId?: string,
    displayText?: string,
    attachments?: FileAttachment[],
    inputParts?: OrderedInputPart[],
    references?: TurnReference[],
    opts?: { allowThreadManagementTools?: boolean },
  ) => {
    if (context.state.running) {
      context.emitError("busy", "session", "Agent is busy");
      return;
    }
    if (context.state.costTracker?.isBudgetExceeded()) {
      log(
        "[cost] Rejecting new turn because the session hard-stop budget has already been exceeded.",
      );
      context.emitError(
        "validation_failed",
        "session",
        "Session hard-stop budget has been exceeded. Raise or clear the stop threshold before sending another message.",
      );
      return;
    }
    const attachmentValidationMessage = getTurnAttachmentValidationMessage(attachments);
    if (attachmentValidationMessage) {
      context.emitError("validation_failed", "session", attachmentValidationMessage);
      return;
    }
    try {
      await validateUploadedFileAttachments(attachments);
    } catch (error) {
      const classified = classifyTurnError(error);
      context.emitError(classified.code, classified.source, context.formatError(error));
      return;
    }
    if (emitTaskLockIfPresent()) {
      return;
    }
    const visibleText = displayText ?? resolveUserInputDisplayText(text, attachments);

    context.state.running = true;
    context.state.abortController = new AbortController();
    context.state.acceptingSteers = true;
    const turnStartedAt = Date.now();
    const turnId = makeTurnId();
    context.state.currentTurnId = turnId;
    context.state.turnReferenceInjectionCounter = 0;
    context.state.currentTurnOutcome = "completed";
    context.state.currentTurnMessageStartIndex = context.state.allMessages.length;
    context.state.currentTurnSkillUsages = [];
    const cause: "user_message" | "command" = visibleText.startsWith("/")
      ? "command"
      : "user_message";
    let lastMessagePreview: string | undefined;
    let turnAnnounced = false;
    const includeRawChunks = context.state.config.includeRawChunks ?? true;
    const tracker = {
      startedStepCount: 0,
      streamPartIndex: 0,
      rawStreamEventIndex: 0,
      lastStreamError: null as unknown,
      turnAnnouncedAtMs: null as number | null,
      firstOutputObserved: false,
    };
    const usageAggregator = createTurnUsageAggregator({
      turnId,
      sessionId: context.id,
      provider: context.state.config.provider,
      model: context.state.config.model,
      costTracker: context.state.costTracker ?? undefined,
      emit: (event) => context.emit(event),
    });
    const { mergeUsageFromError, mergeTurnUsage, persistAggregatedUsage } = usageAggregator;
    const invokeRunTurn = createRunTurnInvocation({
      context,
      turnId,
      steerCoordinator,
      log,
      askUser,
      approveCommand,
      updateTodos,
      tracker,
      includeRawChunks,
      onAdvancedMemoryChanged,
      allowThreadManagementTools: opts?.allowThreadManagementTools,
      setAcceptingSteers: (accepting) => {
        context.state.acceptingSteers = accepting;
      },
    });
    try {
      // Apply @-mentioned references BEFORE building the user message so a forced
      // skill's body can be folded into the model-facing text. This is
      // provider-agnostic: stateful interaction APIs reject synthetic tool-call
      // history. The user's typed text stays the UI-visible message (`visibleText`).
      context.state.turnReferencedPlugins = undefined;
      let skillInjectionText = "";
      if (references && references.length > 0) {
        const referencedSkills = await resolveReferencedSkills({ context, references, log });
        skillInjectionText = renderReferencedSkillsInjection(referencedSkills);
        const referencedPlugins = await resolveReferencedPlugins(context, references);
        if (referencedPlugins.length > 0) {
          context.state.turnReferencedPlugins = referencedPlugins;
        }
      }
      const modelFacingText = skillInjectionText ? `${text}\n\n${skillInjectionText}` : text;
      const materialization = createUserContentMaterializationTransaction();
      const assertCanMaterializeUserContent = makeAssertCanMaterializeUserContent();
      try {
        assertCanMaterializeUserContent();
        const userMessageContent = await buildUserMessageContent(
          modelFacingText,
          attachments,
          inputParts,
          {
            assertCanMaterialize: assertCanMaterializeUserContent,
            materialization,
          },
        );
        assertCanMaterializeUserContent();
        if (context.state.persistenceStatus === "closed") {
          context.state.persistenceStatus = "active";
          context.queuePersistSessionSnapshot("session.reopened");
        }
        historyManager.appendMessagesToHistory([{ role: "user", content: userMessageContent }]);
        materialization.commit();
      } catch (error) {
        await materialization.rollback();
        const sessionError = getTaskLockAbortSessionError(error);
        if (sessionError) {
          context.emitError(
            sessionError.code,
            sessionError.source,
            sessionError.message,
            sessionError.data,
          );
        }
        throw error;
      }
      context.emit({
        type: "user_message",
        sessionId: context.id,
        text: visibleText,
        clientMessageId,
      });
      onUserMessageAccepted?.(clientMessageId, turnId);
      metadataManager.maybeGenerateTitleFromQuery(text || visibleText);
      context.queuePersistSessionSnapshot("session.user_message");
      context.emit({
        type: "session_busy",
        sessionId: context.id,
        busy: true,
        turnId,
        cause,
      });
      turnAnnounced = true;
      tracker.turnAnnouncedAtMs = Date.now();
      updateSessionExecutionState("running");
      context.emitTelemetry("agent.turn.started", "ok", {
        sessionId: context.id,
        turnId,
        provider: context.state.config.provider,
        model: context.state.config.model,
      });
      captureProductEvent("turn_started", {
        eventSource: "server",
        provider: context.state.config.provider,
        model: context.state.config.model,
        mcpEnabled: context.state.config.enableMcp === true,
        hasAttachments: (attachments?.length ?? 0) > 0,
        hasReferences: (references?.length ?? 0) > 0,
        attachmentCount: attachments?.length ?? 0,
        referenceCount: references?.length ?? 0,
      });
      let continueSameTurn = true;
      while (continueSameTurn) {
        const remainingSteps = context.state.maxSteps - tracker.startedStepCount;
        if (remainingSteps <= 0) {
          context.state.acceptingSteers = false;
          steerCoordinator.rejectPendingSteers(
            "Active turn reached its max step budget and can no longer accept steering.",
          );
          break;
        }

        const startedStepsBeforePass = tracker.startedStepCount;
        let res: Awaited<ReturnType<typeof invokeRunTurn>>;
        try {
          res = await invokeRunTurn(remainingSteps);
        } catch (error) {
          mergeUsageFromError(error);
          const shouldRetryContinuation =
            supportsProviderManagedContinuationProvider(context.state.config.provider) &&
            context.state.providerState !== null &&
            isInvalidProviderManagedContinuationError(context.state.config.provider, error);

          if (!shouldRetryContinuation) {
            throw error;
          }

          if (context.state.abortController?.signal.aborted) {
            context.state.pendingSteers.splice(0);
            context.state.currentTurnOutcome = "cancelled";
            context.state.acceptingSteers = false;
            continueSameTurn = false;
            continue;
          }

          log(
            `[warn] stored ${context.state.config.provider} continuation handle was rejected; retrying from local transcript`,
          );
          context.state.providerState = null;
          context.queuePersistSessionSnapshot("session.provider_state_invalidated");
          try {
            res = await invokeRunTurn(remainingSteps, null);
          } catch (retryError) {
            mergeUsageFromError(retryError);
            throw retryError;
          }
        }

        if (context.state.abortController?.signal.aborted) {
          mergeTurnUsage(res.usage);
          context.state.pendingSteers.splice(0);
          context.state.currentTurnOutcome = "cancelled";
          context.state.acceptingSteers = false;
          continueSameTurn = false;
          continue;
        }

        if (tracker.startedStepCount === startedStepsBeforePass) {
          tracker.startedStepCount += 1;
          context.state.acceptingSteers = tracker.startedStepCount < context.state.maxSteps;
        }

        if (supportsProviderManagedContinuationProvider(context.state.config.provider)) {
          context.state.providerState = res.providerState ?? null;
        }

        const out =
          (res.text || "").trim() || extractAssistantTextFromResponseMessages(res.responseMessages);
        const malformedToolCallFailure = detectMalformedToolCallFailure(res.responseMessages, out);
        if (malformedToolCallFailure) {
          throw Object.assign(new Error(malformedToolCallFailure), {
            code: "provider_error" as const,
            source: "provider" as const,
          });
        }

        historyManager.appendMessagesToHistory(res.responseMessages);
        context.queuePersistSessionSnapshot("session.turn_response");

        const reasoning = (res.reasoningText || "").trim();
        if (reasoning) {
          const kind = reasoningModeForProvider(context.state.config.provider);
          context.emit({
            type: "reasoning",
            sessionId: context.id,
            kind,
            text: reasoning,
          });
        }

        if (out) {
          lastMessagePreview = normalizePreviewText(out);
          context.emit({ type: "assistant_message", sessionId: context.id, text: out });
        }

        mergeTurnUsage(res.usage);

        if (tracker.startedStepCount >= context.state.maxSteps) {
          context.state.acceptingSteers = false;
          steerCoordinator.rejectPendingSteers(
            "Active turn reached its max step budget and can no longer accept steering.",
          );
          continueSameTurn = false;
          continue;
        }

        await new Promise((resolve) => setTimeout(resolve, 0));
        if (context.state.abortController?.signal.aborted) {
          context.state.pendingSteers.splice(0);
          context.state.currentTurnOutcome = "cancelled";
          continueSameTurn = false;
          context.state.acceptingSteers = false;
          continue;
        }

        const lateSteersCommitted =
          (await steerCoordinator.commitPendingSteers()).committedCount > 0;
        continueSameTurn = lateSteersCommitted && !context.state.abortController?.signal.aborted;
        context.state.acceptingSteers =
          continueSameTurn && tracker.startedStepCount < context.state.maxSteps;
      }

      persistAggregatedUsage();

      const durationMs = Date.now() - turnStartedAt;
      if (context.state.currentTurnOutcome === "completed") {
        context.emitTelemetry(
          "agent.turn.completed",
          "ok",
          {
            sessionId: context.id,
            turnId,
            provider: context.state.config.provider,
            model: context.state.config.model,
          },
          durationMs,
        );
        captureProductEvent("turn_completed", {
          eventSource: "server",
          provider: context.state.config.provider,
          model: context.state.config.model,
          status: "completed",
          durationMs,
          toolCount: tracker.startedStepCount,
        });
      } else if (context.state.currentTurnOutcome === "cancelled") {
        context.emitTelemetry(
          "agent.turn.aborted",
          "ok",
          {
            sessionId: context.id,
            turnId,
            provider: context.state.config.provider,
            model: context.state.config.model,
          },
          durationMs,
        );
      }
    } catch (err) {
      const actualErr =
        tracker.lastStreamError && context.formatError(err).includes("No output generated")
          ? tracker.lastStreamError
          : err;

      const partialTurnSource = resolvePartialTurnProgressSource(actualErr, err);
      const abortLike = isAbortLikeError(context, actualErr);
      const partialMessages = getPartialTurnResponseMessages(partialTurnSource);
      if (!abortLike && partialMessages && partialMessages.length > 0) {
        historyManager.appendMessagesToHistory(partialMessages);
        context.queuePersistSessionSnapshot("session.turn_response");
      }
      mergeUsageFromError(partialTurnSource);
      if (partialTurnSource !== err) {
        mergeUsageFromError(err);
      }
      const partialProviderState = getPartialTurnProviderState(partialTurnSource);
      if (
        !abortLike &&
        partialProviderState &&
        supportsProviderManagedContinuationProvider(context.state.config.provider)
      ) {
        context.state.providerState = partialProviderState;
      }

      const msg = context.formatError(actualErr);
      if (!abortLike) {
        context.state.currentTurnOutcome = "error";
        const classified = classifyTurnError(actualErr);
        context.emitError(classified.code, classified.source, msg);
        lastMessagePreview = normalizePreviewText(msg);
        if (turnAnnounced) {
          context.emitTelemetry(
            "agent.turn.failed",
            "error",
            {
              sessionId: context.id,
              turnId,
              provider: context.state.config.provider,
              model: context.state.config.model,
              error: msg,
            },
            Date.now() - turnStartedAt,
          );
          captureProductEvent("turn_failed", {
            eventSource: "server",
            provider: context.state.config.provider,
            model: context.state.config.model,
            status: "failed",
            errorCategory: classified.code,
            durationMs: Date.now() - turnStartedAt,
          });
        }
      } else {
        context.state.currentTurnOutcome = "cancelled";
        if (turnAnnounced) {
          context.emitTelemetry(
            "agent.turn.aborted",
            "ok",
            {
              sessionId: context.id,
              turnId,
              provider: context.state.config.provider,
              model: context.state.config.model,
            },
            Date.now() - turnStartedAt,
          );
        }
      }
    } finally {
      persistAggregatedUsage();
      context.state.acceptingSteers = false;
      context.state.activeSteerHandler = null;
      const pendingSteersRejected = context.state.pendingSteers.length > 0;
      context.state.pendingSteers.splice(0);
      if (userMessageTurnFinalizerCheckpointHook) {
        await runUserMessageTurnFinalizerCheckpoint({
          phase: "steer_admission_closed",
          sessionId: context.id,
          turnId,
        });
      }
      await waitForLiveSteerSettlement?.();
      if (pendingSteersRejected) {
        context.emitError(
          "validation_failed",
          "session",
          "Active turn ended before pending steers could be accepted.",
        );
      }
      context.state.turnReferencedPlugins = undefined;
      if (turnAnnounced) {
        metadataManager.updateSessionInfo({
          executionState: settledExecutionState(),
          lastMessagePreview,
        });
        context.emit({
          type: "session_busy",
          sessionId: context.id,
          busy: false,
          turnId,
          outcome: context.state.currentTurnOutcome,
        });
      }
      context.state.running = false;
      context.state.abortController = null;
      context.state.currentTurnId = null;
      if (turnAnnounced) {
        void flushPendingExternalSkillRefresh().catch(() => {
          // refresh helper already emits skill refresh errors.
        });
        if (backupController.isBackupsEnabled()) {
          void backupController.takeAutomaticSessionCheckpoint().catch(() => {
            // takeAutomaticSessionCheckpoint already emits backup errors/telemetry.
          });
        }
        // Fire advanced memory generation for completed turns only. Fire-and-forget;
        // never blocks the user-facing turn (no-op unless advanced memory is on).
        if (context.state.currentTurnOutcome === "completed") {
          triggerMemoryGeneration?.();
          triggerSkillImprovementUsage?.();
        }
      }
    }
  };

  return { sendUserMessage };
}

export const __internal = {
  setUserMessageTurnFinalizerCheckpointHookForTests(
    hook: UserMessageTurnFinalizerCheckpointHook | null,
  ): () => void {
    const previous = userMessageTurnFinalizerCheckpointHook;
    userMessageTurnFinalizerCheckpointHook = hook;
    return () => {
      if (userMessageTurnFinalizerCheckpointHook === hook) {
        userMessageTurnFinalizerCheckpointHook = previous;
      }
    };
  },
  resetUserMessageTurnFinalizerCheckpointHookForTests(): void {
    userMessageTurnFinalizerCheckpointHook = null;
  },
};
