import { z } from "zod";
import {
  MODEL_STREAM_NORMALIZER_VERSION,
  normalizeModelStreamPart,
  reasoningModeForProvider,
} from "../modelStream";
import { supportsOpenAiContinuation } from "../../shared/openaiContinuation";
import { supportsProviderManagedContinuationProvider } from "../../shared/providerContinuation";
import type { AgentExecutionState } from "../../shared/agents";
import type { TurnUsage } from "../../session/costTracker";
import {
  SERVER_ERROR_CODES,
  SERVER_ERROR_SOURCES,
  type ModelMessage,
  type ServerErrorCode,
  type ServerErrorSource,
} from "../../types";
import type { HistoryManager } from "./HistoryManager";
import type { InteractionManager } from "./InteractionManager";
import type { SessionBackupController } from "./SessionBackupController";
import type { SessionContext } from "./SessionContext";
import type { SessionMetadataManager } from "./SessionMetadataManager";

const assistantMessageContentArraySchema = z.array(z.unknown());
const assistantMessageContentPartSchema = z.object({
  type: z.enum(["text", "output_text"]),
  text: z.string(),
  phase: z.string().optional(),
}).passthrough();
const errorWithCodeSchema = z.object({ code: z.unknown() }).passthrough();
const errorWithCodeAndSourceSchema = z.object({
  code: z.string(),
  source: z.string().optional(),
}).passthrough();
const serverErrorCodeSet = new Set<string>(SERVER_ERROR_CODES);
const serverErrorSourceSet = new Set<string>(SERVER_ERROR_SOURCES);
const defaultSourceByErrorCode: Partial<Record<ServerErrorCode, ServerErrorSource>> = {
  busy: "session",
  validation_failed: "session",
  permission_denied: "permissions",
  provider_error: "provider",
  backup_error: "backup",
  observability_error: "observability",
  internal_error: "session",
};

type ClassifiedTurnError = { code: ServerErrorCode; source: ServerErrorSource };

function isServerErrorCode(value: string): value is ServerErrorCode {
  return serverErrorCodeSet.has(value);
}

function isServerErrorSource(value: string): value is ServerErrorSource {
  return serverErrorSourceSet.has(value);
}

function classifyStructuredTurnError(err: unknown): ClassifiedTurnError | null {
  const parsed = errorWithCodeAndSourceSchema.safeParse(err);
  if (!parsed.success) return null;

  const { code, source } = parsed.data;
  if (!isServerErrorCode(code)) return null;
  if (source && isServerErrorSource(source)) {
    return { code, source };
  }

  return {
    code,
    source: defaultSourceByErrorCode[code] ?? "session",
  };
}

function makeId(): string {
  return crypto.randomUUID();
}

function extractAssistantTextFromMessageContent(content: unknown): string {
  if (typeof content === "string") return content;
  const parsedContent = assistantMessageContentArraySchema.safeParse(content);
  if (!parsedContent.success) return "";

  const chunks: string[] = [];
  for (const part of parsedContent.data) {
    const parsedPart = assistantMessageContentPartSchema.safeParse(part);
    if (!parsedPart.success) continue;
    if (parsedPart.data.phase === "commentary") continue;
    if (parsedPart.data.text.length > 0) chunks.push(parsedPart.data.text);
  }
  return chunks.join("");
}

function extractAssistantTextFromResponseMessages(messages: Array<{ role: string; content: unknown }>): string {
  const chunks: string[] = [];
  for (const message of messages) {
    if (message.role !== "assistant") continue;
    const text = extractAssistantTextFromMessageContent(message.content).trim();
    if (!text) continue;
    chunks.push(text);
  }
  return chunks.join("\n\n");
}

type ToolExecutionDiagnostics = {
  totalResults: number;
  successfulResults: number;
  unknownToolErrors: number;
  invalidToolInputErrors: number;
  malformedToolNameErrors: number;
  errorMessages: string[];
};

function normalizePreviewText(text: string, maxChars = 800): string | undefined {
  const trimmed = text.trim();
  if (!trimmed) return undefined;
  if (trimmed.length <= maxChars) return trimmed;
  return `${trimmed.slice(0, maxChars - 1)}…`;
}

