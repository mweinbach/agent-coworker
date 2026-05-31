export type SpreadsheetCanvasRequest = {
  fileName: string | null;
  kind: string | null;
  sheet: string | null;
  selectionRange: string | null;
  activeCell: string | null;
  value: string | null;
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

/**
 * Parse the `<spreadsheet_canvas_request>` envelope the Univer canvas sends as a
 * chat message (see `lib/univerSpreadsheet.ts#buildUniverSpreadsheetPrompt`).
 * The renderer uses this to show a compact file/region header above the user's
 * request instead of the raw XML blob. Returns null for non-canvas messages.
 */
export function parseSpreadsheetCanvasRequest(text: string): SpreadsheetCanvasRequest | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith("<spreadsheet_canvas_request")) return null;

  const userRequestMatch = trimmed.match(/<user_request>([\s\S]*?)<\/user_request>/);
  if (!userRequestMatch) return null;

  const selectionMatch = trimmed.match(/<selection\s+range="([^"]*)"\s+active_cell="([^"]*)"/);

  return {
    fileName: firstCapture(trimmed, /<workbook\b[^>]*?\sfile_name="([^"]*)"/),
    kind: firstCapture(trimmed, /<workbook\b[^>]*?\skind="([^"]*)"/),
    sheet: firstCapture(trimmed, /<active_sheet>([\s\S]*?)<\/active_sheet>/),
    selectionRange: selectionMatch ? (unescapeXml(selectionMatch[1]).trim() || null) : null,
    activeCell: selectionMatch ? (unescapeXml(selectionMatch[2]).trim() || null) : null,
    value: firstCapture(trimmed, /<selection\b[^>]*>\s*<value>([\s\S]*?)<\/value>/),
    userRequest: unescapeXml(userRequestMatch[1]).trim(),
  };
}

export function parseCanvasEditMessage(text: string) {
  if (!text.startsWith("[Open Canvas Collaborative Edit]")) return null;

  const instMarker = "**Instructions:**\n";
  const instIdx = text.indexOf(instMarker);
  if (instIdx === -1) return null;

  const rest = text.slice(instIdx + instMarker.length);

  const targetMarker = "\n\n**Target Section / Selection:**\n> ";
  const targetIdx = rest.indexOf(targetMarker);

  let instructions = rest;
  let selection: string | null = null;

  if (targetIdx !== -1) {
    instructions = rest.slice(0, targetIdx);
    selection = rest.slice(targetIdx + targetMarker.length);
  } else {
    const targetMarkerAlt = "\n\n**Target Section / Selection:**";
    const targetIdxAlt = rest.indexOf(targetMarkerAlt);
    if (targetIdxAlt !== -1) {
      instructions = rest.slice(0, targetIdxAlt);
      const selPart = rest.slice(targetIdxAlt + targetMarkerAlt.length).trim();
      if (selPart.startsWith(">")) {
        selection = selPart.slice(1).trim();
      } else {
        selection = selPart;
      }
    }
  }

  return {
    instructions: instructions.trim(),
    selection: selection ? selection.trim() : null,
  };
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
