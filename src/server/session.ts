import type { ModelMessage } from "ai";

import type { AgentConfig, TodoItem } from "../types";
import { runTurn } from "../agent";
import { classifyCommand } from "../utils/approval";

import type { ServerEvent } from "./protocol";

function makeId(): string {
  return crypto.randomUUID();
}

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

  private readonly config: AgentConfig;
  private readonly system: string;
  private readonly emit: (evt: ServerEvent) => void;

  private messages: ModelMessage[] = [];
  private running = false;

  private readonly pendingAsk = new Map<string, Deferred<string>>();
  private readonly pendingApproval = new Map<string, Deferred<boolean>>();

  private todos: TodoItem[] = [];

  constructor(opts: { config: AgentConfig; system: string; emit: (evt: ServerEvent) => void }) {
    this.id = makeId();
    this.config = opts.config;
    this.system = opts.system;
    this.emit = opts.emit;
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
    this.messages = [];
    this.todos = [];
    this.emit({ type: "todos", sessionId: this.id, todos: [] });
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

  async sendUserMessage(text: string, clientMessageId?: string) {
    if (this.running) {
      this.emit({ type: "error", sessionId: this.id, message: "Agent is busy" });
      return;
    }

    this.running = true;
    try {
      this.emit({ type: "user_message", sessionId: this.id, text, clientMessageId });
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
        const kind = this.config.provider === "openai" ? "summary" : "reasoning";
        this.emit({ type: "reasoning", sessionId: this.id, kind, text: reasoning });
      }

      const out = (res.text || "").trim();
      if (out) this.emit({ type: "assistant_message", sessionId: this.id, text: out });
    } catch (err) {
      this.emit({ type: "error", sessionId: this.id, message: String(err) });
    } finally {
      this.running = false;
    }
  }
}
