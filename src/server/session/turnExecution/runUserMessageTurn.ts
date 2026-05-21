import path from "node:path";

import { z } from "zod";
import { resolveExperimentalA2uiConfig } from "../../../experimental/a2ui/flags";
import { formatUserInputDisplayText } from "../../../shared/attachments";
import { supportsProviderManagedContinuationProvider } from "../../../shared/providerContinuation";
import type { AgentExecutionState } from "../../../shared/agents";
import type { FileAttachment, OrderedInputPart } from "../../jsonrpc/routes/shared";
import {
  MODEL_STREAM_NORMALIZER_VERSION,
  normalizeModelStreamPart,
  reasoningModeForProvider,
} from "../../modelStream";
import { getAgentRoleShellPolicy } from "../../agents/roles";
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
import type { SteerCoordinator } from "./steerCoordinator";
import {
  detectMalformedToolCallFailure,
  extractAssistantTextFromResponseMessages,
  normalizePreviewText,
} from "./turnResponseParsing";
import { createTurnUsageAggregator } from "./turnUsageAggregator";
import {
  getTurnAttachmentValidationMessage,
  type ClassifiedTurnError,
  type UserMessageAttachmentHelpers,
} from "./userMessageAttachments";

const errorWithCodeSchema = z.object({ code: z.unknown() }).passthrough();

function makeId(): string {
  return crypto.randomUUID();
}

function resolveUserInputDisplayText(
  text: string,
  attachments?: readonly Pick<FileAttachment, "filename">[],
): string {
  return formatUserInputDisplayText(
    text,
    attachments
      ?.map((attachment) => path.basename(attachment.filename))
      .filter((fileName) => fileName && fileName !== "." && fileName !== ".."),
  );
}

function isStartStepPart(part: unknown): boolean {
  return (
    typeof part === "object" && part !== null && (part as { type?: unknown }).type === "start-step"
  );
}

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
      change?: "created" | "updated" | "deleted" | "noop";
      error?: string;
      warning?: string;
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

