import fs from "node:fs/promises";
import path from "node:path";

import {
  USER_MESSAGE_ATTACHMENT_MAX_BASE64_SIZE,
  classifyUserMessageAttachmentKind,
  describeSupportedUserMessageAttachments,
  supportsUserMessageAttachmentMimeType,
  type UserMessageAttachment,
  type UserMessageAttachmentDraft,
} from "../../shared/messageAttachments";
import type { AgentConfig, ModelMessage } from "../../types";

type ImportedUserMessage = {
  content: ModelMessage["content"];
  attachments: UserMessageAttachment[];
  titleText: string;
};

type ValidationError = Error & {
  code: "validation_failed";
  source: "session";
};

function makeValidationError(message: string): ValidationError {
  return Object.assign(new Error(message), {
    code: "validation_failed" as const,
    source: "session" as const,
  });
}

function attachmentTitleSummary(attachments: UserMessageAttachment[]): string {
  if (attachments.length === 0) return "";
  if (attachments.length === 1) {
    return `Attachment: ${attachments[0]!.filename}`;
  }
  return `Attachments: ${attachments.map((attachment) => attachment.filename).join(", ")}`;
}

function attachmentWorkspaceNote(attachments: UserMessageAttachment[]): string {
  const lines = [
    "Imported attachment files are now available in the workspace at these paths:",
    ...attachments.map((attachment) => `- ${attachment.path} (${attachment.mimeType})`),
  ];
  return lines.join("\n");
}

async function resolveUniqueImportPath(targetDirectory: string, filename: string): Promise<{
  filename: string;
  filePath: string;
}> {
  const parsed = path.parse(filename);
  const baseName = (parsed.name || "attachment").trim() || "attachment";
  const ext = parsed.ext || "";
  const normalizedTargetDirectory = path.resolve(targetDirectory);

  for (let index = 0; index < 1000; index += 1) {
    const candidateName = index === 0 ? `${baseName}${ext}` : `${baseName}-${index + 1}${ext}`;
    const candidatePath = path.resolve(normalizedTargetDirectory, candidateName);
    if (!candidatePath.startsWith(normalizedTargetDirectory)) {
      throw makeValidationError("Invalid filename (path traversal)");
    }
    try {
      await fs.access(candidatePath);
    } catch {
      return {
        filename: candidateName,
        filePath: candidatePath,
      };
    }
  }

  throw makeValidationError(`Unable to import attachment ${filename}: too many files with the same name already exist.`);
}

async function importAttachmentFile(
  workingDirectory: string,
  attachment: UserMessageAttachmentDraft,
): Promise<UserMessageAttachment> {
  const rawFilename = path.basename(attachment.filename);
  if (!rawFilename || rawFilename === "." || rawFilename === "..") {
    throw makeValidationError("Invalid attachment filename.");
  }

  if (attachment.contentBase64.length > USER_MESSAGE_ATTACHMENT_MAX_BASE64_SIZE) {
    throw makeValidationError(`Attachment ${rawFilename} is too large (max ~7.5MB).`);
  }

  const kind = classifyUserMessageAttachmentKind(attachment.mimeType);
  if (!kind) {
    throw makeValidationError(`Unsupported attachment type for ${rawFilename}: ${attachment.mimeType}.`);
  }

  const { filename, filePath } = await resolveUniqueImportPath(workingDirectory, rawFilename);
  const decoded = Buffer.from(attachment.contentBase64, "base64");
  await fs.writeFile(filePath, decoded);
  return {
    filename,
    mimeType: attachment.mimeType,
    kind,
    path: filePath,
  };
}

function buildImportedMessageContent(
  text: string,
  importedAttachments: UserMessageAttachment[],
  attachmentDrafts: UserMessageAttachmentDraft[],
): ModelMessage["content"] {
  if (importedAttachments.length === 0) {
    return text;
  }

  const parts: Array<Record<string, unknown>> = [];
  if (text.trim().length > 0) {
    parts.push({ type: "text", text });
  }

  parts.push({
    type: "text",
    text: attachmentWorkspaceNote(importedAttachments),
  });

  for (let index = 0; index < importedAttachments.length; index += 1) {
    const imported = importedAttachments[index]!;
    const draft = attachmentDrafts[index]!;
    parts.push({
      type: imported.kind,
      data: draft.contentBase64,
      mimeType: imported.mimeType,
    });
  }

  return parts;
}

export async function importUserMessageAttachments(opts: {
  config: AgentConfig;
  text: string;
  attachments?: UserMessageAttachmentDraft[];
}): Promise<ImportedUserMessage> {
  const attachments = opts.attachments ?? [];
  if (attachments.length === 0) {
    return {
      content: opts.text,
      attachments: [],
      titleText: opts.text.trim(),
    };
  }

  const unsupported = attachments.find((attachment) =>
    !supportsUserMessageAttachmentMimeType(opts.config.provider, opts.config.model, attachment.mimeType)
  );
  if (unsupported) {
    throw makeValidationError(
      `The current ${opts.config.provider} model does not accept ${unsupported.mimeType} attachments. Supported attachment kinds: ${describeSupportedUserMessageAttachments(
        opts.config.provider,
        opts.config.model,
      )}.`
    );
  }

  const importedAttachments: UserMessageAttachment[] = [];
  for (const attachment of attachments) {
    importedAttachments.push(
      await importAttachmentFile(opts.config.workingDirectory, attachment),
    );
  }

  return {
    content: buildImportedMessageContent(opts.text, importedAttachments, attachments),
    attachments: importedAttachments,
    titleText: opts.text.trim() || attachmentTitleSummary(importedAttachments),
  };
}

export const __internal = {
  attachmentTitleSummary,
  attachmentWorkspaceNote,
  buildImportedMessageContent,
  importAttachmentFile,
  resolveUniqueImportPath,
} as const;
