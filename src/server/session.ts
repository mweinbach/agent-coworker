import type { ModelMessage } from "ai";
import path from "node:path";

import { connectProvider as connectModelProvider, getAiCoworkerPaths } from "../connect";
import { isProviderName } from "../types";
import type { AgentConfig, TodoItem } from "../types";
import { runTurn } from "../agent";
import { loadSystemPrompt } from "../prompt";
import { createTools } from "../tools";
import { classifyCommand } from "../utils/approval";

import type { ServerEvent } from "./protocol";
import {
  SessionBackupManager,
  type SessionBackupHandle,
  type SessionBackupInitOptions,
  type SessionBackupPublicState,
} from "./sessionBackup";

function makeId(): string {
  return crypto.randomUUID();
}

type SessionBackupFactory = (opts: SessionBackupInitOptions) => Promise<SessionBackupHandle>;

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (v: T) => void;
  reject: (err: unknown) => void;
};

function deferred<T>(): Deferred<T> {
  let resolve!: (v: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

export class AgentSession {
  readonly id: string;

  private config: AgentConfig;
  private system: string;
  private readonly yolo: boolean;
  private readonly emit: (evt: ServerEvent) => void;
  private readonly connectProviderImpl: typeof connectModelProvider;
  private readonly getAiCoworkerPathsImpl: typeof getAiCoworkerPaths;
  private readonly sessionBackupFactory: SessionBackupFactory;

  private messages: ModelMessage[] = [];
  private running = false;
  private connecting = false;

  private readonly pendingAsk = new Map<string, Deferred<string>>();
  private readonly pendingApproval = new Map<string, Deferred<boolean>>();

  private todos: TodoItem[] = [];
  private sessionBackup: SessionBackupHandle | null = null;
  private sessionBackupState: SessionBackupPublicState;
  private readonly sessionBackupInit: Promise<void>;

  constructor(opts: {
    config: AgentConfig;
    system: string;
    yolo?: boolean;
    emit: (evt: ServerEvent) => void;
    connectProviderImpl?: typeof connectModelProvider;
    getAiCoworkerPathsImpl?: typeof getAiCoworkerPaths;
    sessionBackupFactory?: SessionBackupFactory;
  }) {
    this.id = makeId();
    this.config = opts.config;
    this.system = opts.system;
    this.yolo = opts.yolo === true;
    this.emit = opts.emit;
    this.connectProviderImpl = opts.connectProviderImpl ?? connectModelProvider;
    this.getAiCoworkerPathsImpl = opts.getAiCoworkerPathsImpl ?? getAiCoworkerPaths;
    this.sessionBackupFactory = opts.sessionBackupFactory ?? (async (factoryOpts) => await SessionBackupManager.create(factoryOpts));
    this.sessionBackupState = {
      status: "initializing",
      sessionId: this.id,
      workingDirectory: this.config.workingDirectory,
      backupDirectory: null,
      createdAt: new Date().toISOString(),
      originalSnapshot: { kind: "pending" },
      checkpoints: [],
    };
    this.sessionBackupInit = this.initializeSessionBackup();
  }

  getPublicConfig() {
    return {
      provider: this.config.provider,
      model: this.config.model,
      workingDirectory: this.config.workingDirectory,
      outputDirectory: this.config.outputDirectory,
    };
  }

  reset() {
    if (this.running) {
      this.emit({ type: "error", sessionId: this.id, message: "Agent is busy" });
      return;
    }
    this.messages = [];
    this.todos = [];
    this.emit({ type: "todos", sessionId: this.id, todos: [] });
    this.emit({ type: "reset_done", sessionId: this.id });
  }

  listTools() {
    const tools = Object.keys(
      createTools({
        config: this.config,
        log: () => {},
        askUser: async () => "",
        approveCommand: async () => false,
      })
    ).sort();
    this.emit({ type: "tools", sessionId: this.id, tools });
  }

  async setModel(modelIdRaw: string, providerRaw?: AgentConfig["provider"]) {
    const modelId = modelIdRaw.trim();
    if (!modelId) {
      this.emit({ type: "error", sessionId: this.id, message: "Model id is required" });
      return;
    }
    if (this.running) {
      this.emit({ type: "error", sessionId: this.id, message: "Agent is busy" });
      return;
    }

    const nextProvider =
      providerRaw === undefined
        ? this.config.provider
        : isProviderName(providerRaw)
          ? providerRaw
          : null;
    if (!nextProvider) {
      this.emit({ type: "error", sessionId: this.id, message: `Unsupported provider: ${String(providerRaw)}` });
      return;
    }

    this.config = {
      ...this.config,
      provider: nextProvider,
      model: modelId,
      // Keep sub-agent model aligned for now until we expose a dedicated toggle.
      subAgentModel: modelId,
    };

    try {
      this.system = await loadSystemPrompt(this.config);
    } catch (err) {
      this.emit({
        type: "error",
        sessionId: this.id,
        message: `Model updated but failed to refresh prompt: ${String(err)}`,
      });
    }

    this.emit({
      type: "config_updated",
      sessionId: this.id,
      config: this.getPublicConfig(),
    });
  }

  async connectProvider(providerRaw: AgentConfig["provider"], apiKeyRaw?: string) {
    if (this.running) {
      this.emit({ type: "error", sessionId: this.id, message: "Agent is busy" });
      return;
    }
    if (this.connecting) {
      this.emit({ type: "error", sessionId: this.id, message: "Connection flow already running" });
      return;
    }
    if (!isProviderName(providerRaw)) {
      this.emit({ type: "error", sessionId: this.id, message: `Unsupported provider: ${String(providerRaw)}` });
      return;
    }

    this.connecting = true;
    try {
      const userHome = this.config.userAgentDir ? path.dirname(this.config.userAgentDir) : undefined;
      const paths = this.getAiCoworkerPathsImpl({ homedir: userHome });
      const result = await this.connectProviderImpl({
        provider: providerRaw,
        apiKey: apiKeyRaw,
        cwd: this.config.workingDirectory,
        paths,
        oauthStdioMode: "pipe",
        onOauthLine: (line) => this.log(`[connect ${providerRaw}] ${line}`),
      });

      if (!result.ok) {
        this.emit({
          type: "error",
          sessionId: this.id,
          message: result.message,
        });
        return;
      }

      const lines = [`### /connect ${providerRaw}`, "", result.message, "", `- Mode: ${result.mode}`, `- Storage: \`${result.storageFile}\``];
      if (result.maskedApiKey) lines.splice(4, 0, `- Key: \`${result.maskedApiKey}\``);
      if (result.oauthCommand) lines.push(`- OAuth command: \`${result.oauthCommand}\``);
      if (result.oauthCredentialsFile) lines.push(`- OAuth credentials: \`${result.oauthCredentialsFile}\``);
      this.emit({
        type: "assistant_message",
        sessionId: this.id,
        text: lines.join("\n"),
      });
    } catch (err) {
      this.emit({ type: "error", sessionId: this.id, message: `connect failed: ${String(err)}` });
    } finally {
      this.connecting = false;
    }
  }

  handleAskResponse(requestId: string, answer: string) {
    const d = this.pendingAsk.get(requestId);
    if (!d) return;
    this.pendingAsk.delete(requestId);
    d.resolve(answer);
  }

  handleApprovalResponse(requestId: string, approved: boolean) {
    const d = this.pendingApproval.get(requestId);
    if (!d) return;
    this.pendingApproval.delete(requestId);
    d.resolve(approved);
  }

  dispose(reason: string) {
    for (const [id, d] of this.pendingAsk) {
      d.reject(new Error(`Session disposed (${reason})`));
      this.pendingAsk.delete(id);
    }
    for (const [id, d] of this.pendingApproval) {
      d.reject(new Error(`Session disposed (${reason})`));
      this.pendingApproval.delete(id);
    }

    void this.closeSessionBackup();
  }

  private log(line: string) {
    this.emit({ type: "log", sessionId: this.id, line });
  }

  private async askUser(question: string, options?: string[]) {
    const requestId = makeId();
    const d = deferred<string>();
    this.pendingAsk.set(requestId, d);

    this.emit({ type: "ask", sessionId: this.id, requestId, question, options });
    return await d.promise;
  }

  private async approveCommand(command: string) {
    if (this.yolo) return true;

    const classification = classifyCommand(command);
    if (classification.kind === "auto") return true;

    const requestId = makeId();
    const d = deferred<boolean>();
    this.pendingApproval.set(requestId, d);

    this.emit({
      type: "approval",
      sessionId: this.id,
      requestId,
      command,
      dangerous: classification.dangerous,
    });

    return await d.promise;
  }

  private updateTodos = (todos: TodoItem[]) => {
    this.todos = todos;
    this.emit({ type: "todos", sessionId: this.id, todos });
  };

  async getSessionBackupState() {
    await this.sessionBackupInit;
    this.emitSessionBackupState("requested");
  }

  async createManualSessionCheckpoint() {
    if (this.running) {
      this.emit({ type: "error", sessionId: this.id, message: "Agent is busy" });
      return;
    }

    await this.sessionBackupInit;
    if (!this.sessionBackup) {
      const reason = this.sessionBackupState.failureReason ?? "Session backup is unavailable";
      this.emit({ type: "error", sessionId: this.id, message: reason });
      return;
    }

    try {
      await this.sessionBackup.createCheckpoint("manual");
      this.sessionBackupState = this.sessionBackup.getPublicState();
      this.emitSessionBackupState("manual_checkpoint");
    } catch (err) {
      this.emit({ type: "error", sessionId: this.id, message: `manual checkpoint failed: ${String(err)}` });
    }
  }

  async restoreSessionBackup(checkpointId?: string) {
    if (this.running) {
      this.emit({ type: "error", sessionId: this.id, message: "Agent is busy" });
      return;
    }

    await this.sessionBackupInit;
    if (!this.sessionBackup) {
      const reason = this.sessionBackupState.failureReason ?? "Session backup is unavailable";
      this.emit({ type: "error", sessionId: this.id, message: reason });
      return;
    }

    try {
      if (checkpointId) {
        await this.sessionBackup.restoreCheckpoint(checkpointId);
      } else {
        await this.sessionBackup.restoreOriginal();
      }
      this.sessionBackupState = this.sessionBackup.getPublicState();
      this.emitSessionBackupState("restore");
    } catch (err) {
      this.emit({ type: "error", sessionId: this.id, message: `restore failed: ${String(err)}` });
    }
  }

  async deleteSessionCheckpoint(checkpointId: string) {
    if (this.running) {
      this.emit({ type: "error", sessionId: this.id, message: "Agent is busy" });
      return;
    }

    await this.sessionBackupInit;
    if (!this.sessionBackup) {
      const reason = this.sessionBackupState.failureReason ?? "Session backup is unavailable";
      this.emit({ type: "error", sessionId: this.id, message: reason });
      return;
    }

    try {
      const removed = await this.sessionBackup.deleteCheckpoint(checkpointId);
      if (!removed) {
        this.emit({
          type: "error",
          sessionId: this.id,
          message: `Unknown checkpoint id: ${checkpointId}`,
        });
        return;
      }
      this.sessionBackupState = this.sessionBackup.getPublicState();
      this.emitSessionBackupState("delete");
    } catch (err) {
      this.emit({ type: "error", sessionId: this.id, message: `delete checkpoint failed: ${String(err)}` });
    }
  }

  async sendUserMessage(text: string, clientMessageId?: string) {
    if (this.running) {
      this.emit({ type: "error", sessionId: this.id, message: "Agent is busy" });
      return;
    }

    this.running = true;
    try {
      this.emit({ type: "user_message", sessionId: this.id, text, clientMessageId });
      this.emit({ type: "session_busy", sessionId: this.id, busy: true });
      await this.sessionBackupInit;
      this.messages.push({ role: "user", content: text });

      const res = await runTurn({
        config: this.config,
        system: this.system,
        messages: this.messages,
        log: (line) => this.log(line),
        askUser: (q, opts) => this.askUser(q, opts),
        approveCommand: (cmd) => this.approveCommand(cmd),
        updateTodos: (todos) => this.updateTodos(todos),
        maxSteps: 100,
        enableMcp: this.config.enableMcp,
      });

      this.messages.push(...res.responseMessages);

      const reasoning = (res.reasoningText || "").trim();
      if (reasoning) {
        const kind = this.config.provider === "openai" || this.config.provider === "codex-cli" ? "summary" : "reasoning";
        this.emit({ type: "reasoning", sessionId: this.id, kind, text: reasoning });
      }

      const out = (res.text || "").trim();
      if (out) this.emit({ type: "assistant_message", sessionId: this.id, text: out });
    } catch (err) {
      this.emit({ type: "error", sessionId: this.id, message: String(err) });
    } finally {
      await this.takeAutomaticSessionCheckpoint();
      this.emit({ type: "session_busy", sessionId: this.id, busy: false });
      this.running = false;
    }
  }

  private emitSessionBackupState(
    reason: "requested" | "auto_checkpoint" | "manual_checkpoint" | "restore" | "delete"
  ) {
    this.emit({
      type: "session_backup_state",
      sessionId: this.id,
      reason,
      backup: this.sessionBackupState,
    });
  }

  private async initializeSessionBackup() {
    const userHome = this.config.userAgentDir ? path.dirname(this.config.userAgentDir) : undefined;

    try {
      this.sessionBackup = await this.sessionBackupFactory({
        sessionId: this.id,
        workingDirectory: this.config.workingDirectory,
        homedir: userHome,
      });
      this.sessionBackupState = this.sessionBackup.getPublicState();
    } catch (err) {
      const reason = `session backup initialization failed: ${String(err)}`;
      this.sessionBackup = null;
      this.sessionBackupState = {
        ...this.sessionBackupState,
        status: "failed",
        failureReason: reason,
        originalSnapshot: { kind: "pending" },
      };
    }
  }

  private async takeAutomaticSessionCheckpoint() {
    if (!this.sessionBackup) return;
    try {
      await this.sessionBackup.createCheckpoint("auto");
      this.sessionBackupState = this.sessionBackup.getPublicState();
      this.emitSessionBackupState("auto_checkpoint");
    } catch (err) {
      this.emit({ type: "error", sessionId: this.id, message: `automatic checkpoint failed: ${String(err)}` });
    }
  }

  private async closeSessionBackup() {
    await this.sessionBackupInit;
    if (!this.sessionBackup) return;
    try {
      await this.sessionBackup.close();
      this.sessionBackupState = this.sessionBackup.getPublicState();
    } catch {
      // best-effort close
    }
  }
}
