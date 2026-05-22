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
