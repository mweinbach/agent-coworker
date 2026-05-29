import path from "node:path";
import { renderReferencedPluginsSection } from "../../../sessionContext/renderReferencedPluginsSection";
import {
  formatUserInputDisplayText,
  getAttachmentTotalBase64Size,
  MAX_TURN_ATTACHMENT_TOTAL_BASE64_SIZE,
} from "../../../shared/attachments";
import type {
  ModelMessage,
  ReferencedPluginContext,
  ServerErrorCode,
  ServerErrorSource,
  TurnReference,
} from "../../../types";
import type { FileAttachment, OrderedInputPart } from "../../jsonrpc/routes/shared";
import type { HistoryManager } from "../HistoryManager";
import type { SessionContext } from "../SessionContext";
import {
  injectResolvedReferencedSkills,
  type ReferencedSkillContext,
  resolveReferencedPlugins,
  resolveReferencedSkills,
} from "./referenceInjection";

const MAX_PENDING_STEER_COUNT = 32;

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
    references?: TurnReference[],
  ) => Promise<void>;
  commitPendingSteers: () => Promise<{ messages: ModelMessage[]; committedCount: number }>;
  drainPendingSteers: (
    stepMessages: ModelMessage[],
  ) => Promise<{ messages: ModelMessage[] } | undefined>;
  rejectPendingSteers: (message: string) => void;
};

type ResolvedSteerReferences = {
  skills: ReferencedSkillContext[];
  plugins: ReferencedPluginContext[];
};

function renderReferencedSkillsForSteer(skills: ReferencedSkillContext[]): string {
  if (skills.length === 0) return "";
  const lines: string[] = [
    "## Referenced Skills",
    "",
    "The user explicitly referenced the following skill(s) for this steer. Apply these instructions to the steer immediately.",
    "",
  ];
  for (const skill of skills) {
    lines.push(`### ${skill.name}`, "", skill.body, "");
  }
  return lines.join("\n").trim();
}

function renderSteerReferenceContext(resolved: ResolvedSteerReferences): string {
  const sections = [
    renderReferencedSkillsForSteer(resolved.skills),
    renderReferencedPluginsSection(resolved.plugins),
  ].filter(Boolean);
  return sections.join("\n\n");
}

function prependReferenceContextToContent(
  content: ModelMessage["content"],
  referenceContext: string,
): ModelMessage["content"] {
  if (!referenceContext.trim()) return content;
  const prefix = `Reference context for this steer:\n\n${referenceContext}`;
  if (Array.isArray(content)) {
    return [{ type: "text", text: prefix }, ...content];
  }
  return `${prefix}\n\n${typeof content === "string" ? content : ""}`.trim();
}

export function createSteerCoordinator(deps: SteerCoordinatorDeps): SteerCoordinator {
  const { context, historyManager } = deps;

  const log = (line: string) => context.emit({ type: "log", sessionId: context.id, line });

  // Stream index for synthetic skill-load chunks injected while steering. The
  // index is informational in the projector (items key off toolCallId), so a
  // coordinator-local counter is sufficient.
  let steerStreamIndex = 0;

  const mergeReferencedPlugins = (incoming: ReferencedPluginContext[]) => {
    if (incoming.length === 0) return;
    const byName = new Map(
      (context.state.turnReferencedPlugins ?? []).map((plugin) => [plugin.name, plugin] as const),
    );
    for (const plugin of incoming) byName.set(plugin.name, plugin);
    context.state.turnReferencedPlugins = [...byName.values()];
  };

  const resolveSteerReferences = async (
    references: TurnReference[] | undefined,
  ): Promise<ResolvedSteerReferences> => {
    if (!references || references.length === 0) {
      return { skills: [], plugins: [] };
    }
    const [skills, plugins] = await Promise.all([
      resolveReferencedSkills({ context, references, log }),
      resolveReferencedPlugins(context, references),
    ]);
    return { skills, plugins };
  };

  // Hard-force skill references and merge plugin awareness when a steer commits.
  const commitResolvedSteerReferences = (
    resolved: ResolvedSteerReferences,
    turnId: string | null,
  ): ModelMessage[] => {
    if (!turnId) return [];
    const skillMessages = injectResolvedReferencedSkills({
      context,
      appendToHistory: (messages) => historyManager.appendMessagesToHistory(messages),
      turnId,
      skills: resolved.skills,
      allocateStreamIndex: () => steerStreamIndex++,
      includeRawChunks: context.state.config.includeRawChunks ?? true,
      log,
    });
    mergeReferencedPlugins(resolved.plugins);
    return skillMessages;
  };

  const sendSteerMessage = async (
    text: string,
    expectedTurnId: string,
    clientMessageId?: string,
    attachments?: FileAttachment[],
    inputParts?: OrderedInputPart[],
    references?: TurnReference[],
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
        const resolvedReferences = await resolveSteerReferences(references);
        const deliveryContent = prependReferenceContextToContent(
          content,
          renderSteerReferenceContext(resolvedReferences),
        );
        await activeSteerHandler({ text, expectedTurnId: currentTurnId, content: deliveryContent });
        historyManager.appendMessagesToHistory([{ role: "user", content }]);
        context.emit({
          type: "user_message",
          sessionId: context.id,
          text: displayText,
          ...(clientMessageId ? { clientMessageId } : {}),
        });
        commitResolvedSteerReferences(resolvedReferences, currentTurnId);
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
      ...(references && references.length > 0 ? { references } : {}),
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

  const commitPendingSteers = async (): Promise<{
    messages: ModelMessage[];
    committedCount: number;
  }> => {
    const drained = context.state.pendingSteers.splice(0);
    if (drained.length === 0) return { messages: [], committedCount: 0 };

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
    const committedReferences = drained.flatMap((steer) => steer.references ?? []);
    const resolvedReferences = await resolveSteerReferences(committedReferences);
    const referenceSystem = renderReferencedPluginsSection(resolvedReferences.plugins);
    const skillMessages = commitResolvedSteerReferences(
      resolvedReferences,
      context.state.currentTurnId,
    );
    const referenceMessages: ModelMessage[] = referenceSystem
      ? [{ role: "system", content: referenceSystem }]
      : [];
    return {
      messages: [...referenceMessages, ...steerMessages, ...skillMessages],
      committedCount: drained.length,
    };
  };

  const drainPendingSteers = async (
    stepMessages: ModelMessage[],
  ): Promise<{ messages: ModelMessage[] } | undefined> => {
    const committed = await commitPendingSteers();
    if (committed.committedCount === 0) return undefined;
    return {
      messages: [...stepMessages, ...committed.messages],
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