export function createUserMessageTurnRunner(deps: UserMessageTurnRunnerDeps): UserMessageTurnRunner {
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

  const isAbortLikeError = (err: unknown): boolean => {
    if (context.state.abortController?.signal.aborted) return true;
    if (err instanceof DOMException && err.name === "AbortError") return true;

    const parsedCode = errorWithCodeSchema.safeParse(err);
    const code = parsedCode.success ? parsedCode.data.code : undefined;
    if (code === "ABORT_ERR") return true;

    const msg = context.formatError(err).toLowerCase();
    return msg.includes("abort") || msg.includes("cancel");
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
    const turnId = makeId();
    context.state.currentTurnId = turnId;
    context.state.currentTurnOutcome = "completed";
    updateSessionExecutionState("running");
    const cause: "user_message" | "command" = visibleText.startsWith("/")
      ? "command"
      : "user_message";
    let lastStreamError: unknown = null;
    let lastMessagePreview: string | undefined;
    let startedStepCount = 0;
    let streamPartIndex = 0;
    let rawStreamEventIndex = 0;
    const includeRawChunks = context.state.config.includeRawChunks ?? true;
    const usageAggregator = createTurnUsageAggregator({
      turnId,
      sessionId: context.id,
      provider: context.state.config.provider,
      model: context.state.config.model,
      costTracker: context.state.costTracker ?? undefined,
      emit: (event) => context.emit(event),
    });
    const { mergeUsageFromError, mergeTurnUsage, persistAggregatedUsage } = usageAggregator;
    const invokeRunTurn = async (
      maxSteps: number,
      providerStateOverride = context.state.providerState,
    ) => {
      const harnessContext = context.deps.harnessContextStore.get(context.id);
      return await context.deps.runTurnImpl({
        config: context.state.config,
        system: context.state.system,
        messages: context.state.messages,
        allMessages: context.state.allMessages,
        providerState: providerStateOverride,
        harnessContext,
        prepareStep: async ({ messages }) => steerCoordinator.drainPendingSteers(messages),
        registerSteerHandler: (handler) => {
          context.state.activeSteerHandler = handler;
          return () => {
            if (context.state.activeSteerHandler === handler) {
              context.state.activeSteerHandler = null;
            }
          };
        },
        agentControl:
          context.state.sessionInfo.sessionKind === "agent" ||
          !context.deps.createAgentSessionImpl
            ? undefined
            : {
                spawn: async ({
                  message,
                  role,
                  model,
                  reasoningEffort,
                  nickname,
                  taskType,
                  targetPaths,
                  contextMode,
                  briefing,
                  includeParentTodos,
                  includeHarnessContext,
                  forkContext,
                }) => {
                  const createAgentSession = context.deps.createAgentSessionImpl;
                  if (!createAgentSession) {
                    throw new Error("Child-agent spawning is unavailable.");
                  }
                  return await createAgentSession({
                    parentSessionId: context.id,
                    parentConfig: context.state.config,
                    message,
                    ...(role ? { role } : {}),
                    ...(nickname ? { nickname } : {}),
                    ...(taskType ? { taskType } : {}),
                    ...(targetPaths !== undefined ? { targetPaths } : {}),
                    ...(model ? { model } : {}),
                    ...(reasoningEffort ? { reasoningEffort } : {}),
                    ...(contextMode !== undefined ? { contextMode } : {}),
                    ...(briefing !== undefined ? { briefing } : {}),
                    ...(includeParentTodos !== undefined ? { includeParentTodos } : {}),
                    ...(includeHarnessContext !== undefined ? { includeHarnessContext } : {}),
                    ...(forkContext !== undefined ? { forkContext } : {}),
                    parentDepth:
                      typeof context.state.sessionInfo.depth === "number"
                        ? context.state.sessionInfo.depth
                        : 0,
                  });
                },
                list: async () =>
                  await (context.deps.listAgentSessionsImpl?.(context.id) ?? Promise.resolve([])),
                sendInput: async ({ agentId, message, interrupt }) => {
                  if (!context.deps.sendAgentInputImpl) {
                    throw new Error("Child-agent input is unavailable.");
                  }
                  await context.deps.sendAgentInputImpl({
                    parentSessionId: context.id,
                    agentId,
                    message,
                    ...(interrupt !== undefined ? { interrupt } : {}),
                  });
                },
                wait: async ({ agentIds, timeoutMs, mode }) => {
                  if (!context.deps.waitForAgentImpl) {
                    throw new Error("Child-agent waiting is unavailable.");
                  }
                  return await context.deps.waitForAgentImpl({
                    parentSessionId: context.id,
                    agentIds,
                    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
                    ...(mode !== undefined ? { mode } : {}),
                  });
                },
                inspect: async ({ agentId }) => {
                  if (!context.deps.inspectAgentImpl) {
                    throw new Error("Child-agent inspection is unavailable.");
                  }
                  return await context.deps.inspectAgentImpl({
                    parentSessionId: context.id,
                    agentId,
                  });
                },
                resume: async ({ agentId }) => {
                  if (!context.deps.resumeAgentImpl) {
                    throw new Error("Child-agent resume is unavailable.");
                  }
                  return await context.deps.resumeAgentImpl({
                    parentSessionId: context.id,
                    agentId,
                  });
                },
                close: async ({ agentId }) => {
                  if (!context.deps.closeAgentImpl) {
                    throw new Error("Child-agent closing is unavailable.");
                  }
                  return await context.deps.closeAgentImpl({
                    parentSessionId: context.id,
                    agentId,
                  });
                },
              },
        log: (line) => log(line),
        askUser: (q, opts) => askUser(q, opts),
        approveCommand: (cmd) => approveCommand(cmd),
        updateTodos: (todos) => updateTodos(todos),
        discoveredSkills: context.state.discoveredSkills,
        maxSteps,
        yolo: context.state.yolo,
        enableMcp: context.state.config.enableMcp,
        sessionId: context.id,
        spawnDepth:
          typeof context.state.sessionInfo.depth === "number"
            ? context.state.sessionInfo.depth
            : 0,
        agentRole: context.state.sessionInfo.role,
        shellPolicy: getAgentRoleShellPolicy(context.state.sessionInfo.role),
        telemetryContext: {
          functionId: "session.turn",
          metadata: {
            sessionId: context.id,
            turnId,
          },
        },
        abortSignal: context.state.abortController?.signal,
        includeRawChunks,
        costTracker: context.state.costTracker ?? undefined,
        toolEnv: context.deps.toolEnv,
        ...(resolveExperimentalA2uiConfig(context.state.config) && getA2uiSurfaceManager
          ? {
              applyA2uiEnvelope: (
                envelope: unknown,
                meta?: { reason?: string; toolCallId?: string },
              ) => {
                const manager = getA2uiSurfaceManager?.();
                return (
                  manager?.applyUnknown(envelope, meta) ?? {
                    ok: false,
                    error: "A2UI surface manager is unavailable",
                  }
                );
              },
            }
          : {}),
        onSessionUsageBudgetUpdated: (snapshot) => {
          context.emit({
            type: "session_usage",
            sessionId: context.id,
            usage: context.state.costTracker?.getCompactSnapshot() ?? snapshot,
          });
          context.queuePersistSessionSnapshot("session.usage_budget_updated");
        },
        onModelError: async (error) => {
          lastStreamError = error;
          context.emitTelemetry("agent.stream.error", "error", {
            sessionId: context.id,
            provider: context.state.config.provider,
            model: context.state.config.model,
            error: context.formatError(error),
          });
        },
        onModelAbort: async () => {
          context.emitTelemetry("agent.stream.aborted", "ok", {
            sessionId: context.id,
            provider: context.state.config.provider,
            model: context.state.config.model,
          });
        },
        onModelRawEvent: async (rawEvent) => {
          const index = rawStreamEventIndex++;
          const eventPayload = {
            type: "model_stream_raw" as const,
            sessionId: context.id,
            turnId,
            index,
            provider: context.state.config.provider,
            model: context.state.config.model,
            format: rawEvent.format,
            normalizerVersion: MODEL_STREAM_NORMALIZER_VERSION,
            event: rawEvent.event,
          };
          context.emit(eventPayload);
          await context.deps.sessionDb?.persistModelStreamChunk({
            sessionId: context.id,
            turnId,
            chunkIndex: index,
            ts: new Date().toISOString(),
            provider: context.state.config.provider,
            model: context.state.config.model,
            rawFormat: rawEvent.format,
            normalizerVersion: MODEL_STREAM_NORMALIZER_VERSION,
            rawEvent: rawEvent.event,
          });
        },
        onModelStreamPart: async (rawPart) => {
          if (isStartStepPart(rawPart)) {
            startedStepCount += 1;
            context.state.acceptingSteers = startedStepCount < context.state.maxSteps;
          }

          const partIndex = streamPartIndex++;
          const normalized = normalizeModelStreamPart(rawPart, {
            provider: context.state.config.provider,
            includeRawPart: includeRawChunks,
            fallbackIdSeed: turnId,
            rawPartMode: process.env.COWORK_MODEL_STREAM_RAW_MODE === "full" ? "full" : "sanitized",
          });
          if (normalized.partType === "error") {
            lastStreamError = normalized.part.error;
          }
          context.emit({
            type: "model_stream_chunk",
            sessionId: context.id,
            turnId,
            index: partIndex,
            provider: context.state.config.provider,
            model: context.state.config.model,
            normalizerVersion: normalized.normalizerVersion,
            partType: normalized.partType,
            part: normalized.part,
            ...(normalized.rawPart !== undefined ? { rawPart: normalized.rawPart } : {}),
          });
        },
      });
    };
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
        const remainingSteps = context.state.maxSteps - startedStepCount;
        if (remainingSteps <= 0) {
          context.state.acceptingSteers = false;
          steerCoordinator.rejectPendingSteers(
            "Active turn reached its max step budget and can no longer accept steering.",
          );
          break;
        }

        const startedStepsBeforePass = startedStepCount;
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

        if (startedStepCount === startedStepsBeforePass) {
          startedStepCount += 1;
          context.state.acceptingSteers = startedStepCount < context.state.maxSteps;
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

        if (startedStepCount >= context.state.maxSteps) {
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
        continueSameTurn =
          lateSteersCommitted && !context.state.abortController?.signal.aborted;
        context.state.acceptingSteers =
          continueSameTurn && startedStepCount < context.state.maxSteps;
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
      // If the model pipeline reported no output but we saw a stream error chunk, surface the stream error instead.
      const actualErr =
        lastStreamError && context.formatError(err).includes("No output generated")
          ? lastStreamError
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
      if (!isAbortLikeError(actualErr)) {
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
