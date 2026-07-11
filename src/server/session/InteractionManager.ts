import { captureProductEvent } from "../../telemetry/productAnalytics";
import type {
  AgentConfig,
  ApprovalRiskCode,
  ApproveCommandOptions,
  ServerErrorCode,
  ServerErrorSource,
} from "../../types";
import { classifyCommandDetailed } from "../../utils/approval";
import { ASK_SKIP_TOKEN, type SessionEvent } from "../protocol";

function makeId(): string {
  return crypto.randomUUID();
}

// Fail-safe backstop for an abandoned prompt. Transient disconnects are already
// covered: pending prompts are replayed to a reconnecting client, so this only
// fires when nobody ever answers (e.g. a headless client died, or a turn was
// orphaned). On expiry an approval denies (returns false) and an ask rejects, so
// the turn unblocks instead of hanging forever and holding the session busy.
// Generous by default so a human who steps away is not auto-denied mid-thought.
const DEFAULT_PROMPT_TIMEOUT_MS = 30 * 60 * 1000;

type PromptBucket<T> = Map<string, PromiseWithResolvers<T>>;
export type PendingPromptReplayEvent =
  | Extract<SessionEvent, { type: "ask" }>
  | Extract<SessionEvent, { type: "approval" }>;

export class InteractionManager {
  private readonly pendingAsk = new Map<string, PromiseWithResolvers<string>>();
  private readonly pendingApproval = new Map<string, PromiseWithResolvers<boolean>>();
  private readonly pendingPromptEvents = new Map<string, PendingPromptReplayEvent>();

  constructor(
    private readonly opts: {
      sessionId: string;
      emit: (evt: SessionEvent) => void;
      emitError: (code: ServerErrorCode, source: ServerErrorSource, message: string) => void;
      log: (line: string) => void;
      queuePersistSessionSnapshot: (reason: string) => void;
      getConfig: () => AgentConfig;
      isYolo: () => boolean;
      waitForPromptResponse?: <T>(requestId: string, bucket: PromptBucket<T>) => Promise<T>;
      /** Override the abandoned-prompt timeout (ms). <= 0 disables it. */
      promptTimeoutMs?: number;
      /** Defaults true so abandoned UI prompts do not keep headless processes alive. */
      unrefPromptTimeouts?: boolean;
    },
  ) {}

  /**
   * Arm a fail-safe timer that fires when a prompt is never answered. Returns a
   * clear() to cancel it on resolution. The timer is unref'd so a still-armed
   * backstop never keeps the process alive.
   */
  private armPromptTimeout(onTimeout: () => void): { clear: () => void } | null {
    const ms = this.opts.promptTimeoutMs ?? DEFAULT_PROMPT_TIMEOUT_MS;
    if (!Number.isFinite(ms) || ms <= 0) return null;
    const handle = setTimeout(onTimeout, ms);
    if (this.opts.unrefPromptTimeouts !== false) {
      (handle as { unref?: () => void }).unref?.();
    }
    return { clear: () => clearTimeout(handle) };
  }

  get hasPendingAsk(): boolean {
    return this.pendingAsk.size > 0;
  }

  get hasPendingApproval(): boolean {
    return this.pendingApproval.size > 0;
  }

  get pendingAskEventsForReplay(): ReadonlyMap<string, Extract<SessionEvent, { type: "ask" }>> {
    return new Map(
      [...this.pendingPromptEvents].filter(
        (entry): entry is [string, Extract<SessionEvent, { type: "ask" }>] =>
          entry[1].type === "ask",
      ),
    );
  }

  get pendingApprovalEventsForReplay(): ReadonlyMap<
    string,
    Extract<SessionEvent, { type: "approval" }>
  > {
    return new Map(
      [...this.pendingPromptEvents].filter(
        (entry): entry is [string, Extract<SessionEvent, { type: "approval" }>] =>
          entry[1].type === "approval",
      ),
    );
  }

  getPendingPromptEventsForReplay(): ReadonlyArray<PendingPromptReplayEvent> {
    return [...this.pendingPromptEvents.values()];
  }

  replayPendingPrompts() {
    for (const evt of this.getPendingPromptEventsForReplay()) {
      this.opts.emit(evt);
    }
  }

  handleAskResponse(requestId: string, answer: string): boolean {
    const pending = this.pendingAsk.get(requestId);
    if (!pending) {
      this.opts.log(`[warn] ask_response for unknown requestId: ${requestId}`);
      return false;
    }

    if (answer.trim().length === 0) {
      this.opts.emitError(
        "validation_failed",
        "session",
        `Ask response cannot be empty. Reply with text or ${ASK_SKIP_TOKEN} to skip.`,
      );
      const pendingEvt = this.pendingPromptEvents.get(requestId);
      if (pendingEvt?.type === "ask") {
        this.opts.emit(pendingEvt);
      }
      return false;
    }

    this.pendingAsk.delete(requestId);
    this.pendingPromptEvents.delete(requestId);
    this.opts.queuePersistSessionSnapshot("session.ask_resolved");
    pending.resolve(answer);
    return true;
  }

