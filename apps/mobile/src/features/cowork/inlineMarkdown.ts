export type InlineMarkdownRun =
  | { type: "text"; content: string }
  | { type: "code"; content: string }
  | { type: "bold"; content: string }
  | { type: "italic"; content: string }
  | { type: "link"; label: string; href: string };

const MARKDOWN_LINK_PATTERN = /\[([^\]]+)\]\(([^)]+)\)/;
const AUTO_LINK_PATTERN = /(?:https?:\/\/|www\.)[^\s<>[\]()]+/gi;
const STYLE_TOKEN_PATTERN = /(\*\*[^*]+\*\*|\*[^*]+\*|_[^_]+_)/g;

function trimTrailingUrlPunctuation(url: string): { url: string; trailing: string } {
  let trimmed = url;
  let trailing = "";
  while (trimmed.length > 0 && /[.,;:!?)]$/.test(trimmed)) {
    const last = trimmed.at(-1);
    if (last === ")") {
      const opens = (trimmed.match(/\(/g) ?? []).length;
      const closes = (trimmed.match(/\)/g) ?? []).length;
      if (closes <= opens) {
        break;
      }
    }
    trimmed = trimmed.slice(0, -1);
    trailing = `${last}${trailing}`;
  }
  return { url: trimmed, trailing };
}

export function normalizeInlineLinkHref(href: string): string | null {
  const trimmed = href.trim();
  if (!trimmed) return null;
  if (/^https?:\/\//i.test(trimmed)) {
    return trimmed;
  }
  if (/^www\./i.test(trimmed)) {
    return `https://${trimmed}`;
  }
  return null;
}

/** Shorten raw URLs to a readable hostname for display. */
export function formatLinkDisplayLabel(label: string, href: string): string {
  const trimmedLabel = label.trim();
  const looksLikeRawUrl = /^https?:\/\//i.test(trimmedLabel) || /^www\./i.test(trimmedLabel);
  if (trimmedLabel && !looksLikeRawUrl) {
    return trimmedLabel;
  }

  const normalized = normalizeInlineLinkHref(href);
  if (!normalized) {
    return trimmedLabel || href;
  }

  try {
    const hostname = new URL(normalized).hostname.replace(/^www\./i, "");
    return hostname || trimmedLabel || href;
  } catch {
    return trimmedLabel || href;
  }
}

function parseStyledText(text: string, out: InlineMarkdownRun[]) {
  if (!text) return;

  let lastIndex = 0;
  const styleTokenRegex = new RegExp(STYLE_TOKEN_PATTERN.source, "g");
  let match = styleTokenRegex.exec(text);
  while (match !== null) {
    if (match.index > lastIndex) {
      out.push({ type: "text", content: text.slice(lastIndex, match.index) });
    }

    const token = match[0];
    if (token.startsWith("**") && token.endsWith("**")) {
      out.push({ type: "bold", content: token.slice(2, -2) });
    } else if (
      (token.startsWith("*") && token.endsWith("*")) ||
      (token.startsWith("_") && token.endsWith("_"))
    ) {
      out.push({ type: "italic", content: token.slice(1, -1) });
    } else {
      out.push({ type: "text", content: token });
    }

    lastIndex = match.index + token.length;
    match = styleTokenRegex.exec(text);
  }

  if (lastIndex < text.length) {
    out.push({ type: "text", content: text.slice(lastIndex) });
  }
}

function parseLinkedText(text: string, out: InlineMarkdownRun[]) {
  if (!text) return;

  const combinedRegex = new RegExp(
    `${MARKDOWN_LINK_PATTERN.source}|${AUTO_LINK_PATTERN.source}`,
    "gi",
  );
  let lastIndex = 0;
  let match = combinedRegex.exec(text);
  while (match !== null) {
    if (match.index > lastIndex) {
      parseStyledText(text.slice(lastIndex, match.index), out);
    }

    if (match[1] !== undefined && match[2] !== undefined) {
      const href = normalizeInlineLinkHref(match[2]);
      if (href) {
        out.push({ type: "link", label: match[1], href });
      } else {
        parseStyledText(match[0], out);
      }
    } else {
      const raw = match[0];
      const { url, trailing } = trimTrailingUrlPunctuation(raw);
      const href = normalizeInlineLinkHref(url);
      if (href) {
        out.push({ type: "link", label: url, href });
        if (trailing) {
          parseStyledText(trailing, out);
        }
      } else {
        parseStyledText(raw, out);
      }
    }

    lastIndex = match.index + match[0].length;
    match = combinedRegex.exec(text);
  }

  if (lastIndex < text.length) {
    parseStyledText(text.slice(lastIndex), out);
  }
}

export function parseInlineMarkdown(text: string): InlineMarkdownRun[] {
  const runs: InlineMarkdownRun[] = [];
  const codeParts = text.split(/(`[^`]+`)/g);

  for (const part of codeParts) {
    if (!part) continue;
    if (part.startsWith("`") && part.endsWith("`")) {
      runs.push({ type: "code", content: part.slice(1, -1) });
      continue;
    }
    parseLinkedText(part, runs);
  }

  return runs;
}
