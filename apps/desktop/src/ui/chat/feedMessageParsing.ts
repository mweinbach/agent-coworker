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
  if (!fileName) return null;
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
  if (
    /^<spreadsheet_canvas_request(?:\s[^<>]*)?>[\s\S]*<\/spreadsheet_canvas_request>$/.test(trimmed)
  ) {
    return parseSpreadsheetEnvelope(trimmed);
  }
  if (/^<canvas_request(?:\s[^<>]*)?>[\s\S]*<\/canvas_request>$/.test(trimmed)) {
    return parseDocumentEnvelope(trimmed);
  }
  if (trimmed.startsWith("[Canvas Collaborative Edit]")) return parseLegacyCanvasEdit(trimmed);
  return null;
}

function parseAttachmentNameList(raw: string): string[] {
  const unwrapped = raw
    .trim()
    .replace(/^\[[\s\u00A0]*/, "")
    .replace(/[\s\u00A0]*\]$/, "");
  if (!unwrapped) return [];
  const names = unwrapped
    .split(/,\s+/)
    .map((name) => name.trim())
    .filter(Boolean);
  // Legacy transcripts encoded files in ordinary text. Only interpret a list
  // of recognizable filenames; an ambiguous list must stay authored text.
  return names.every((name) => {
    const basename = attachmentDisplayName(name);
    return !/[\r\n\0]/.test(name) && /\.[A-Za-z][A-Za-z0-9_-]*$/.test(basename);
  })
    ? names
    : [];
}

function parseUserMessageAttachments(text: string): {
  cleanText: string;
  fileNames: string[];
} {
  const attachedMatch = text.match(/\n\nAttached:\s+\[(.*?)\]\s*$/);
  if (attachedMatch) {
    const fileNames = parseAttachmentNameList(attachedMatch[1]);
    if (fileNames.length > 0) {
      return { cleanText: text.substring(0, attachedMatch.index).trim(), fileNames };
    }
  }

  const attachedLooseMatch = text.match(/\n\nAttached:\s*(\S[\s\S]*)$/);
  if (attachedLooseMatch) {
    const fileNames = parseAttachmentNameList(attachedLooseMatch[1]);
    if (fileNames.length > 0) {
      return { cleanText: text.substring(0, attachedLooseMatch.index).trim(), fileNames };
    }
  }

  const onlyAttachmentsMatch = text.match(/^\[(.*?)\]\s*$/);
  if (onlyAttachmentsMatch) {
    const fileNames = parseAttachmentNameList(onlyAttachmentsMatch[1]);
    if (fileNames.length > 0) return { cleanText: "", fileNames };
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
  if (opts.attachments.length === 0) return opts.bodyText;
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
  const canvas = parseCanvasRequest(parsed.cleanText);
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