function extractToolExecutionDiagnostics(messages: Array<{ role: string; content: unknown }>): ToolExecutionDiagnostics {
  const diagnostics: ToolExecutionDiagnostics = {
    totalResults: 0,
    successfulResults: 0,
    unknownToolErrors: 0,
    invalidToolInputErrors: 0,
    malformedToolNameErrors: 0,
    errorMessages: [],
  };

  for (const message of messages) {
    if (message.role !== "tool" || !Array.isArray(message.content)) continue;

    for (const part of message.content) {
      if (!part || typeof part !== "object") continue;
      const record = part as Record<string, unknown>;
      if (record.type !== "tool-result") continue;

      diagnostics.totalResults += 1;
      const isError = record.isError === true;
      if (!isError) {
        diagnostics.successfulResults += 1;
        continue;
      }

      const toolName = typeof record.toolName === "string" ? record.toolName : "";
      const output = typeof record.output === "object" && record.output !== null
        ? record.output as Record<string, unknown>
        : null;
      const messageText = typeof output?.value === "string" ? output.value.trim() : "";
      if (messageText) {
        diagnostics.errorMessages.push(messageText);
      }
      if (/^tool(?:[<\s]|$)/i.test(toolName)) {
        diagnostics.malformedToolNameErrors += 1;
      }
      if (/tool .* not found/i.test(messageText)) {
        diagnostics.unknownToolErrors += 1;
      }
      if (/invalid input|expected .* received|too small:/i.test(messageText)) {
        diagnostics.invalidToolInputErrors += 1;
      }
    }
  }

  return diagnostics;
}

function detectMalformedToolCallFailure(
  messages: Array<{ role: string; content: unknown }>,
  assistantText: string,
): string | null {
  const diagnostics = extractToolExecutionDiagnostics(messages);
  if (diagnostics.totalResults === 0) return null;
  if (diagnostics.successfulResults > 0) return null;
  if (diagnostics.errorMessages.length < 3) return null;

  const hasFormattingComplaint = /function call format|tool call format|proper parameters/i.test(assistantText);
  const repeatedToolFailures =
    diagnostics.unknownToolErrors + diagnostics.invalidToolInputErrors + diagnostics.malformedToolNameErrors >= 3;
  if (!hasFormattingComplaint && !repeatedToolFailures) return null;

  const sampleErrors = [...new Set(diagnostics.errorMessages)]
    .slice(0, 2)
    .join("; ");
  return sampleErrors
    ? `Model failed to produce valid tool calls after repeated attempts: ${sampleErrors}`
    : "Model failed to produce valid tool calls after repeated attempts.";
}

function isInvalidOpenAiContinuationError(error: unknown): boolean {
  const text = error instanceof Error ? error.message : String(error);
  const normalized = text.toLowerCase();
  const mentionsPreviousResponse =
    normalized.includes("previous_response_id") ||
    normalized.includes("previous response") ||
    normalized.includes("response_id");
  if (!mentionsPreviousResponse) return false;

  return (
    normalized.includes("not found") ||
    normalized.includes("invalid") ||
    normalized.includes("expired") ||
    normalized.includes("unknown") ||
    normalized.includes("does not exist")
  );
}

function isInvalidGoogleContinuationError(error: unknown): boolean {
  const text = error instanceof Error ? error.message : String(error);
  const normalized = text.toLowerCase();
  const mentionsInteractionId =
    normalized.includes("interaction_id") ||
    normalized.includes("interaction id") ||
    normalized.includes("previous_interaction_id") ||
    normalized.includes("previous interaction");
  if (!mentionsInteractionId) return false;

  return (
    normalized.includes("not found") ||
    normalized.includes("invalid") ||
    normalized.includes("expired") ||
    normalized.includes("unknown") ||
    normalized.includes("does not exist")
  );
}

function isInvalidProviderManagedContinuationError(provider: unknown, error: unknown): boolean {
  if (supportsOpenAiContinuation(provider)) {
    return isInvalidOpenAiContinuationError(error);
  }
  if (provider === "google") {
    return isInvalidGoogleContinuationError(error);
  }
  return false;
}

