import { getFilePreviewKind } from "../../lib/filePreviewKind";

export type CanvasRequestSurface = "spreadsheet" | "document";

export type CanvasRequest = {
  /** Which embedded canvas surface produced this request. */
  surface: CanvasRequestSurface;
  fileName: string | null;
  /** File kind hint (e.g. "xlsx", "csv", "markdown", "slide", "text"). */
  fileKind: string | null;
  /** Spreadsheet only: active sheet name. */
  sheet: string | null;
  /** Spreadsheet only: selected range or active cell, in A1 notation. */
  region: string | null;
  /** Selected preview text — a spreadsheet cell value or a document selection. */
  selectionText: string | null;
  userRequest: string;
};

function unescapeXml(value: string): string {
  // Order matters: decode "&amp;" last so a literal "&lt;" isn't double-decoded.
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

function firstCapture(text: string, pattern: RegExp): string | null {
  const match = text.match(pattern);
  if (!match || match[1] === undefined) return null;
  const decoded = unescapeXml(match[1]).trim();
  return decoded.length > 0 ? decoded : null;
}

// `<spreadsheet_canvas_request>` — see `lib/univerSpreadsheet.ts`.
function parseSpreadsheetEnvelope(text: string): CanvasRequest | null {
  const userRequestMatch = text.match(/<user_request>([\s\S]*?)<\/user_request>/);
  if (!userRequestMatch) return null;

  const selectionMatch = text.match(/<selection\s+range="([^"]*)"\s+active_cell="([^"]*)"/);
  const range = selectionMatch ? unescapeXml(selectionMatch[1]).trim() : "";
  const activeCell = selectionMatch ? unescapeXml(selectionMatch[2]).trim() : "";

  return {
    surface: "spreadsheet",
    fileName: firstCapture(text, /<workbook\b[^>]*?\sfile_name="([^"]*)"/),
    fileKind: firstCapture(text, /<workbook\b[^>]*?\skind="([^"]*)"/),
    sheet: firstCapture(text, /<active_sheet>([\s\S]*?)<\/active_sheet>/),
    region: range || activeCell || null,
    selectionText: firstCapture(text, /<selection\b[^>]*>\s*<value>([\s\S]*?)<\/value>/),
    userRequest: unescapeXml(userRequestMatch[1]).trim(),
  };
}

// `<canvas_request>` — see `lib/canvasRequest.ts`.
function parseDocumentEnvelope(text: string): CanvasRequest | null {
  const userRequestMatch = text.match(/<user_request>([\s\S]*?)<\/user_request>/);
  if (!userRequestMatch) return null;

  return {
    surface: "document",
    fileName: firstCapture(text, /<file\b[^>]*?\sname="([^"]*)"/),
    fileKind: firstCapture(text, /<file\b[^>]*?\skind="([^"]*)"/),
    sheet: null,
    region: null,
    selectionText: firstCapture(text, /<selection>([\s\S]*?)<\/selection>/),
    userRequest: unescapeXml(userRequestMatch[1]).trim(),
  };
}

// Legacy markdown envelope from older document-canvas builds, kept so historical
// transcripts render through the same bubble.
function parseLegacyCanvasEdit(text: string): CanvasRequest | null {
  const instMarker = "**Instructions:**\n";
  const instIdx = text.indexOf(instMarker);
  if (instIdx === -1) return null;

  const fileName = text.match(/edit the file `([^`]+)`/)?.[1]?.trim() ?? null;
  const rest = text.slice(instIdx + instMarker.length);
  const targetMarker = "\n\n**Target Section / Selection:**";
  const targetIdx = rest.indexOf(targetMarker);

  let instructions = rest;
  let selection: string | null = null;
  if (targetIdx !== -1) {
    instructions = rest.slice(0, targetIdx);
    const selPart = rest.slice(targetIdx + targetMarker.length).trim();
    selection = selPart.startsWith(">") ? selPart.slice(1).trim() : selPart;
  }

  return {
    surface: "document",
    fileName,
    fileKind: null,
    sheet: null,
    region: null,
    selectionText: selection ? selection.trim() || null : null,
    userRequest: instructions.trim(),
  };
}

/**
 * Parse any embedded-canvas request a user message may carry so the transcript
 * can render a compact file/region header above the request instead of the raw
 * envelope. Handles the spreadsheet XML envelope, the document XML envelope, and
 * the legacy markdown envelope from older builds. Returns null for ordinary
 * messages.
 */
export function parseCanvasRequest(text: string): CanvasRequest | null {
  const trimmed = text.trim();
  if (trimmed.startsWith("<spreadsheet_canvas_request")) return parseSpreadsheetEnvelope(trimmed);
  if (trimmed.startsWith("<canvas_request")) return parseDocumentEnvelope(trimmed);
  if (trimmed.startsWith("[Canvas Collaborative Edit]")) return parseLegacyCanvasEdit(trimmed);
  return null;
}

function looksLikeCanvasEnvelope(text: string): boolean {
  const trimmed = text.trim();
  return (
    trimmed.startsWith("<spreadsheet_canvas_request") ||
    trimmed.startsWith("<canvas_request") ||
    trimmed.startsWith("[Canvas Collaborative Edit]")
  );
}

function inferCanvasSurface(text: string): CanvasRequestSurface {
  return text.trim().startsWith("<spreadsheet_canvas_request") ? "spreadsheet" : "document";
}

/**
 * Recover a compact canvas model from a stored envelope, including malformed
 * or partial payloads. Never returns null for a recognized envelope — the
 * transcript can always show a readable chip instead of raw serialization.
 */
export function interpretCanvasRequest(text: string): CanvasRequest | null {
  const trimmed = text.trim();
  if (!looksLikeCanvasEnvelope(trimmed)) return null;

  const parsed = parseCanvasRequest(trimmed);
  if (parsed) return parsed;

  const userRequest = firstCapture(trimmed, /<user_request>([\s\S]*?)<\/user_request>/) ?? "";
  const fileName =
    firstCapture(trimmed, /<workbook\b[^>]*?\sfile_name="([^"]*)"/) ??
    firstCapture(trimmed, /<file\b[^>]*?\sname="([^"]*)"/) ??
    trimmed.match(/edit the file `([^`]+)`/)?.[1]?.trim() ??
    null;

  return {
    surface: inferCanvasSurface(trimmed),
    fileName,
    fileKind: firstCapture(trimmed, /\skind="([^"]*)"/),
    sheet: firstCapture(trimmed, /<active_sheet>([\s\S]*?)<\/active_sheet>/),
    region: firstCapture(trimmed, /\srange="([^"]*)"/),
    selectionText:
      firstCapture(trimmed, /<selection\b[^>]*>\s*<value>([\s\S]*?)<\/value>/) ??
      firstCapture(trimmed, /<selection>([\s\S]*?)<\/selection>/),
    userRequest,
  };
}

