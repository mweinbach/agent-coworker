import path from "node:path";

import {
  formatUserInputDisplayText,
  getAttachmentTotalBase64Size,
  MAX_TURN_ATTACHMENT_TOTAL_BASE64_SIZE,
} from "../../../shared/attachments";
import type { ModelMessage, ServerErrorCode, ServerErrorSource } from "../../../types";
import type { FileAttachment, OrderedInputPart } from "../../jsonrpc/routes/shared";
import type { HistoryManager } from "../HistoryManager";
import type { SessionContext } from "../SessionContext";

export const MAX_PENDING_STEER_COUNT = 32;

const MAX_PENDING_STEER_ATTACHMENT_TOTAL_BASE64_SIZE = MAX_TURN_ATTACHMENT_TOTAL_BASE64_SIZE;

type ClassifiedTurnError = { code: ServerErrorCode; source: ServerErrorSource };

function isInlineFileAttachment(
  attachment: FileAttachment,
): attachment is Extract<FileAttachment, { contentBase64: string }> {
  return "contentBase64" in attachment;
}

function getInlineAttachments(
  attachments?: readonly FileAttachment[],
): Array<Extract<FileAttachment, { contentBase64: string }>> {
  return (attachments ?? []).filter(isInlineFileAttachment);
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

export type SteerCoordinatorDeps = {
  context: SessionContext;
  historyManager: HistoryManager;
  getTurnAttachmentValidationMessage: (attachments?: readonly FileAttachment[]) => string | null;
  validateUploadedFileAttachments: (attachments?: readonly FileAttachment[]) => Promise<void>;
  buildUserMessageContent: (
    text: string,
    attachments?: FileAttachment[],
    inputParts?: OrderedInputPart[],
  ) => Promise<string | Array<Record<string, unknown>>>;
  classifyTurnError: (err: unknown) => ClassifiedTurnError;
};

export type SteerCoordinator = {
  sendSteerMessage: (
    text: string,
    expectedTurnId: string,
    clientMessageId?: string,
    attachments?: FileAttachment[],
    inputParts?: OrderedInputPart[],
  ) => Promise<void>;
  commitPendingSteers: () => Promise<ModelMessage[]>;
  drainPendingSteers: (
    stepMessages: ModelMessage[],
  ) => Promise<{ messages: ModelMessage[] } | undefined>;
  rejectPendingSteers: (message: string) => void;
};

export function createSteerCoordinator(deps: SteerCoordinatorDeps): SteerCoordinator {
  const { context, historyManager } = deps;

  const sendSteerMessage = async (
    text: string,
    expectedTurnId: string,
    clientMessageId?: string,
    attachments?: FileAttachment[],
    inputParts?: OrderedInputPart[],
  ) => {
    if (!context.state.running) {
      context.emitError("validation_failed", "session", "No active turn to steer.");
      return;
    }

    const currentTurnId = context.state.currentTurnId;
    if (!currentTurnId) {
      context.emitError("validation_failed", "session", "Active turn is missing an id.");
      return;
    }

    if (expectedTurnId !== currentTurnId) {
      context.emitError("validation_failed", "session", "Active turn mismatch.");
      return;
    }

    if (!context.state.acceptingSteers) {
      context.emitError("validation_failed", "session", "Active turn no longer accepts steering.");
      return;
    }

    if (text.trim().length === 0 && (!attachments || attachments.length === 0)) {
      context.emitError("validation_failed", "session", "Steer input must be non-empty.");
      return;
    }
    const displayText = resolveUserInputDisplayText(text, attachments);
    const attachmentValidationMessage = deps.getTurnAttachmentValidationMessage(attachments);
    if (attachmentValidationMessage) {
      context.emitError("validation_failed", "session", attachmentValidationMessage);
      return;
    }
    try {
      await deps.validateUploadedFileAttachments(attachments);
    } catch (error) {
      const classified = deps.classifyTurnError(error);
      context.emitError(classified.code, classified.source, context.formatError(error));
      return;
    }
    const activeSteerHandler = context.state.activeSteerHandler;
    if (activeSteerHandler) {
      try {
        const content = await deps.buildUserMessageContent(text, attachments, inputParts);
        await activeSteerHandler({ text, expectedTurnId: currentTurnId, content });
        historyManager.appendMessagesToHistory([{ role: "user", content }]);
        context.emit({
          type: "user_message",
          sessionId: context.id,
          text: displayText,
          ...(clientMessageId ? { clientMessageId } : {}),
        });
        context.queuePersistSessionSnapshot("session.steer_committed");
        context.emit({
          type: "steer_accepted",
          sessionId: context.id,
          turnId: currentTurnId,
          text,
          ...(clientMessageId ? { clientMessageId } : {}),
        });
      } catch (error) {
        const classified = deps.classifyTurnError(error);
        context.emitError(classified.code, classified.source, context.formatError(error));
      }
      return;
    }
    const nextPendingSteerAttachmentBase64Size =
      context.state.pendingSteers.reduce(
        (total, steer) =>
          total + getAttachmentTotalBase64Size(getInlineAttachments(steer.attachments)),
        0,
      ) + getAttachmentTotalBase64Size(getInlineAttachments(attachments));
    if (nextPendingSteerAttachmentBase64Size > MAX_PENDING_STEER_ATTACHMENT_TOTAL_BASE64_SIZE) {
      context.emitError(
        "validation_failed",
        "session",
        "Pending steer attachments are too large. Wait for the current turn to consume queued steers.",
      );
      return;
    }
    if (context.state.pendingSteers.length >= MAX_PENDING_STEER_COUNT) {
      context.emitError(
        "validation_failed",
        "session",
        "Too many pending steers. Wait for the current turn to consume queued steers.",
      );
      return;
    }
    context.state.pendingSteers.push({
      text,
      ...(displayText ? { displayText } : {}),
      ...(clientMessageId ? { clientMessageId } : {}),
      ...(attachments && attachments.length > 0 ? { attachments } : {}),
      ...(inputParts && inputParts.length > 0 ? { inputParts } : {}),
      acceptedAt: new Date().toISOString(),
    });
    context.emit({
      type: "steer_accepted",
      sessionId: context.id,
      turnId: currentTurnId,
      text,
      ...(clientMessageId ? { clientMessageId } : {}),
    });
  };

  const commitPendingSteers = async (): Promise<ModelMessage[]> => {
    const drained = context.state.pendingSteers.splice(0);
    if (drained.length === 0) return [];

    const steerMessages: ModelMessage[] = [];
    for (const steer of drained) {
      const content = await deps.buildUserMessageContent(
        steer.text,
        steer.attachments,
        steer.inputParts,
      );
      steerMessages.push({ role: "user", content });
    }
    historyManager.appendMessagesToHistory(steerMessages);
    for (const steer of drained) {
      context.emit({
        type: "user_message",
        sessionId: context.id,
        text: steer.displayText ?? resolveUserInputDisplayText(steer.text, steer.attachments),
        ...(steer.clientMessageId ? { clientMessageId: steer.clientMessageId } : {}),
      });
    }
    context.queuePersistSessionSnapshot("session.steer_committed");
    return steerMessages;
  };

  const drainPendingSteers = async (
    stepMessages: ModelMessage[],
  ): Promise<{ messages: ModelMessage[] } | undefined> => {
    const steerMessages = await commitPendingSteers();
    if (steerMessages.length === 0) return undefined;
    return {
      messages: [...stepMessages, ...steerMessages],
    };
  };

  const rejectPendingSteers = (message: string) => {
    if (context.state.pendingSteers.length === 0) return;
    context.state.pendingSteers.splice(0);
    context.emitError("validation_failed", "session", message);
  };

  return {
    sendSteerMessage,
    commitPendingSteers,
    drainPendingSteers,
    rejectPendingSteers,
  };
}
