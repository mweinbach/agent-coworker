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

export function parseUserMessageAttachments(text: string): {
  cleanText: string;
  fileNames: string[];
} {
  const attachedMatch = text.match(/\n\nAttached:\s+\[(.*?)\]$/);
  if (attachedMatch) {
    const fileNames = attachedMatch[1]
      .split(/,\s+/)
      .map((f) => f.trim())
      .filter(Boolean);
    const cleanText = text.substring(0, attachedMatch.index).trim();
    return { cleanText, fileNames };
  }

  const onlyAttachmentsMatch = text.match(/^\[(.*?)\]$/);
  if (onlyAttachmentsMatch) {
    const fileNames = onlyAttachmentsMatch[1]
      .split(/,\s+/)
      .map((f) => f.trim())
      .filter(Boolean);
    return { cleanText: "", fileNames };
  }

  return { cleanText: text, fileNames: [] };
}
