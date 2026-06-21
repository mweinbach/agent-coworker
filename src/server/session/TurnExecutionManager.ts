import type { TurnReference } from "../../types";
import type { FileAttachment, OrderedInputPart } from "../jsonrpc/routes/shared";
import type { HistoryManager } from "./HistoryManager";
import type { InteractionManager } from "./InteractionManager";
import type { SessionBackupController } from "./SessionBackupController";
import type { SessionContext } from "./SessionContext";
import type { SessionMetadataManager } from "./SessionMetadataManager";
import { getSessionTaskLock } from "./taskLocks";
import {
  createUserMessageTurnRunner,
  type UserMessageTurnRunner,
} from "./turnExecution/runUserMessageTurn";
import { createSteerCoordinator, type SteerCoordinator } from "./turnExecution/steerCoordinator";
import {
  createTurnErrorClassifier,
  createUserMessageAttachmentHelpers,
  getTurnAttachmentValidationMessage,
} from "./turnExecution/userMessageAttachments";

export class TurnExecutionManager {
  private readonly steerCoordinator: SteerCoordinator;
  private readonly userMessageTurnRunner: UserMessageTurnRunner;
  private activeTurnSettlement: Promise<void> | null = null;

  constructor(
    private readonly context: SessionContext,
    private readonly deps: {
      interactionManager: InteractionManager;
      historyManager: HistoryManager;
      metadataManager: SessionMetadataManager;
      backupController: SessionBackupController;
      flushPendingExternalSkillRefresh: () => Promise<void>;
      triggerMemoryGeneration?: () => void;
      /**
       * Lazily yields the per-session A2UI surface manager. Returns a
       * structured result per envelope. Present even when the A2UI feature
       * flag is off; the tool layer gates access via `applyA2uiEnvelope`
       * on `ToolContext`.
       */
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
      onAdvancedMemoryChanged?: (folder: string) => Promise<void>;
    },
  ) {
    const classifyTurnError = createTurnErrorClassifier(this.context);
    const attachmentHelpers = createUserMessageAttachmentHelpers(this.context);

    this.steerCoordinator = createSteerCoordinator({
      context: this.context,
      historyManager: this.deps.historyManager,
      getTurnAttachmentValidationMessage,
      validateUploadedFileAttachments: attachmentHelpers.validateUploadedFileAttachments,
      buildUserMessageContent: attachmentHelpers.buildUserMessageContent,
      classifyTurnError,
      getTaskLock: () => getSessionTaskLock(this.context.deps.sessionDb, this.context.id),
    });

    this.userMessageTurnRunner = createUserMessageTurnRunner({
      context: this.context,
      historyManager: this.deps.historyManager,
      metadataManager: this.deps.metadataManager,
      backupController: this.deps.backupController,
      interactionManager: this.deps.interactionManager,
      flushPendingExternalSkillRefresh: this.deps.flushPendingExternalSkillRefresh,
      steerCoordinator: this.steerCoordinator,
      classifyTurnError,
      buildUserMessageContent: attachmentHelpers.buildUserMessageContent,
      validateUploadedFileAttachments: attachmentHelpers.validateUploadedFileAttachments,
      getA2uiSurfaceManager: this.deps.getA2uiSurfaceManager,
      triggerMemoryGeneration: this.deps.triggerMemoryGeneration,
      onAdvancedMemoryChanged: this.deps.onAdvancedMemoryChanged,
    });
  }

  async sendSteerMessage(
    text: string,
    expectedTurnId: string,
    clientMessageId?: string,
    attachments?: FileAttachment[],
    inputParts?: OrderedInputPart[],
    references?: TurnReference[],
  ) {
    const taskLock = getSessionTaskLock(this.context.deps.sessionDb, this.context.id);
    if (taskLock) {
      this.context.emitError("task_locked", "session", taskLock.message, taskLock.data);
      return;
    }
    return await this.steerCoordinator.sendSteerMessage(
      text,
      expectedTurnId,
      clientMessageId,
      attachments,
      inputParts,
      references,
    );
  }

  async sendUserMessage(
    text: string,
    clientMessageId?: string,
    displayText?: string,
    attachments?: FileAttachment[],
    inputParts?: OrderedInputPart[],
    references?: TurnReference[],
  ) {
    const taskLock = getSessionTaskLock(this.context.deps.sessionDb, this.context.id);
    if (taskLock) {
      this.context.emitError("task_locked", "session", taskLock.message, taskLock.data);
      return;
    }
    const turnPromise = this.userMessageTurnRunner.sendUserMessage(
      text,
      clientMessageId,
      displayText,
      attachments,
      inputParts,
      references,
    );
    let trackedSettlement!: Promise<void>;
    trackedSettlement = turnPromise
      .then(
        () => {},
        () => {},
      )
      .finally(() => {
        if (this.activeTurnSettlement === trackedSettlement) {
          this.activeTurnSettlement = null;
        }
      });
    this.activeTurnSettlement = trackedSettlement;
    return await turnPromise;
  }

  handleAskResponse(requestId: string, answer: string): boolean {
    return this.deps.interactionManager.handleAskResponse(requestId, answer);
  }

  handleApprovalResponse(requestId: string, approved: boolean): boolean {
    return this.deps.interactionManager.handleApprovalResponse(requestId, approved);
  }

  cancel(opts?: { includeSubagents?: boolean }) {
    if (
      opts?.includeSubagents === true &&
      (this.context.state.sessionInfo.sessionKind ?? "root") === "root"
    ) {
      this.context.deps.cancelAgentSessionsImpl?.(this.context.id);
    }
    if (!this.context.state.running) return;
    if (this.context.state.abortController) {
      this.context.state.abortController.abort();
    }
    this.deps.interactionManager.rejectAllPending("Cancelled by user");
  }

  async cancelAndWaitForSettlement(opts?: {
    includeSubagents?: boolean;
    timeoutMs?: number;
  }): Promise<void> {
    this.cancel({ includeSubagents: opts?.includeSubagents });
    const settlement = this.activeTurnSettlement;
    const timeoutMs = opts?.timeoutMs ?? 30_000;
    if (!settlement) {
      if (!this.context.state.running) return;
      await new Promise<void>((resolve, reject) => {
        const startedAt = Date.now();
        const interval = setInterval(() => {
          if (!this.context.state.running) {
            clearInterval(interval);
            resolve();
            return;
          }
          if (Date.now() - startedAt >= timeoutMs) {
            clearInterval(interval);
            reject(new Error("Timed out waiting for running turn to settle after cancellation."));
          }
        }, 25);
      });
      return;
    }
    let timeout: ReturnType<typeof setTimeout> | null = null;
    try {
      await Promise.race([
        settlement,
        new Promise<never>((_, reject) => {
          timeout = setTimeout(
            () => reject(new Error("Timed out waiting for turn settlement after cancellation.")),
            timeoutMs,
          );
        }),
      ]);
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }
}
