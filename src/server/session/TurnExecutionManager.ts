import { normalizeModelStreamPart, reasoningModeForProvider } from "../modelStream";
import type { HistoryManager } from "./HistoryManager";
import type { InteractionManager } from "./InteractionManager";
import type { SessionBackupController } from "./SessionBackupController";
import type { SessionContext } from "./SessionContext";
import type { SessionMetadataManager } from "./SessionMetadataManager";

function makeId(): string {
  return crypto.randomUUID();
}

function extractAssistantTextFromMessageContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";

  const chunks: string[] = [];
  for (const part of content) {
    if (!part || typeof part !== "object" || Array.isArray(part)) continue;
    const partType = typeof (part as { type?: unknown }).type === "string" ? (part as { type: string }).type : "";
    if (partType !== "text" && partType !== "output_text") continue;
    const text = (part as { text?: unknown }).text;
    if (typeof text === "string" && text.length > 0) {
      chunks.push(text);
    }
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

export class TurnExecutionManager {
  constructor(
    private readonly context: SessionContext,
    private readonly deps: {
      interactionManager: InteractionManager;
      historyManager: HistoryManager;
      metadataManager: SessionMetadataManager;
      backupController: SessionBackupController;
    }
  ) {}

  async sendUserMessage(text: string, clientMessageId?: string, displayText?: string) {
    if (this.context.state.running) {
      this.context.emitError("busy", "session", "Agent is busy");
      return;
    }

    this.context.state.running = true;
    this.context.state.abortController = new AbortController();
    const turnStartedAt = Date.now();
    const turnId = makeId();
    this.context.state.currentTurnId = turnId;
    this.context.state.currentTurnOutcome = "completed";
    const cause: "user_message" | "command" = displayText?.startsWith("/") ? "command" : "user_message";
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

      let streamPartIndex = 0;
      const res = await this.context.deps.runTurnImpl({
        config: this.context.state.config,
        system: this.context.state.system,
        messages: this.context.state.messages,
        log: (line) => this.log(line),
        askUser: (q, opts) => this.askUser(q, opts),
        approveCommand: (cmd) => this.approveCommand(cmd),
        updateTodos: (todos) => this.updateTodos(todos),
        discoveredSkills: this.context.state.discoveredSkills,
        maxSteps: this.context.state.maxSteps,
        enableMcp: this.context.state.config.enableMcp,
        spawnDepth: 0,
        telemetryContext: {
          functionId: "session.turn",
          metadata: {
            sessionId: this.context.id,
            turnId,
          },
        },
        abortSignal: this.context.state.abortController.signal,
        includeRawChunks: true,
        onModelError: async (error) => {
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
        onModelStreamPart: async (rawPart) => {
          const normalized = normalizeModelStreamPart(rawPart, {
            provider: this.context.state.config.provider,
            includeRawPart: true,
          });
          this.context.emit({
            type: "model_stream_chunk",
            sessionId: this.context.id,
            turnId,
            index: streamPartIndex++,
            provider: this.context.state.config.provider,
            model: this.context.state.config.model,
            partType: normalized.partType,
            part: normalized.part,
            ...(normalized.rawPart !== undefined ? { rawPart: normalized.rawPart } : {}),
          });
        },
      });

      this.deps.historyManager.appendMessagesToHistory(res.responseMessages);
      this.context.queuePersistSessionSnapshot("session.turn_response");

      const reasoning = (res.reasoningText || "").trim();
      if (reasoning) {
        const kind = reasoningModeForProvider(this.context.state.config.provider);
        this.context.emit({ type: "reasoning", sessionId: this.context.id, kind, text: reasoning });
      }

      const out =
        (res.text || "").trim() ||
        extractAssistantTextFromResponseMessages(res.responseMessages);
      if (out) this.context.emit({ type: "assistant_message", sessionId: this.context.id, text: out });

      if (res.usage) {
        this.context.emit({ type: "turn_usage", sessionId: this.context.id, turnId, usage: res.usage });
      }

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
      const msg = this.context.formatError(err);
      if (!this.isAbortLikeError(err)) {
        this.context.state.currentTurnOutcome = "error";
        const classified = this.classifyTurnError(err);
        this.context.emitError(classified.code, classified.source, msg);
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

  handleAskResponse(requestId: string, answer: string) {
    this.deps.interactionManager.handleAskResponse(requestId, answer);
  }

  handleApprovalResponse(requestId: string, approved: boolean) {
    this.deps.interactionManager.handleApprovalResponse(requestId, approved);
  }

  cancel() {
    if (!this.context.state.running) return;
    if (this.context.state.abortController) {
      this.context.state.abortController.abort();
    }
    this.deps.interactionManager.rejectAllPending("Cancelled by user");
  }

  private classifyTurnError(err: unknown): { code: import("../../types").ServerErrorCode; source: import("../../types").ServerErrorSource } {
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

    const code = typeof err === "object" && err ? (err as { code?: unknown }).code : undefined;
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
