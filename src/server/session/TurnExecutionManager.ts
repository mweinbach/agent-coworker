import type { FileAttachment, OrderedInputPart } from "../jsonrpc/routes/shared";
import type { HistoryManager } from "./HistoryManager";
import type { InteractionManager } from "./InteractionManager";
import type { SessionBackupController } from "./SessionBackupController";
import type { SessionContext } from "./SessionContext";
import type { SessionMetadataManager } from "./SessionMetadataManager";
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

  constructor(
    private readonly context: SessionContext,
    private readonly deps: {
      interactionManager: InteractionManager;
      historyManager: HistoryManager;
      metadataManager: SessionMetadataManager;
      backupController: SessionBackupController;
      flushPendingExternalSkillRefresh: () => Promise<void>;
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
    });
  }

  async sendSteerMessage(
    text: string,
    expectedTurnId: string,
    clientMessageId?: string,
    attachments?: FileAttachment[],
    inputParts?: OrderedInputPart[],
  ) {
    return await this.steerCoordinator.sendSteerMessage(
      text,
      expectedTurnId,
      clientMessageId,
      attachments,
      inputParts,
    );
  }

  async sendUserMessage(
    text: string,
    clientMessageId?: string,
    displayText?: string,
    attachments?: FileAttachment[],
    inputParts?: OrderedInputPart[],
  ) {
    return await this.userMessageTurnRunner.sendUserMessage(
      text,
      clientMessageId,
      displayText,
      attachments,
      inputParts,
    );
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
}
