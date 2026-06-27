import { extractDocxSnapshot } from "./docx";
import {
  artifactBuffer,
  binaryMetadata,
  decodeUtf8,
  detectArtifactKind,
  detectImageMimeType,
  mimeTypeForArtifact,
} from "./ooxml";
import { extractPptxSnapshot } from "./pptx";
import type { ArtifactBlobInput, ArtifactPreview } from "./types";
import { extractXlsxSnapshot } from "./xlsx";

const MAX_PDF_METADATA_SCAN_BYTES = 16 * 1024 * 1024;
export const MAX_PREVIEW_TEXT_CHARS = 1024 * 1024;
export const MAX_INLINE_PREVIEW_BYTES = 16 * 1024 * 1024;

export class ArtifactPreviewService {
  async preview(input: ArtifactBlobInput): Promise<ArtifactPreview> {
    const bytes = artifactBuffer(input);
    const metadata = binaryMetadata(input);
    const kind = await detectArtifactKind(input);
    const base = {
      filename: input.filename,
      mimeType: mimeTypeForArtifact(input),
      sizeBytes: bytes.byteLength,
      sha256: metadata.sha256,
      warnings: [] as string[],
    };
    try {
      switch (kind) {
        case "text":
          return { kind: "text", ...base, ...readBoundedTextPreview(bytes) };
        case "image": {
          if (bytes.byteLength > MAX_INLINE_PREVIEW_BYTES) {
            return {
              kind: "binary",
              ...base,
              metadata,
              warnings: [
                `Image preview was not inlined because it exceeds ${MAX_INLINE_PREVIEW_BYTES} bytes.`,
              ],
            };
          }
          const mimeType = detectImageMimeType(bytes) ?? base.mimeType;
          const dimensions = readImageDimensions(bytes, mimeType);
          return {
            kind: "image",
            ...base,
            mimeType,
            dataUrl: `data:${mimeType};base64,${bytes.toString("base64")}`,
            width: dimensions?.width ?? null,
            height: dimensions?.height ?? null,
          };
        }
        case "pdf":
          if (bytes.byteLength > MAX_INLINE_PREVIEW_BYTES) {
            return {
              kind: "binary",
              ...base,
              metadata,
              warnings: [
                `PDF preview was not inlined because it exceeds ${MAX_INLINE_PREVIEW_BYTES} bytes.`,
              ],
            };
          }
          return {
            kind: "pdf",
            ...base,
            mimeType: "application/pdf",
            dataUrl: `data:application/pdf;base64,${bytes.toString("base64")}`,
            pageCount: estimatePdfPageCount(bytes),
          };
        case "docx":
          return { kind: "docx", ...base, document: await extractDocxSnapshot(bytes) };
        case "pptx":
          return { kind: "pptx", ...base, presentation: await extractPptxSnapshot(bytes) };
        case "xlsx":
          return { kind: "xlsx", ...base, workbook: await extractXlsxSnapshot(bytes) };
        default:
          return {
            kind: "binary",
            ...base,
            metadata,
            warnings: ["No typed preview is available for this binary artifact."],
          };
      }
    } catch (error) {
      return {
        kind: "binary",
        ...base,
        metadata,
        warnings: [
          `The ${kind} artifact could not be parsed safely; showing binary metadata instead: ${formatError(error)}`,
        ],
      };
    }
  }
}

function readBoundedTextPreview(bytes: Buffer): {
  text: string;
  encoding: "utf-8";
  warnings: string[];
} {
  const scanLimit = Math.min(bytes.byteLength, MAX_PREVIEW_TEXT_CHARS * 4 + 4);
  let decoded: string | null = null;
  let consumed = scanLimit;
  for (let trim = 0; trim <= 4 && scanLimit - trim >= 0; trim += 1) {
    try {
      decoded = decodeUtf8(bytes.subarray(0, scanLimit - trim));
      consumed = scanLimit - trim;
      break;
    } catch {
      // A capped UTF-8 slice can end in the middle of a code point. Back off
      // at most four bytes; any other decoding failure is returned below.
    }
  }
  if (decoded === null) decoded = decodeUtf8(bytes);
  const truncated = decoded.length > MAX_PREVIEW_TEXT_CHARS || consumed < bytes.byteLength;
  return {
    text: decoded.slice(0, MAX_PREVIEW_TEXT_CHARS),
    encoding: "utf-8",
    warnings: truncated ? [`Text preview was capped at ${MAX_PREVIEW_TEXT_CHARS} characters.`] : [],
  };
}

function estimatePdfPageCount(bytes: Buffer): number | null {
  if (bytes.byteLength > MAX_PDF_METADATA_SCAN_BYTES) return null;
  const content = bytes.toString("latin1");
  const matches = content.match(/\/Type\s*\/Page(?!s)\b/g);
  return matches ? matches.length : null;
}

function readImageDimensions(
  bytes: Buffer,
  mimeType: string,
): { width: number; height: number } | null {
  if (mimeType === "image/png" && bytes.byteLength >= 24) {
    return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
  }
  if (mimeType === "image/gif" && bytes.byteLength >= 10) {
    return { width: bytes.readUInt16LE(6), height: bytes.readUInt16LE(8) };
  }
  if (mimeType === "image/jpeg") return readJpegDimensions(bytes);
  if (mimeType === "image/webp") return readWebpDimensions(bytes);
  return null;
}

function readJpegDimensions(bytes: Buffer): { width: number; height: number } | null {
  let offset = 2;
  while (offset + 8 < bytes.byteLength) {
    if (bytes[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    const marker = bytes[offset + 1] ?? 0;
    if (marker === 0xd8 || marker === 0xd9) {
      offset += 2;
      continue;
    }
    const length = bytes.readUInt16BE(offset + 2);
    if (length < 2 || offset + 2 + length > bytes.byteLength) return null;
    if (
      (marker >= 0xc0 && marker <= 0xc3) ||
      (marker >= 0xc5 && marker <= 0xc7) ||
      (marker >= 0xc9 && marker <= 0xcb) ||
      (marker >= 0xcd && marker <= 0xcf)
    ) {
      return {
        height: bytes.readUInt16BE(offset + 5),
        width: bytes.readUInt16BE(offset + 7),
      };
    }
    offset += length + 2;
  }
  return null;
}

function readWebpDimensions(bytes: Buffer): { width: number; height: number } | null {
  if (bytes.byteLength < 30) return null;
  const subtype = bytes.subarray(12, 16).toString("ascii");
  if (subtype === "VP8X") {
    return {
      width: 1 + bytes.readUIntLE(24, 3),
      height: 1 + bytes.readUIntLE(27, 3),
    };
  }
  if (subtype === "VP8 " && bytes.byteLength >= 30) {
    return {
      width: bytes.readUInt16LE(26) & 0x3fff,
      height: bytes.readUInt16LE(28) & 0x3fff,
    };
  }
  return null;
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