function mergeTurnUsage(
  total: TurnUsage | undefined,
  next: TurnUsage | undefined,
): TurnUsage | undefined {
  if (!total) return next;
  if (!next) return total;

  return {
    promptTokens: total.promptTokens + next.promptTokens,
    completionTokens: total.completionTokens + next.completionTokens,
    totalTokens: total.totalTokens + next.totalTokens,
    ...(typeof total.cachedPromptTokens === "number" || typeof next.cachedPromptTokens === "number"
      ? { cachedPromptTokens: (total.cachedPromptTokens ?? 0) + (next.cachedPromptTokens ?? 0) }
      : {}),
    ...(typeof total.estimatedCostUsd === "number" || typeof next.estimatedCostUsd === "number"
      ? { estimatedCostUsd: (total.estimatedCostUsd ?? 0) + (next.estimatedCostUsd ?? 0) }
      : {}),
  };
}

function isStartStepPart(part: unknown): boolean {
  return typeof part === "object" && part !== null && (part as { type?: unknown }).type === "start-step";
}

export class TurnExecutionManager {
  constructor(
    private readonly context: SessionContext,
    private readonly deps: {
      interactionManager: InteractionManager;
      historyManager: HistoryManager;
      metadataManager: SessionMetadataManager;
      backupController: SessionBackupController;
    }
  ) { }

  private updateSessionExecutionState(executionState: AgentExecutionState) {
    if (this.context.state.sessionInfo.executionState === undefined) return;
    this.deps.metadataManager.updateSessionInfo({ executionState });
  }

  private settledExecutionState(): AgentExecutionState {
    if (this.context.state.persistenceStatus === "closed") return "closed";
    return this.context.state.currentTurnOutcome === "error" ? "errored" : "completed";
  }

  async sendSteerMessage(text: string, expectedTurnId: string, clientMessageId?: string) {
    if (!this.context.state.running) {
      this.context.emitError("validation_failed", "session", "No active turn to steer.");
      return;
    }

    const currentTurnId = this.context.state.currentTurnId;
    if (!currentTurnId) {
      this.context.emitError("validation_failed", "session", "Active turn is missing an id.");
      return;
    }

    if (expectedTurnId !== currentTurnId) {
      this.context.emitError("validation_failed", "session", "Active turn mismatch.");
      return;
    }

    if (!this.context.state.acceptingSteers) {
      this.context.emitError("validation_failed", "session", "Active turn no longer accepts steering.");
      return;
    }

    if (text.trim().length === 0) {
      this.context.emitError("validation_failed", "session", "Steer text must be non-empty.");
      return;
    }

    this.context.state.pendingSteers.push({
      text,
      ...(clientMessageId ? { clientMessageId } : {}),
      acceptedAt: new Date().toISOString(),
    });
    this.context.emit({
      type: "steer_accepted",
      sessionId: this.context.id,
      turnId: currentTurnId,
      text,
      ...(clientMessageId ? { clientMessageId } : {}),
    });
  }

  private commitPendingSteers(): ModelMessage[] {
    const drained = this.context.state.pendingSteers.splice(0);
    if (drained.length === 0) return [];

    const steerMessages = drained.map<ModelMessage>((steer) => ({
      role: "user",
      content: steer.text,
    }));
    this.deps.historyManager.appendMessagesToHistory(steerMessages);
    for (const steer of drained) {
      this.context.emit({
        type: "user_message",
        sessionId: this.context.id,
        text: steer.text,
        ...(steer.clientMessageId ? { clientMessageId: steer.clientMessageId } : {}),
      });
    }
    this.context.queuePersistSessionSnapshot("session.steer_committed");
    return steerMessages;
  }

  private drainPendingSteers(stepMessages: ModelMessage[]): { messages: ModelMessage[] } | undefined {
    const steerMessages = this.commitPendingSteers();
    if (steerMessages.length === 0) return undefined;
    return {
      messages: [...stepMessages, ...steerMessages],
    };
  }

  private rejectPendingSteers(message: string) {
    if (this.context.state.pendingSteers.length === 0) return;
    this.context.state.pendingSteers.splice(0);
    this.context.emitError("validation_failed", "session", message);
  }

