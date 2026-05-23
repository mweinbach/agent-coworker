import fs from "node:fs/promises";
import path from "node:path";

import { z } from "zod";
import { supportsImageInput } from "../../../models/registry";
import {
  decodeBase64Strict,
  getAttachmentCountValidationMessage,
  getAttachmentValidationMessage,
} from "../../../shared/attachments";
import {
  SERVER_ERROR_CODES,
  SERVER_ERROR_SOURCES,
  type ServerErrorCode,
  type ServerErrorSource,
} from "../../../types";
import { isPathInside, resolvePathInsideRootForBoundaryCheck } from "../../../utils/paths";
import type { FileAttachment, OrderedInputPart } from "../../jsonrpc/routes/shared";
import type { SessionContext } from "../SessionContext";
import {
  getAttachmentContentPartType,
  getUploadedMultimodalAttachmentValidationMessage,
  LARGE_MULTIMODAL_OUTPUT_GUIDANCE,
  largeMultimodalOutputPartTypes,
  shouldInjectLargeMultimodalOutputGuidance,
} from "./attachmentGuidancePolicy";

const errorWithCodeAndSourceSchema = z
  .object({
    code: z.string(),
    source: z.string().optional(),
  })
  .passthrough();
type UploadedAttachmentStat = NonNullable<Awaited<ReturnType<typeof fs.stat>>>;
const serverErrorCodeSet = new Set<string>(SERVER_ERROR_CODES);
const serverErrorSourceSet = new Set<string>(SERVER_ERROR_SOURCES);
const defaultSourceByErrorCode: Partial<Record<ServerErrorCode, ServerErrorSource>> = {
  busy: "session",
  validation_failed: "session",
  permission_denied: "permissions",
  provider_error: "provider",
  backup_error: "backup",
  observability_error: "observability",
  internal_error: "session",
};

export type ClassifiedTurnError = { code: ServerErrorCode; source: ServerErrorSource };

function isServerErrorCode(value: string): value is ServerErrorCode {
  return serverErrorCodeSet.has(value);
}

function isServerErrorSource(value: string): value is ServerErrorSource {
  return serverErrorSourceSet.has(value);
}

function classifyStructuredTurnError(err: unknown): ClassifiedTurnError | null {
  const parsed = errorWithCodeAndSourceSchema.safeParse(err);
  if (!parsed.success) return null;

  const { code, source } = parsed.data;
  if (!isServerErrorCode(code)) return null;
  if (source && isServerErrorSource(source)) {
    return { code, source };
  }

  return {
    code,
    source: defaultSourceByErrorCode[code] ?? "session",
  };
}

function makeStructuredSessionError(
  code: ServerErrorCode,
  message: string,
): Error & { code: ServerErrorCode; source: ServerErrorSource } {
  return Object.assign(new Error(message), { code, source: "session" as const });
}

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

function getAttachmentFilenameValidationMessage(
  attachments?: readonly Pick<FileAttachment, "filename">[],
): string | null {
  if (!attachments || attachments.length === 0) {
    return null;
  }
  for (const attachment of attachments) {
    const safeName = path.basename(attachment.filename);
    if (!safeName || safeName === "." || safeName === "..") {
      return `Invalid attachment filename: ${attachment.filename}`;
    }
  }
  return null;
}

export function getTurnAttachmentValidationMessage(
  attachments?: readonly FileAttachment[],
): string | null {
  const filenameMessage = getAttachmentFilenameValidationMessage(attachments);
  if (filenameMessage) {
    return filenameMessage;
  }
  const countMessage = getAttachmentCountValidationMessage(attachments?.length);
  if (countMessage) {
    return countMessage;
  }
  return getAttachmentValidationMessage(getInlineAttachments(attachments));
}

function isUploadedFileAttachment(
  attachment: FileAttachment,
): attachment is Extract<FileAttachment, { path: string }> {
  return "path" in attachment;
}

export function createTurnErrorClassifier(context: SessionContext) {
  return (err: unknown): ClassifiedTurnError => {
    const structured = classifyStructuredTurnError(err);
    if (structured) return structured;

    const message = context.formatError(err);
    const m = message.toLowerCase();
    const includesAny = (...needles: string[]) => needles.some((needle) => m.includes(needle));

    if (
      includesAny(
        "blocked: path is outside",
        "blocked: canonical target resolves outside",
        "outside allowed directories",
        "outside allowed roots",
        "blocked private/internal host",
        "blocked url protocol",
        "blocked url credentials",
        "glob blocked:",
      )
    ) {
      return { code: "permission_denied", source: "permissions" };
    }

    if (includesAny("observability", "traceql", "promql", "logql")) {
      return { code: "observability_error", source: "observability" };
    }

    if (
      includesAny(
        "oauth",
        "api key",
        "unsupported provider",
        "generated response exceeds",
        "generated response exceeded",
        "maximum allowed size limit",
        "provider size limit",
      )
    ) {
      return { code: "provider_error", source: "provider" };
    }

    if (m.includes("unknown checkpoint id")) {
      return { code: "validation_failed", source: "session" };
    }

    if (includesAny("checkpoint", "session backup")) {
      return { code: "backup_error", source: "backup" };
    }

    if (includesAny("is required", "invalid ")) {
      return { code: "validation_failed", source: "session" };
    }

    return { code: "internal_error", source: "session" };
  };
}

