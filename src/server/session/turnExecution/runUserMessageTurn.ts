import type { AgentExecutionState } from "../../../shared/agents";
import { supportsProviderManagedContinuationProvider } from "../../../shared/providerContinuation";
import type { FileAttachment, OrderedInputPart } from "../../jsonrpc/routes/shared";
import { reasoningModeForProvider } from "../../modelStream";
import type { HistoryManager } from "../HistoryManager";
import type { InteractionManager } from "../InteractionManager";
import type { SessionBackupController } from "../SessionBackupController";
import type { SessionContext } from "../SessionContext";
import type { SessionMetadataManager } from "../SessionMetadataManager";
import { isInvalidProviderManagedContinuationError } from "./continuationPolicy";
import {
  getPartialTurnProviderState,
  getPartialTurnResponseMessages,
  resolvePartialTurnProgressSource,
} from "./partialTurnError";
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
  getTurnAttachmentValidationMessage,
  type UserMessageAttachmentHelpers,
} from "./userMessageAttachments";
import {
  isAbortLikeError,
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
  steerCoordinator: SteerCoordinator;
  classifyTurnError: (err: unknown) => ClassifiedTurnError;
  buildUserMessageContent: UserMessageAttachmentHelpers["buildUserMessageContent"];
  validateUploadedFileAttachments: UserMessageAttachmentHelpers["validateUploadedFileAttachments"];
  getA2uiSurfaceManager?: () => {
    applyUnknown: (
      value: unknown,
      meta?: { reason?: string; toolCallId?: string },
    ) => {
      ok: boolean;
      surfaceId?: string;
      error?: string;
    };
  };
};

export type UserMessageTurnRunner = {
  sendUserMessage: (
    text: string,
    clientMessageId?: string,
    displayText?: string,
    attachments?: FileAttachment[],
    inputParts?: OrderedInputPart[],
  ) => Promise<void>;
};

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
    steerCoordinator,
    classifyTurnError,
    buildUserMessageContent,
    validateUploadedFileAttachments,
    getA2uiSurfaceManager,
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

  const approveCommand = async (command: string) => {
    return await interactionManager.approveCommand(command);
  };

  const updateTodos = (todos: import("../../../types").TodoItem[]) => {
    context.state.todos = todos;
    context.emit({ type: "todos", sessionId: context.id, todos });
    context.queuePersistSessionSnapshot("session.todos_updated");
  };

  const sendUserMessage = async (
    text: string,
    clientMessageId?: string,
    displayText?: string,
    attachments?: FileAttachment[],
    inputParts?: OrderedInputPart[],
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
    const visibleText = displayText ?? resolveUserInputDisplayText(text, attachments);

    if (context.state.persistenceStatus === "closed") {
      context.state.persistenceStatus = "active";
      context.queuePersistSessionSnapshot("session.reopened");
    }

    context.state.running = true;
    context.state.abortController = new AbortController();
    context.state.acceptingSteers = true;
    const turnStartedAt = Date.now();
    const turnId = makeTurnId();
    context.state.currentTurnId = turnId;
    context.state.currentTurnOutcome = "completed";
    updateSessionExecutionState("running");
    const cause: "user_message" | "command" = visibleText.startsWith("/")
      ? "command"
      : "user_message";
    let lastMessagePreview: string | undefined;
    const includeRawChunks = context.state.config.includeRawChunks ?? true;
    const tracker = {
      startedStepCount: 0,
      streamPartIndex: 0,
      rawStreamEventIndex: 0,
      lastStreamError: null as unknown,
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
      getA2uiSurfaceManager,
      log,
      askUser,
      approveCommand,
      updateTodos,
      tracker,
      includeRawChunks,
      setAcceptingSteers: (accepting) => {
        context.state.acceptingSteers = accepting;
      },
    });
    try {
      context.emit({
        type: "user_message",
        sessionId: context.id,
        text: visibleText,
        clientMessageId,
      });
      context.emit({
        type: "session_busy",
        sessionId: context.id,
        busy: true,
        turnId,
        cause,
      });
      context.emitTelemetry("agent.turn.started", "ok", {
        sessionId: context.id,
        provider: context.state.config.provider,
        model: context.state.config.model,
      });

      const userMessageContent = await buildUserMessageContent(text, attachments, inputParts);
      historyManager.appendMessagesToHistory([{ role: "user", content: userMessageContent }]);
      metadataManager.maybeGenerateTitleFromQuery(text || visibleText);
      context.queuePersistSessionSnapshot("session.user_message");
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
          continueSameTurn = false;
          context.state.acceptingSteers = false;
          continue;
        }

        const lateSteersCommitted = (await steerCoordinator.commitPendingSteers()).length > 0;
        continueSameTurn = lateSteersCommitted && !context.state.abortController?.signal.aborted;
        context.state.acceptingSteers =
          continueSameTurn && tracker.startedStepCount < context.state.maxSteps;
      }

      persistAggregatedUsage();

      context.emitTelemetry(
        "agent.turn.completed",
        "ok",
        {
          sessionId: context.id,
          provider: context.state.config.provider,
          model: context.state.config.model,
        },
        Date.now() - turnStartedAt,
      );
    } catch (err) {
      const actualErr =
        tracker.lastStreamError && context.formatError(err).includes("No output generated")
          ? tracker.lastStreamError
          : err;

      const partialTurnSource = resolvePartialTurnProgressSource(actualErr, err);
      const partialMessages = getPartialTurnResponseMessages(partialTurnSource);
      if (partialMessages && partialMessages.length > 0) {
        historyManager.appendMessagesToHistory(partialMessages);
        context.queuePersistSessionSnapshot("session.turn_response");
      }
      mergeUsageFromError(partialTurnSource);
      if (partialTurnSource !== err) {
        mergeUsageFromError(err);
      }
      const partialProviderState = getPartialTurnProviderState(partialTurnSource);
      if (
        partialProviderState &&
        supportsProviderManagedContinuationProvider(context.state.config.provider)
      ) {
        context.state.providerState = partialProviderState;
      }

      const msg = context.formatError(actualErr);
      if (!isAbortLikeError(context, actualErr)) {
        context.state.currentTurnOutcome = "error";
        const classified = classifyTurnError(actualErr);
        context.emitError(classified.code, classified.source, msg);
        lastMessagePreview = normalizePreviewText(msg);
        context.emitTelemetry(
          "agent.turn.failed",
          "error",
          {
            sessionId: context.id,
            provider: context.state.config.provider,
            model: context.state.config.model,
            error: msg,
          },
          Date.now() - turnStartedAt,
        );
      } else {
        context.state.currentTurnOutcome = "cancelled";
        context.emitTelemetry(
          "agent.turn.aborted",
          "ok",
          {
            sessionId: context.id,
            provider: context.state.config.provider,
            model: context.state.config.model,
          },
          Date.now() - turnStartedAt,
        );
      }
    } finally {
      persistAggregatedUsage();
      context.state.acceptingSteers = false;
      context.state.activeSteerHandler = null;
      context.state.pendingSteers.splice(0);
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
      context.state.running = false;
      context.state.abortController = null;
      context.state.currentTurnId = null;
      void flushPendingExternalSkillRefresh().catch(() => {
        // refresh helper already emits skill refresh errors.
      });
      if (backupController.isBackupsEnabled()) {
        void backupController.takeAutomaticSessionCheckpoint().catch(() => {
          // takeAutomaticSessionCheckpoint already emits backup errors/telemetry.
        });
      }
    }
  };

  return { sendUserMessage };
}
