/**
 * Markdown selection transforms for Canvas editing.
 * Prefer these over document.execCommand so formatting stays markdown-source-true.
 */

export type MarkdownFormatKind = "bold" | "italic" | "h1" | "h2" | "h3" | "paragraph" | "ul" | "ol";

export type MarkdownSelectionTransform = {
  next: string;
  selectionStart: number;
  selectionEnd: number;
};

function wrapInline(
  content: string,
  start: number,
  end: number,
  open: string,
  close: string,
): MarkdownSelectionTransform {
  const selected = content.slice(start, end);
  const body = selected.length > 0 ? selected : "text";
  const next = `${content.slice(0, start)}${open}${body}${close}${content.slice(end)}`;
  return {
    next,
    selectionStart: start + open.length,
    selectionEnd: start + open.length + body.length,
  };
}

function transformLines(
  content: string,
  start: number,
  end: number,
  mapLine: (line: string, index: number) => string,
): MarkdownSelectionTransform {
  const lineStart = content.lastIndexOf("\n", Math.max(0, start - 1)) + 1;
  let lineEnd = content.indexOf("\n", end);
  if (lineEnd < 0) lineEnd = content.length;
  const block = content.slice(lineStart, lineEnd);
  const lines = block.split("\n");
  const mapped = lines.map(mapLine).join("\n");
  const next = `${content.slice(0, lineStart)}${mapped}${content.slice(lineEnd)}`;
  return {
    next,
    selectionStart: lineStart,
    selectionEnd: lineStart + mapped.length,
  };
}

export function applyMarkdownFormat(
  content: string,
  selectionStart: number,
  selectionEnd: number,
  kind: MarkdownFormatKind,
): MarkdownSelectionTransform {
  const start = Math.max(0, Math.min(selectionStart, selectionEnd, content.length));
  const end = Math.max(0, Math.min(Math.max(selectionStart, selectionEnd), content.length));

  switch (kind) {
    case "bold":
      return wrapInline(content, start, end, "**", "**");
    case "italic":
      return wrapInline(content, start, end, "*", "*");
    case "h1":
      return transformLines(content, start, end, (line) =>
        line.replace(/^\s{0,3}#{1,6}\s+/, "").replace(/^/, "# "),
      );
    case "h2":
      return transformLines(content, start, end, (line) =>
        line.replace(/^\s{0,3}#{1,6}\s+/, "").replace(/^/, "## "),
      );
    case "h3":
      return transformLines(content, start, end, (line) =>
        line.replace(/^\s{0,3}#{1,6}\s+/, "").replace(/^/, "### "),
      );
    case "paragraph":
      return transformLines(content, start, end, (line) =>
        line.replace(/^\s{0,3}(#{1,6}\s+|[-*+]\s+|\d+\.\s+)/, ""),
      );
    case "ul":
      return transformLines(content, start, end, (line) => {
        const stripped = line.replace(/^\s{0,3}([-*+]\s+|\d+\.\s+|#{1,6}\s+)/, "");
        return stripped ? `- ${stripped}` : "- ";
      });
    case "ol":
      return transformLines(content, start, end, (line, index) => {
        const stripped = line.replace(/^\s{0,3}([-*+]\s+|\d+\.\s+|#{1,6}\s+)/, "");
        return stripped ? `${index + 1}. ${stripped}` : `${index + 1}. `;
      });
    default:
      return { next: content, selectionStart: start, selectionEnd: end };
  }
}