export type UserMessageAttachmentHelpers = {
  buildUserMessageContent: (
    text: string,
    attachments?: FileAttachment[],
    inputParts?: OrderedInputPart[],
  ) => Promise<string | Array<Record<string, unknown>>>;
  validateUploadedFileAttachments: (attachments?: readonly FileAttachment[]) => Promise<void>;
};

export function createUserMessageAttachmentHelpers(
  context: SessionContext,
): UserMessageAttachmentHelpers {
  const getUploadsDirectory = (): string => {
    const config = context.state.config;
    return config.uploadsDirectory ?? path.resolve(config.workingDirectory, "User Uploads");
  };

  const resolveUploadsDirectory = async (): Promise<string> => {
    try {
      return await resolvePathInsideRootForBoundaryCheck(
        context.state.config.workingDirectory,
        getUploadsDirectory(),
      );
    } catch {
      throw makeStructuredSessionError(
        "validation_failed",
        "Uploads directory resolves outside the workspace.",
      );
    }
  };

  const resolveUploadedAttachmentPath = async (
    uploadedPath: string,
  ): Promise<{ canonicalPath: string; stat: UploadedAttachmentStat }> => {
    const rawUploadsDir = path.resolve(getUploadsDirectory());
    const resolvedUploadsDir = await resolveUploadsDirectory();
    const diskPath = path.resolve(uploadedPath);
    if (!isPathInside(rawUploadsDir, diskPath) && !isPathInside(resolvedUploadsDir, diskPath)) {
      throw makeStructuredSessionError(
        "validation_failed",
        "Uploaded file path is outside the uploads directory.",
      );
    }

    try {
      const [canonicalPath, stat] = await Promise.all([fs.realpath(diskPath), fs.stat(diskPath)]);
      if (!isPathInside(resolvedUploadsDir, canonicalPath)) {
        throw makeStructuredSessionError(
          "validation_failed",
          "Uploaded file path is outside the uploads directory.",
        );
      }
      if (!stat.isFile()) {
        throw makeStructuredSessionError(
          "validation_failed",
          `Uploaded attachment is not a file: ${diskPath}`,
        );
      }
      return { canonicalPath, stat };
    } catch (error) {
      if (classifyStructuredTurnError(error)) {
        throw error;
      }
      throw makeStructuredSessionError(
        "validation_failed",
        `Uploaded file does not exist: ${diskPath}`,
      );
    }
  };

  const buildUserMessageContent = async (
    text: string,
    attachments?: FileAttachment[],
    inputParts?: OrderedInputPart[],
  ): Promise<string | Array<Record<string, unknown>>> => {
    if (!attachments || attachments.length === 0) {
      return text;
    }

    const config = context.state.config;
    let resolvedUploadsDir = await resolveUploadsDirectory();
    await fs.mkdir(resolvedUploadsDir, { recursive: true });
    resolvedUploadsDir = await resolveUploadsDirectory();

    const provider = config.provider;
    const model = config.model;
    const modelSupportsImages = supportsImageInput(provider, model);
    const isGoogleProvider = provider === "google";

    const usedNames = new Set<string>();
    const contentParts: Array<Record<string, unknown>> = [];
    const shouldAddLargeOutputGuidance = shouldInjectLargeMultimodalOutputGuidance(
      text,
      attachments,
      inputParts,
      {
        modelSupportsImages,
        isGoogleProvider,
      },
    );
    let largeOutputGuidanceAdded = false;
    const appendLargeOutputGuidance = () => {
      if (!shouldAddLargeOutputGuidance || largeOutputGuidanceAdded) {
        return;
      }
      contentParts.push({ type: "text", text: LARGE_MULTIMODAL_OUTPUT_GUIDANCE });
      largeOutputGuidanceAdded = true;
    };

    const appendAttachment = async (attachment: FileAttachment) => {
      const safeName = path.basename(attachment.filename);
      if (!safeName || safeName === "." || safeName === "..") {
        throw makeStructuredSessionError(
          "validation_failed",
          `Invalid attachment filename: ${attachment.filename}`,
        );
      }

      const inlineAttachment = isInlineFileAttachment(attachment) ? attachment : null;
      let diskPath: string;
      let contentReadPath: string;
      let multimodalData: string | null = null;

      if (inlineAttachment) {
        let finalName = safeName;
        if (usedNames.has(finalName)) {
          const ext = path.extname(safeName);
          const base = safeName.slice(0, safeName.length - ext.length);
          let counter = 1;
          while (usedNames.has(finalName)) {
            finalName = `${base}_${counter}${ext}`;
            counter++;
          }
        }

        const filePath = path.resolve(resolvedUploadsDir, finalName);
        if (!isPathInside(resolvedUploadsDir, filePath)) {
          throw makeStructuredSessionError(
            "validation_failed",
            `Invalid attachment filename: ${attachment.filename}`,
          );
        }

        diskPath = filePath;
        try {
          await fs.access(diskPath);
          const ext = path.extname(finalName);
          const base = finalName.slice(0, finalName.length - ext.length);
          let counter = 1;
          while (true) {
            diskPath = path.resolve(resolvedUploadsDir, `${base}_${counter}${ext}`);
            try {
              await fs.access(diskPath);
              counter++;
            } catch {
              break;
            }
          }
          finalName = path.basename(diskPath);
        } catch {
          // File doesn't exist, use as-is.
        }
        usedNames.add(finalName);

        const attachmentValidationMessage = getAttachmentValidationMessage([inlineAttachment]);
        if (attachmentValidationMessage) {
          throw makeStructuredSessionError("validation_failed", attachmentValidationMessage);
        }

        const decoded = decodeBase64Strict(inlineAttachment.contentBase64);
        if (!decoded) {
          throw makeStructuredSessionError(
            "validation_failed",
            `Invalid base64 attachment: ${safeName}`,
          );
        }
        await fs.writeFile(diskPath, decoded);
        contentReadPath = diskPath;
        multimodalData = decoded.toString("base64");
      } else {
        const uploadedAttachment = attachment as Extract<FileAttachment, { path: string }>;
        const uploadedFile = await resolveUploadedAttachmentPath(uploadedAttachment.path);
        diskPath = path.resolve(uploadedAttachment.path);
        contentReadPath = uploadedFile.canonicalPath;
      }

      const contentPartType = getAttachmentContentPartType(attachment.mimeType, {
        modelSupportsImages,
        isGoogleProvider,
      });
      const hasTargetedLargeOutputGuidance =
        shouldAddLargeOutputGuidance &&
        typeof contentPartType === "string" &&
        largeMultimodalOutputPartTypes.has(contentPartType);

      contentParts.push({
        type: "text",
        text: hasTargetedLargeOutputGuidance
          ? `[System: The user uploaded a file which has been saved to ${diskPath}. The file is already attached as ${contentPartType} content below; do not call read on this uploaded media path just to inspect, transcribe, or summarize it. Use the attached media content and write the requested output file directly.]`
          : `[System: The user uploaded a file which has been saved to ${diskPath}]`,
      });

      if (!multimodalData && contentPartType) {
        multimodalData = (await fs.readFile(contentReadPath)).toString("base64");
      }

      if (multimodalData && contentPartType) {
        contentParts.push({
          type: contentPartType,
          data: multimodalData,
          mimeType: attachment.mimeType,
        });
      }
    };

    if (inputParts && inputParts.length > 0) {
      for (const part of inputParts) {
        if (part.type === "text") {
          contentParts.push({ type: "text", text: part.text });
          continue;
        }
        appendLargeOutputGuidance();
        await appendAttachment(part);
      }
      appendLargeOutputGuidance();
      return contentParts;
    }

    if (text) {
      contentParts.push({ type: "text", text });
    }

    appendLargeOutputGuidance();

    for (const attachment of attachments) {
      await appendAttachment(attachment);
    }

    return contentParts;
  };

  const validateUploadedFileAttachments = async (
    attachments?: readonly FileAttachment[],
  ): Promise<void> => {
    const allAttachments = attachments ?? [];
    if (allAttachments.some(isInlineFileAttachment)) {
      await resolveUploadsDirectory();
    }

    const uploadedAttachments = allAttachments.filter(isUploadedFileAttachment);
    if (uploadedAttachments.length === 0) {
      return;
    }

    const config = context.state.config;
    const multimodalUploadedByteLengths: number[] = [];
    const modelSupportsImages = supportsImageInput(config.provider, config.model);
    const isGoogleProvider = config.provider === "google";
    for (const attachment of uploadedAttachments) {
      const uploadedFile = await resolveUploadedAttachmentPath(attachment.path);
      const contentPartType = getAttachmentContentPartType(attachment.mimeType, {
        modelSupportsImages,
        isGoogleProvider,
      });
      if (contentPartType) {
        multimodalUploadedByteLengths.push(Number(uploadedFile.stat.size));
      }
    }

    const validationMessage = getUploadedMultimodalAttachmentValidationMessage(
      multimodalUploadedByteLengths,
    );
    if (validationMessage) {
      throw makeStructuredSessionError("validation_failed", validationMessage);
    }
  };

  return {
    buildUserMessageContent,
    validateUploadedFileAttachments,
  };
}