  async sendUserMessage(text: string, clientMessageId?: string, displayText?: string) {
    if (this.context.state.running) {
      this.context.emitError("busy", "session", "Agent is busy");
      return;
    }
    if (this.context.state.costTracker?.isBudgetExceeded()) {
      this.log("[cost] Rejecting new turn because the session hard-stop budget has already been exceeded.");
      this.context.emitError(
        "validation_failed",
        "session",
        "Session hard-stop budget has been exceeded. Raise or clear the stop threshold before sending another message."
      );
      return;
    }

    if (this.context.state.persistenceStatus === "closed") {
      this.context.state.persistenceStatus = "active";
      this.context.queuePersistSessionSnapshot("session.reopened");
    }

    this.context.state.running = true;
    this.context.state.abortController = new AbortController();
    this.context.state.acceptingSteers = true;
    const turnStartedAt = Date.now();
    const turnId = makeId();
    this.context.state.currentTurnId = turnId;
    this.context.state.currentTurnOutcome = "completed";
    this.updateSessionExecutionState("running");
    const cause: "user_message" | "command" = displayText?.startsWith("/") ? "command" : "user_message";
    let lastStreamError: unknown = null;
    let lastMessagePreview: string | undefined;
    let aggregatedUsage: TurnUsage | undefined;
    let persistedAggregatedUsage = false;
    let startedStepCount = 0;
    let streamPartIndex = 0;
    let rawStreamEventIndex = 0;
    const includeRawChunks = this.context.state.config.includeRawChunks ?? true;
    const persistAggregatedUsage = () => {
      if (persistedAggregatedUsage || !aggregatedUsage) {
        return;
      }

      persistedAggregatedUsage = true;
      this.context.emit({ type: "turn_usage", sessionId: this.context.id, turnId, usage: aggregatedUsage });

      const tracker = this.context.state.costTracker;
      if (tracker) {
        tracker.recordTurn({
          turnId,
          provider: this.context.state.config.provider,
          model: this.context.state.config.model,
          usage: aggregatedUsage,
        });
        this.context.emit({
          type: "session_usage",
          sessionId: this.context.id,
          usage: tracker.getCompactSnapshot(),
        });
      }
    };
    const invokeRunTurn = async (
      maxSteps: number,
      providerStateOverride = this.context.state.providerState,
    ) => {
      const harnessContext = this.context.deps.harnessContextStore.get(this.context.id);
      return await this.context.deps.runTurnImpl({
        config: this.context.state.config,
        system: this.context.state.system,
        messages: this.context.state.messages,
        allMessages: this.context.state.allMessages,
        providerState: providerStateOverride,
        harnessContext,
        prepareStep: async ({ messages }) => this.drainPendingSteers(messages),
        agentControl:
          this.context.state.sessionInfo.sessionKind === "agent" || !this.context.deps.createAgentSessionImpl
            ? undefined
            : {
                spawn: async ({ message, role, model, reasoningEffort, forkContext }) =>
                  await this.context.deps.createAgentSessionImpl!({
                    parentSessionId: this.context.id,
                    parentConfig: this.context.state.config,
                    message,
                    ...(role ? { role } : {}),
                    ...(model ? { model } : {}),
                    ...(reasoningEffort ? { reasoningEffort } : {}),
                    ...(forkContext !== undefined ? { forkContext } : {}),
                    parentDepth: typeof this.context.state.sessionInfo.depth === "number" ? this.context.state.sessionInfo.depth : 0,
                  }),
                list: async () =>
                  await (this.context.deps.listAgentSessionsImpl?.(this.context.id) ?? Promise.resolve([])),
                sendInput: async ({ agentId, message, interrupt }) => {
                  if (!this.context.deps.sendAgentInputImpl) {
                    throw new Error("Child-agent input is unavailable.");
                  }
                  await this.context.deps.sendAgentInputImpl({
                    parentSessionId: this.context.id,
                    agentId,
                    message,
                    ...(interrupt !== undefined ? { interrupt } : {}),
                  });
                },
                wait: async ({ agentIds, timeoutMs }) => {
                  if (!this.context.deps.waitForAgentImpl) {
                    throw new Error("Child-agent waiting is unavailable.");
                  }
                  return await this.context.deps.waitForAgentImpl({
                    parentSessionId: this.context.id,
                    agentIds,
                    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
                  });
                },
                resume: async ({ agentId }) => {
                  if (!this.context.deps.resumeAgentImpl) {
                    throw new Error("Child-agent resume is unavailable.");
                  }
                  return await this.context.deps.resumeAgentImpl({
                    parentSessionId: this.context.id,
                    agentId,
                  });
                },
                close: async ({ agentId }) => {
                  if (!this.context.deps.closeAgentImpl) {
                    throw new Error("Child-agent closing is unavailable.");
                  }
                  return await this.context.deps.closeAgentImpl({
                    parentSessionId: this.context.id,
                    agentId,
                  });
                },
              },
        log: (line) => this.log(line),
        askUser: (q, opts) => this.askUser(q, opts),
        approveCommand: (cmd) => this.approveCommand(cmd),
        updateTodos: (todos) => this.updateTodos(todos),
        discoveredSkills: this.context.state.discoveredSkills,
        maxSteps,
        enableMcp: this.context.state.config.enableMcp,
        spawnDepth: typeof this.context.state.sessionInfo.depth === "number" ? this.context.state.sessionInfo.depth : 0,
        agentRole: this.context.state.sessionInfo.role,
        telemetryContext: {
          functionId: "session.turn",
          metadata: {
            sessionId: this.context.id,
            turnId,
          },
        },
        abortSignal: this.context.state.abortController!.signal,
        includeRawChunks,
        costTracker: this.context.state.costTracker ?? undefined,
        onSessionUsageBudgetUpdated: (snapshot) => {
          this.context.emit({
            type: "session_usage",
            sessionId: this.context.id,
            usage: this.context.state.costTracker?.getCompactSnapshot() ?? snapshot,
          });
          this.context.queuePersistSessionSnapshot("session.usage_budget_updated");
        },
        onModelError: async (error) => {
          lastStreamError = error;
          this.context.emitTelemetry("agent.stream.error", "error", {
            sessionId: this.context.id,
            provider: this.context.state.config.provider,
            model: this.context.state.config.model,
            error: this.context.formatError(error),
          });
        },
        onModelAbort: async () => {
          this.context.emitTelemetry("agent.stream.aborted", "ok", {
            sessionId: this.context.id,
            provider: this.context.state.config.provider,
            model: this.context.state.config.model,
          });
        },
        onModelRawEvent: async (rawEvent) => {
          const index = rawStreamEventIndex++;
          const eventPayload = {
            type: "model_stream_raw" as const,
            sessionId: this.context.id,
            turnId,
            index,
            provider: this.context.state.config.provider,
            model: this.context.state.config.model,
            format: rawEvent.format,
            normalizerVersion: MODEL_STREAM_NORMALIZER_VERSION,
            event: rawEvent.event,
          };
          this.context.emit(eventPayload);
          await this.context.deps.sessionDb?.persistModelStreamChunk({
            sessionId: this.context.id,
            turnId,
            chunkIndex: index,
            ts: new Date().toISOString(),
            provider: this.context.state.config.provider,
            model: this.context.state.config.model,
            rawFormat: rawEvent.format,
            normalizerVersion: MODEL_STREAM_NORMALIZER_VERSION,
            rawEvent: rawEvent.event,
          });
        },
        onModelStreamPart: async (rawPart) => {
          if (isStartStepPart(rawPart)) {
            startedStepCount += 1;
            this.context.state.acceptingSteers = startedStepCount < this.context.state.maxSteps;
          }

          const partIndex = streamPartIndex++;
          const normalized = normalizeModelStreamPart(rawPart, {
            provider: this.context.state.config.provider,
            includeRawPart: includeRawChunks,
            fallbackIdSeed: turnId,
            rawPartMode: process.env.COWORK_MODEL_STREAM_RAW_MODE === "full" ? "full" : "sanitized",
          });
          if (normalized.partType === "error") {
            lastStreamError = normalized.part.error;
          }
          this.context.emit({
            type: "model_stream_chunk",
            sessionId: this.context.id,
            turnId,
            index: partIndex,
            provider: this.context.state.config.provider,
            model: this.context.state.config.model,
            normalizerVersion: normalized.normalizerVersion,
            partType: normalized.partType,
            part: normalized.part,
            ...(normalized.rawPart !== undefined ? { rawPart: normalized.rawPart } : {}),
          });
        },
      });
    };
    try {
      this.context.emit({ type: "user_message", sessionId: this.context.id, text: displayText ?? text, clientMessageId });
      this.context.emit({ type: "session_busy", sessionId: this.context.id, busy: true, turnId, cause });
      this.context.emitTelemetry("agent.turn.started", "ok", {
        sessionId: this.context.id,
        provider: this.context.state.config.provider,
        model: this.context.state.config.model,
      });
      this.deps.historyManager.appendMessagesToHistory([{ role: "user", content: text }]);
      this.deps.metadataManager.maybeGenerateTitleFromQuery(text);
      this.context.queuePersistSessionSnapshot("session.user_message");
      let continueSameTurn = true;
      while (continueSameTurn) {
        const remainingSteps = this.context.state.maxSteps - startedStepCount;
        if (remainingSteps <= 0) {
          this.context.state.acceptingSteers = false;
          this.rejectPendingSteers("Active turn reached its max step budget and can no longer accept steering.");
          break;
        }

        const startedStepsBeforePass = startedStepCount;
        let res;
        try {
          res = await invokeRunTurn(remainingSteps);
        } catch (error) {
          const shouldRetryContinuation =
            supportsProviderManagedContinuationProvider(this.context.state.config.provider) &&
            this.context.state.providerState !== null &&
            isInvalidProviderManagedContinuationError(this.context.state.config.provider, error);

          if (!shouldRetryContinuation) {
            throw error;
          }

          this.log(
            `[warn] stored ${this.context.state.config.provider} continuation handle was rejected; retrying from local transcript`
          );
          this.context.state.providerState = null;
          this.context.queuePersistSessionSnapshot("session.provider_state_invalidated");
          res = await invokeRunTurn(remainingSteps, null);
        }

        if (startedStepCount === startedStepsBeforePass) {
          startedStepCount += 1;
          this.context.state.acceptingSteers = startedStepCount < this.context.state.maxSteps;
        }

        if (supportsProviderManagedContinuationProvider(this.context.state.config.provider)) {
          this.context.state.providerState = res.providerState ?? null;
        }

        const out =
          (res.text || "").trim() ||
          extractAssistantTextFromResponseMessages(res.responseMessages);
        const malformedToolCallFailure = detectMalformedToolCallFailure(res.responseMessages, out);
        if (malformedToolCallFailure) {
          throw Object.assign(new Error(malformedToolCallFailure), {
            code: "provider_error" as const,
            source: "provider" as const,
          });
        }

        this.deps.historyManager.appendMessagesToHistory(res.responseMessages);
        this.context.queuePersistSessionSnapshot("session.turn_response");

        const reasoning = (res.reasoningText || "").trim();
        if (reasoning) {
          const kind = reasoningModeForProvider(this.context.state.config.provider);
          this.context.emit({ type: "reasoning", sessionId: this.context.id, kind, text: reasoning });
        }

        if (out) {
          lastMessagePreview = normalizePreviewText(out);
          this.context.emit({ type: "assistant_message", sessionId: this.context.id, text: out });
        }

        aggregatedUsage = mergeTurnUsage(aggregatedUsage, res.usage);

        if (startedStepCount >= this.context.state.maxSteps) {
          this.context.state.acceptingSteers = false;
          this.rejectPendingSteers("Active turn reached its max step budget and can no longer accept steering.");
          continueSameTurn = false;
          continue;
        }

        await new Promise((resolve) => setTimeout(resolve, 0));
        if (this.context.state.abortController?.signal.aborted) {
          this.context.state.pendingSteers.splice(0);
          continueSameTurn = false;
          this.context.state.acceptingSteers = false;
          continue;
        }

        const lateSteersCommitted = this.commitPendingSteers().length > 0;
        continueSameTurn =
          lateSteersCommitted &&
          !this.context.state.abortController?.signal.aborted;
        this.context.state.acceptingSteers =
          continueSameTurn &&
          startedStepCount < this.context.state.maxSteps;
      }

      persistAggregatedUsage();

      this.context.emitTelemetry(
        "agent.turn.completed",
        "ok",
        {
          sessionId: this.context.id,
          provider: this.context.state.config.provider,
          model: this.context.state.config.model,
        },
        Date.now() - turnStartedAt
      );
    } catch (err) {
      // If the model pipeline reported no output but we saw a stream error chunk, surface the stream error instead.
      const actualErr = (lastStreamError && this.context.formatError(err).includes("No output generated"))
        ? lastStreamError
        : err;
      const msg = this.context.formatError(actualErr);
      if (!this.isAbortLikeError(actualErr)) {
        this.context.state.currentTurnOutcome = "error";
        const classified = this.classifyTurnError(actualErr);
        this.context.emitError(classified.code, classified.source, msg);
        lastMessagePreview = normalizePreviewText(msg);
        this.context.emitTelemetry(
          "agent.turn.failed",
          "error",
          {
            sessionId: this.context.id,
            provider: this.context.state.config.provider,
            model: this.context.state.config.model,
            error: msg,
          },
          Date.now() - turnStartedAt
        );
      } else {
        this.context.state.currentTurnOutcome = "cancelled";
        this.context.emitTelemetry(
          "agent.turn.aborted",
          "ok",
          {
            sessionId: this.context.id,
            provider: this.context.state.config.provider,
            model: this.context.state.config.model,
          },
          Date.now() - turnStartedAt
        );
      }
    } finally {
      persistAggregatedUsage();
      this.context.state.acceptingSteers = false;
      this.context.state.pendingSteers.splice(0);
      this.deps.metadataManager.updateSessionInfo({
        executionState: this.settledExecutionState(),
        lastMessagePreview,
      });
      this.context.emit({
        type: "session_busy",
        sessionId: this.context.id,
        busy: false,
        turnId,
        outcome: this.context.state.currentTurnOutcome,
      });
      this.context.state.running = false;
      this.context.state.abortController = null;
      this.context.state.currentTurnId = null;
      void this.deps.backupController.takeAutomaticSessionCheckpoint().catch(() => {
        // takeAutomaticSessionCheckpoint already emits backup errors/telemetry.
      });
    }
  }

