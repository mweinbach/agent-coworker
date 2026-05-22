import { getAttachmentByteLengthValidationMessage } from "../../../shared/attachments";
import {
  googleMultimodalPartTypeForMime,
  type MultimodalContentPartType,
} from "../../../shared/multimodalMime";
import type { FileAttachment, OrderedInputPart } from "../../jsonrpc/routes/shared";

export const LARGE_MULTIMODAL_OUTPUT_GUIDANCE =
  '[System: For large audio, video, or PDF transcription/extraction tasks, do not stream the full transcript, extracted text, or detailed summary in chat. The uploaded media is already attached to this message, so do not call read on the uploaded media path just to inspect, transcribe, or summarize it. Create the requested file in the workspace with the write tool. Use mode="overwrite" for the first chunk and mode="append" for later chunks, keeping each chunk bounded. Return only the file path and a concise summary in chat.]';

const largeMultimodalOutputRequestPattern =
  /\b(transcribe|transcribed|transcribing|transcript|transcription|markdown|file|document|extract|extraction|extracting|ocr|caption|captions|subtitle|subtitles|srt|notes|minutes)\b/i;

export const largeMultimodalOutputPartTypes = new Set<MultimodalContentPartType>([
  "audio",
  "video",
  "document",
]);

export function getAttachmentContentPartType(
  mimeType: string,
  opts: { modelSupportsImages: boolean; isGoogleProvider: boolean },
): MultimodalContentPartType | null {
  return googleMultimodalPartTypeForMime(mimeType, opts);
}

function collectUserTextForAttachmentGuidance(
  text: string,
  inputParts?: readonly OrderedInputPart[],
): string {
  const orderedText = (inputParts ?? [])
    .filter((part): part is Extract<OrderedInputPart, { type: "text" }> => part.type === "text")
    .map((part) => part.text)
    .join("\n");
  return [text, orderedText].filter((part) => part.trim().length > 0).join("\n");
}

export function shouldInjectLargeMultimodalOutputGuidance(
  text: string,
  attachments: readonly FileAttachment[] | undefined,
  inputParts: readonly OrderedInputPart[] | undefined,
  opts: { modelSupportsImages: boolean; isGoogleProvider: boolean },
): boolean {
  if (!opts.isGoogleProvider || !attachments || attachments.length === 0) {
    return false;
  }

  const userText = collectUserTextForAttachmentGuidance(text, inputParts);
  if (!largeMultimodalOutputRequestPattern.test(userText)) {
    return false;
  }

  return attachments.some((attachment) => {
    const partType = getAttachmentContentPartType(attachment.mimeType, opts);
    return partType ? largeMultimodalOutputPartTypes.has(partType) : false;
  });
}

export function getUploadedMultimodalAttachmentValidationMessage(
  byteLengths: readonly number[],
): string | null {
  const message = getAttachmentByteLengthValidationMessage(byteLengths);
  if (message === "File too large to send inline (max 25MB)") {
    return "Uploaded multimodal file too large to send to the model (max 25MB)";
  }
  if (message === "Inline attachments too large in total (max 25MB combined)") {
    return "Uploaded multimodal attachments too large to send to the model (max 25MB combined)";
  }
  return message;
}
