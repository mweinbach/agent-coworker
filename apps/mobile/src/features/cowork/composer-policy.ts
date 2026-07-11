import type { CoworkTurnInputPart } from "./jsonRpcClient";

export type ComposerAttachment = Exclude<CoworkTurnInputPart, { type: "text" }>;

export type ComposerSubmission = {
  clientMessageId: string;
  text: string;
  attachments: ComposerAttachment[];
  status: "submitting" | "failed";
  error: string | null;
};

export type ComposerPolicy = {
  canEdit: boolean;
  canSubmit: boolean;
};

export function hasComposerContent(
  text: string,
  attachments: readonly ComposerAttachment[],
): boolean {
  return text.trim().length > 0 || attachments.length > 0;
}

export function getComposerPolicy(input: {
  connected: boolean;
  draftThread: boolean;
  hasContent: boolean;
  isBusy: boolean;
  isSubmitting: boolean;
  hasFailedSubmission?: boolean;
}): ComposerPolicy {
  const canEdit = input.draftThread || input.connected;
  return {
    canEdit,
    canSubmit:
      canEdit &&
      input.hasContent &&
      !input.isBusy &&
      !input.isSubmitting &&
      input.hasFailedSubmission !== true,
  };
}

export function createComposerSubmission(input: {
  clientMessageId: string;
  text: string;
  attachments: readonly ComposerAttachment[];
}): ComposerSubmission {
  return {
    clientMessageId: input.clientMessageId,
    text: input.text,
    attachments: input.attachments.map((attachment) => ({ ...attachment })),
    status: "submitting",
    error: null,
  };
}

export function toComposerTurnInput(submission: ComposerSubmission): CoworkTurnInputPart[] {
  return [
    ...(submission.text.length > 0 ? [{ type: "text" as const, text: submission.text }] : []),
    ...submission.attachments.map((attachment) => ({ ...attachment })),
  ];
}

export function sameComposerAttachments(
  left: readonly ComposerAttachment[],
  right: readonly ComposerAttachment[],
): boolean {
  if (left.length !== right.length) return false;
  return left.every((attachment, index) => {
    const candidate = right[index];
    if (!candidate || attachment.type !== candidate.type) return false;
    if (attachment.type === "file" && candidate.type === "file") {
      return (
        attachment.filename === candidate.filename &&
        attachment.contentBase64 === candidate.contentBase64 &&
        attachment.mimeType === candidate.mimeType
      );
    }
    if (attachment.type === "uploadedFile" && candidate.type === "uploadedFile") {
      return (
        attachment.filename === candidate.filename &&
        attachment.path === candidate.path &&
        attachment.mimeType === candidate.mimeType
      );
    }
    return false;
  });
}