  handleAskResponse(requestId: string, answer: string): boolean {
    return this.deps.interactionManager.handleAskResponse(requestId, answer);
  }

  handleApprovalResponse(requestId: string, approved: boolean): boolean {
    return this.deps.interactionManager.handleApprovalResponse(requestId, approved);
  }

  cancel(opts?: { includeSubagents?: boolean }) {
    if (opts?.includeSubagents === true && (this.context.state.sessionInfo.sessionKind ?? "root") === "root") {
      this.context.deps.cancelAgentSessionsImpl?.(this.context.id);
    }
    if (!this.context.state.running) return;
    if (this.context.state.abortController) {
      this.context.state.abortController.abort();
    }
    this.deps.interactionManager.rejectAllPending("Cancelled by user");
  }

  private classifyTurnError(err: unknown): ClassifiedTurnError {
    const structured = classifyStructuredTurnError(err);
    if (structured) return structured;

    const message = this.context.formatError(err);
    const m = message.toLowerCase();
    const includesAny = (...needles: string[]) => needles.some((needle) => m.includes(needle));

    if (
      includesAny(
        "blocked: path is outside",
        "blocked: canonical target resolves outside",
        "outside allowed directories",
        "outside allowed roots",
        "blocked private/internal host",
        "blocked url protocol",
        "blocked url credentials",
        "glob blocked:"
      )
    ) {
      return { code: "permission_denied", source: "permissions" };
    }

    if (includesAny("observability", "traceql", "promql", "logql")) {
      return { code: "observability_error", source: "observability" };
    }

    if (includesAny("oauth", "api key", "unsupported provider")) {
      return { code: "provider_error", source: "provider" };
    }

    if (m.includes("unknown checkpoint id")) {
      return { code: "validation_failed", source: "session" };
    }

    if (includesAny("checkpoint", "session backup")) {
      return { code: "backup_error", source: "backup" };
    }

    if (includesAny("is required", "invalid ")) {
      return { code: "validation_failed", source: "session" };
    }

    return { code: "internal_error", source: "session" };
  }

  private isAbortLikeError(err: unknown): boolean {
    if (this.context.state.abortController?.signal.aborted) return true;
    if (err instanceof DOMException && err.name === "AbortError") return true;

    const parsedCode = errorWithCodeSchema.safeParse(err);
    const code = parsedCode.success ? parsedCode.data.code : undefined;
    if (code === "ABORT_ERR") return true;

    const msg = this.context.formatError(err).toLowerCase();
    return msg.includes("abort") || msg.includes("cancel");
  }

  private log(line: string) {
    this.context.emit({ type: "log", sessionId: this.context.id, line });
  }

  private async askUser(question: string, options?: string[]) {
    return await this.deps.interactionManager.askUser(question, options);
  }

  private async approveCommand(command: string) {
    return await this.deps.interactionManager.approveCommand(command);
  }

  private updateTodos(todos: import("../../types").TodoItem[]) {
    this.context.state.todos = todos;
    this.context.emit({ type: "todos", sessionId: this.context.id, todos });
    this.context.queuePersistSessionSnapshot("session.todos_updated");
  }
}
