function truncate(text: string, max = 180): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1)}…`;
}

export function normalizeReasoningMarkdown(text: string): string {
  const normalized = text.replace(/\r\n?/g, "\n").trim();
  if (!normalized) return "";

  return normalized
    .replace(/(\S)\*{4,}(?=\S)/g, "$1**\n\n**")
    .replace(/(\S)_{4,}(?=\S)/g, "$1__\n\n__")
    .trim();
}

function isStandaloneMarkdownHeading(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed) return false;
  if (/^#{1,6}\s+\S/.test(trimmed)) return true;
  if (/^\*\*[^*]+\*\*$/.test(trimmed)) return true;
  if (/^__[^_]+__$/.test(trimmed)) return true;
  return false;
}

export function buildMarkdownPreviewText(text: string, maxLines = 2, maxChars = 180): string {
  const lines = text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  if (lines.length === 0) return "";

  const previewLines = [...lines];
  while (previewLines.length > 1 && isStandaloneMarkdownHeading(previewLines[0] ?? "")) {
    previewLines.shift();
  }

  const joined = previewLines.slice(0, maxLines).join(" ");
  const preview = previewLines.length > maxLines ? `${joined}…` : joined;
  return truncate(preview, maxChars);
}