  handleApprovalResponse(requestId: string, approved: boolean): boolean {
    const pending = this.pendingApproval.get(requestId);
    if (!pending) {
      this.opts.log(`[warn] approval_response for unknown requestId: ${requestId}`);
      return false;
    }

    this.pendingApproval.delete(requestId);
    this.pendingPromptEvents.delete(requestId);
    this.opts.queuePersistSessionSnapshot("session.approval_resolved");
    pending.resolve(approved);
    return true;
  }

  rejectAllPending(reason: string) {
    for (const [id, pending] of this.pendingAsk) {
      pending.reject(new Error(reason));
      this.pendingAsk.delete(id);
      this.pendingPromptEvents.delete(id);
    }

    for (const [id, pending] of this.pendingApproval) {
      pending.reject(new Error(reason));
      this.pendingApproval.delete(id);
      this.pendingPromptEvents.delete(id);
    }
  }

  async askUser(question: string, options?: string[]) {
    const requestId = makeId();
    const pending = Promise.withResolvers<string>();
    this.pendingAsk.set(requestId, pending);

    const evt: Extract<SessionEvent, { type: "ask" }> = {
      type: "ask",
      sessionId: this.opts.sessionId,
      requestId,
      question,
      options,
    };
    this.pendingPromptEvents.set(requestId, evt);
    this.opts.emit(evt);
    this.opts.queuePersistSessionSnapshot("session.ask_pending");

    const timeout = this.armPromptTimeout(() => {
      // Only act if still pending (delete() returns false if already answered).
      if (!this.pendingAsk.delete(requestId)) return;
      this.pendingPromptEvents.delete(requestId);
      this.opts.log(`[warn] ask ${requestId} timed out without a response`);
      this.opts.queuePersistSessionSnapshot("session.ask_timeout");
      pending.reject(new Error("Ask prompt timed out without a response."));
    });

    return await this.waitForPromptResponse(requestId, this.pendingAsk).finally(() => {
      timeout?.clear();
      this.pendingPromptEvents.delete(requestId);
    });
  }

  /**
   * Request user approval for an action. The primary case is a sandbox-denial
   * retry (`reason: "sandbox_denied"`): lifting the OS sandbox to run a command
   * unsandboxed. Provider runtimes (e.g. the Codex app-server) also route their
   * own command/file approvals here without a reason — those are ordinary
   * approvals, not sandbox escapes.
   *
   * YOLO auto-approves everything, sandbox-denial retries included: the mode
   * means zero approval prompts, and the session's own commands already run
   * unsandboxed (danger-full-access). Hard floors are unaffected — the bash
   * tool never offers an escalation for read-only roles or scoped children, so
   * this auto-approval cannot widen them.
   */
  async approveCommand(command: string, opts?: ApproveCommandOptions) {
    const isSandboxEscalation = opts?.reason === "sandbox_denied";
    if (this.opts.isYolo()) return true;

    const classification = isSandboxEscalation ? null : classifyCommandDetailed(command);
    if (classification?.autoApprove) return true;

    const requestId = makeId();
    const pending = Promise.withResolvers<boolean>();
    this.pendingApproval.set(requestId, pending);

    // Only a sandbox-denial retry is the "escape the OS sandbox" action; other
    // callers (e.g. Codex app-server command/file approvals) are ordinary
    // approvals and must not be mislabeled as a sandbox escalation.
    const reasonCode: ApprovalRiskCode = isSandboxEscalation
      ? "sandbox_denied_escalation"
      : (classification?.reasonCode ?? "requires_manual_review");
    const evt: Extract<SessionEvent, { type: "approval" }> = {
      type: "approval",
      sessionId: this.opts.sessionId,
      requestId,
      command,
      dangerous: isSandboxEscalation || classification?.dangerous === true,
      reasonCode,
      // Sandbox context lets clients render a clear, inline approval ("re-run
      // with full access?") instead of a generic command-approval modal.
      ...(isSandboxEscalation && opts?.detail ? { detail: opts.detail } : {}),
      ...(isSandboxEscalation && opts?.category ? { category: opts.category } : {}),
    };
    this.pendingPromptEvents.set(requestId, evt);
    this.opts.emit(evt);
    captureProductEvent("tool_approval_requested", {
      eventSource: "server",
      status: "dangerous",
      errorCategory: reasonCode,
    });
    this.opts.queuePersistSessionSnapshot("session.approval_pending");

    const timeout = this.armPromptTimeout(() => {
      // Fail safe: an abandoned approval denies (false), never silently runs.
      if (!this.pendingApproval.delete(requestId)) return;
      this.pendingPromptEvents.delete(requestId);
      this.opts.log(`[warn] approval ${requestId} timed out without a response; denying`);
      this.opts.queuePersistSessionSnapshot("session.approval_timeout");
      pending.resolve(false);
    });

    return await this.waitForPromptResponse(requestId, this.pendingApproval).finally(() => {
      timeout?.clear();
      this.pendingPromptEvents.delete(requestId);
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
