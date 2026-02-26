import path from "node:path";

import type { AgentConfig, ServerErrorCode, ServerErrorSource } from "../../types";
import { classifyCommandDetailed } from "../../utils/approval";
import { ASK_SKIP_TOKEN, type ServerEvent } from "../protocol";

function makeId(): string {
  return crypto.randomUUID();
}

type PromptBucket<T> = Map<string, PromiseWithResolvers<T>>;

export class InteractionManager {
  private readonly pendingAsk = new Map<string, PromiseWithResolvers<string>>();
  private readonly pendingApproval = new Map<string, PromiseWithResolvers<boolean>>();
  private readonly pendingAskEvents = new Map<string, Extract<ServerEvent, { type: "ask" }>>();
  private readonly pendingApprovalEvents = new Map<string, Extract<ServerEvent, { type: "approval" }>>();

  constructor(
    private readonly opts: {
      sessionId: string;
      emit: (evt: ServerEvent) => void;
      emitError: (code: ServerErrorCode, source: ServerErrorSource, message: string) => void;
      log: (line: string) => void;
      queuePersistSessionSnapshot: (reason: string) => void;
      getConfig: () => AgentConfig;
      isYolo: () => boolean;
      waitForPromptResponse?: <T>(requestId: string, bucket: PromptBucket<T>) => Promise<T>;
    }
  ) {}

  get hasPendingAsk(): boolean {
    return this.pendingAsk.size > 0;
  }

  get hasPendingApproval(): boolean {
    return this.pendingApproval.size > 0;
  }

  get pendingAskEventsForReplay(): ReadonlyMap<string, Extract<ServerEvent, { type: "ask" }>> {
    return this.pendingAskEvents;
  }

  get pendingApprovalEventsForReplay(): ReadonlyMap<string, Extract<ServerEvent, { type: "approval" }>> {
    return this.pendingApprovalEvents;
  }

  replayPendingPrompts() {
    for (const evt of this.pendingAskEvents.values()) {
      this.opts.emit(evt);
    }
    for (const evt of this.pendingApprovalEvents.values()) {
      this.opts.emit(evt);
    }
  }

  handleAskResponse(requestId: string, answer: string) {
    const pending = this.pendingAsk.get(requestId);
    if (!pending) {
      this.opts.log(`[warn] ask_response for unknown requestId: ${requestId}`);
      return;
    }

    if (answer.trim().length === 0) {
      this.opts.emitError(
        "validation_failed",
        "session",
        `Ask response cannot be empty. Reply with text or ${ASK_SKIP_TOKEN} to skip.`
      );
      const pendingEvt = this.pendingAskEvents.get(requestId);
      if (pendingEvt) {
        this.opts.emit(pendingEvt);
      }
      return;
    }

    this.pendingAsk.delete(requestId);
    this.pendingAskEvents.delete(requestId);
    this.opts.queuePersistSessionSnapshot("session.ask_resolved");
    pending.resolve(answer);
  }

  handleApprovalResponse(requestId: string, approved: boolean) {
    const pending = this.pendingApproval.get(requestId);
    if (!pending) {
      this.opts.log(`[warn] approval_response for unknown requestId: ${requestId}`);
      return;
    }

    this.pendingApproval.delete(requestId);
    this.pendingApprovalEvents.delete(requestId);
    this.opts.queuePersistSessionSnapshot("session.approval_resolved");
    pending.resolve(approved);
  }

  rejectAllPending(reason: string) {
    for (const [id, pending] of this.pendingAsk) {
      pending.reject(new Error(reason));
      this.pendingAsk.delete(id);
      this.pendingAskEvents.delete(id);
    }

    for (const [id, pending] of this.pendingApproval) {
      pending.reject(new Error(reason));
      this.pendingApproval.delete(id);
      this.pendingApprovalEvents.delete(id);
    }
  }

  async askUser(question: string, options?: string[]) {
    const requestId = makeId();
    const pending = Promise.withResolvers<string>();
    this.pendingAsk.set(requestId, pending);

    const evt: Extract<ServerEvent, { type: "ask" }> = {
      type: "ask",
      sessionId: this.opts.sessionId,
      requestId,
      question,
      options,
    };
    this.pendingAskEvents.set(requestId, evt);
    this.opts.emit(evt);
    this.opts.queuePersistSessionSnapshot("session.ask_pending");

    return await this.waitForPromptResponse(requestId, this.pendingAsk).finally(() => {
      this.pendingAskEvents.delete(requestId);
    });
  }

  async approveCommand(command: string) {
    if (this.opts.isYolo()) return true;

    const config = this.opts.getConfig();
    const classification = classifyCommandDetailed(command, {
      allowedRoots: [
        path.dirname(config.projectAgentDir),
        config.workingDirectory,
        ...(config.outputDirectory ? [config.outputDirectory] : []),
      ],
      workingDirectory: config.workingDirectory,
    });
    if (classification.kind === "auto") return true;

    const requestId = makeId();
    const pending = Promise.withResolvers<boolean>();
    this.pendingApproval.set(requestId, pending);

    const evt: Extract<ServerEvent, { type: "approval" }> = {
      type: "approval",
      sessionId: this.opts.sessionId,
      requestId,
      command,
      dangerous: classification.dangerous,
      reasonCode: classification.riskCode,
    };
    this.pendingApprovalEvents.set(requestId, evt);
    this.opts.emit(evt);
    this.opts.queuePersistSessionSnapshot("session.approval_pending");

    return await this.waitForPromptResponse(requestId, this.pendingApproval).finally(() => {
      this.pendingApprovalEvents.delete(requestId);
    });
  }

  private waitForPromptResponse<T>(requestId: string, bucket: PromptBucket<T>): Promise<T> {
    if (this.opts.waitForPromptResponse) {
      return this.opts.waitForPromptResponse(requestId, bucket);
    }
    const pending = bucket.get(requestId);
    if (!pending) return Promise.reject(new Error(`Unknown prompt request: ${requestId}`));
    return pending.promise;
  }
}