function parseAttachmentNameList(raw: string): string[] {
  const unwrapped = raw
    .trim()
    .replace(/^\[[\s\u00A0]*/, "")
    .replace(/[\s\u00A0]*\]$/, "");
  if (!unwrapped) return [];
  return unwrapped
    .split(/,\s+/)
    .map((name) => name.trim())
    .filter(Boolean);
}

export function parseUserMessageAttachments(text: string): {
  cleanText: string;
  fileNames: string[];
} {
  const attachedMatch = text.match(/\n\nAttached:\s+\[(.*?)\]\s*$/);
  if (attachedMatch) {
    return {
      cleanText: text.substring(0, attachedMatch.index).trim(),
      fileNames: parseAttachmentNameList(attachedMatch[1]),
    };
  }

  const attachedLooseMatch = text.match(/\n\nAttached:\s*(\S[\s\S]*)$/);
  if (attachedLooseMatch) {
    return {
      cleanText: text.substring(0, attachedLooseMatch.index).trim(),
      fileNames: parseAttachmentNameList(attachedLooseMatch[1]),
    };
  }

  const onlyAttachmentsMatch = text.match(/^\[(.*?)\]\s*$/);
  if (onlyAttachmentsMatch) {
    return {
      cleanText: "",
      fileNames: parseAttachmentNameList(onlyAttachmentsMatch[1]),
    };
  }

  return { cleanText: text, fileNames: [] };
}

export type VisibleUserAttachment = {
  fileName: string;
  displayName: string;
  isImage: boolean;
};

export type VisibleUserMessage = {
  bodyText: string;
  attachments: VisibleUserAttachment[];
  canvas: CanvasRequest | null;
  copyText: string;
};

function attachmentDisplayName(fileName: string): string {
  const normalized = fileName.replace(/\\/g, "/").trim();
  const base = normalized.split("/").pop()?.trim();
  if (!base || base === "." || base === "..") return fileName.trim();
  return base;
}

export function canvasFallbackName(surface: CanvasRequestSurface): string {
  return surface === "spreadsheet" ? "Spreadsheet" : "Document";
}

function formatCanvasCopyText(request: CanvasRequest): string {
  const header = [
    request.fileName ?? canvasFallbackName(request.surface),
    request.sheet,
    request.region,
  ]
    .filter((part): part is string => Boolean(part?.trim()))
    .join(" · ");
  const lines: string[] = [];
  if (header) lines.push(header);
  if (request.selectionText) lines.push(`\u201C${request.selectionText}\u201D`);
  if (request.userRequest) lines.push(request.userRequest);
  return lines.join("\n");
}

function formatAttachmentCopyText(attachments: readonly VisibleUserAttachment[]): string {
  const names = attachments.map((attachment) => attachment.displayName).filter(Boolean);
  if (names.length === 0) return "";
  if (names.length === 1) return names[0];
  return `Attached: ${names.join(", ")}`;
}

function formatVisibleUserCopyText(opts: {
  bodyText: string;
  attachments: readonly VisibleUserAttachment[];
  canvas: CanvasRequest | null;
}): string {
  if (opts.canvas) {
    const canvasText = formatCanvasCopyText(opts.canvas);
    const attached = formatAttachmentCopyText(opts.attachments);
    if (canvasText && attached) return `${canvasText}\n\n${attached}`;
    return canvasText || attached;
  }
  const attached = formatAttachmentCopyText(opts.attachments);
  const body = opts.bodyText.trim();
  if (body && attached) return `${body}\n\n${attached}`;
  return body || attached;
}

function isImageAttachmentName(fileName: string): boolean {
  return (
    getFilePreviewKind(fileName) === "image" ||
    getFilePreviewKind(attachmentDisplayName(fileName)) === "image"
  );
}

/**
 * One semantic view of a persisted user turn: visible body, attachments, canvas
 * context, and the clipboard string. Callers must not copy or render `rawText`
 * once this model exists — that string can contain attachment/Canvas markup.
 */
export function buildVisibleUserMessage(rawText: string): VisibleUserMessage {
  const parsed = parseUserMessageAttachments(rawText);
  const canvas = interpretCanvasRequest(parsed.cleanText);
  const attachments = parsed.fileNames.map((fileName) => ({
    fileName,
    displayName: attachmentDisplayName(fileName),
    isImage: isImageAttachmentName(fileName),
  }));
  const bodyText = canvas ? canvas.userRequest : parsed.cleanText;
  return {
    bodyText,
    attachments,
    canvas,
    copyText: formatVisibleUserCopyText({
      bodyText: canvas ? canvas.userRequest : parsed.cleanText,
      attachments,
      canvas,
    }),
  };
}
