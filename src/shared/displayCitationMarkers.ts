const citationClusterPattern = /(?:[ \t]*[【\[]\d+(?::\d+)?†[^\]】]+[】\]])+/g;
const citationMarkerPattern = /[【\[](\d+)(?::\d+)?†[^\]】]+[】\]]/g;
const citationSpacingExemptPrefix = /[\s([{'"“‘-]/;
const citationChipTitlePrefix = "__cowork_citation_sources__:";

type CitationDisplayOptions = {
  citationUrlsByIndex?: ReadonlyMap<number, string>;
  citationSourcesByIndex?: ReadonlyMap<number, CitationSource>;
  citationMode?: "plain" | "markdown" | "html";
  annotations?: unknown;
  fallbackToSourcesFooter?: boolean;
};

type CitationFeedItem = {
  id: string;
  kind?: string;
  type?: string;
  role?: string;
  name?: string;
  result?: unknown;
  annotations?: unknown;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function extractToolResultText(value: unknown): string | null {
  if (typeof value === "string") {
    return value;
  }

  if (Array.isArray(value)) {
    const textParts = value
      .map((entry) => extractToolResultText(entry))
      .filter((entry): entry is string => typeof entry === "string" && entry.length > 0);
    return textParts.length > 0 ? textParts.join("\n") : null;
  }

  if (!isRecord(value)) {
    return null;
  }

  if (typeof value.value === "string") {
    return value.value;
  }

  if (typeof value.text === "string") {
    return value.text;
  }

  if ("output" in value) {
    return extractToolResultText(value.output);
  }

  if ("result" in value) {
    return extractToolResultText(value.result);
  }

  return null;
}

function maybeParseJson(value: string): unknown {
  const trimmed = value.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) {
    return undefined;
  }

  try {
    return JSON.parse(trimmed);
  } catch {
    return undefined;
  }
}

function toMarkdownCitationLabel(id: string, citationUrlsByIndex?: ReadonlyMap<number, string>): string | null {
  const numericId = Number.parseInt(id, 10);
  const url = Number.isFinite(numericId) ? citationUrlsByIndex?.get(numericId) : undefined;
  return url ? `[${id}](${url})` : null;
}

function toHtmlCitationLabel(id: string, citationUrlsByIndex?: ReadonlyMap<number, string>): string | null {
  const numericId = Number.parseInt(id, 10);
  const url = Number.isFinite(numericId) ? citationUrlsByIndex?.get(numericId) : undefined;
  return url ? `<a href="${url}">${id}</a>` : null;
}

function toHtmlCitationCluster(ids: string[], citationUrlsByIndex?: ReadonlyMap<number, string>): string {
  const renderedIds = ids
    .map((id) => toHtmlCitationLabel(id, citationUrlsByIndex))
    .filter((value): value is string => Boolean(value));
  return renderedIds.length > 0 ? `<sup>${renderedIds.join(",")}</sup>` : "";
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function extractOverflowFilePath(value: unknown): string | null {
  if (!isRecord(value)) {
    return null;
  }

  if (typeof value.filePath === "string" && value.filePath.trim().length > 0) {
    return value.filePath;
  }

  if ("output" in value) {
    return extractOverflowFilePath(value.output);
  }

  if ("result" in value) {
    return extractOverflowFilePath(value.result);
  }

  return null;
}

type LinkCitationAnnotation = {
  startIndex: number;
  endIndex: number;
  url: string;
  title?: string;
};

type MarkdownLinkSpan = {
  labelEnd: number;
  destinationEnd: number;
};

function backtickRunLengthAt(text: string, index: number): number {
  if (text[index] !== "`") return 0;
  let end = index;
  while (end < text.length && text[end] === "`") {
    end += 1;
  }
  return end - index;
}

function markdownFenceLengthAtLineStart(text: string, index: number): number {
  const marker = text[index];
  if (marker !== "`" && marker !== "~") {
    return 0;
  }
  let end = index;
  while (end < text.length && text[end] === marker) {
    end += 1;
  }
  const length = end - index;
  return length >= 3 ? length : 0;
}

function skipMarkdownLine(text: string, index: number): number {
  let cursor = index;
  while (cursor < text.length && text[cursor] !== "\n") {
    cursor += 1;
  }
  if (cursor < text.length && text[cursor] === "\n") {
    cursor += 1;
  }
  return cursor;
}

function skipMarkdownLinePrefix(text: string, index: number): number {
  let cursor = index;

  while (cursor < text.length) {
    const base = cursor;
    let probe = cursor;

    while (probe < text.length && (text[probe] === " " || text[probe] === "\t") && probe - base < 4) {
      probe += 1;
    }

    if (text[probe] === ">") {
      probe += 1;
      while (probe < text.length && (text[probe] === " " || text[probe] === "\t")) {
        probe += 1;
      }
      cursor = probe;
      continue;
    }

    const headingMatch = text.slice(probe).match(/^#{1,6}(?=\s)/);
    if (headingMatch) {
      probe += headingMatch[0].length;
      while (probe < text.length && (text[probe] === " " || text[probe] === "\t")) {
        probe += 1;
      }
      cursor = probe;
      continue;
    }

    const unorderedListMatch = text.slice(probe).match(/^[-+*](?=\s)/);
    if (unorderedListMatch) {
      probe += unorderedListMatch[0].length;
      while (probe < text.length && (text[probe] === " " || text[probe] === "\t")) {
        probe += 1;
      }
      cursor = probe;
      continue;
    }

    const orderedListMatch = text.slice(probe).match(/^\d+[.)](?=\s)/);
    if (orderedListMatch) {
      probe += orderedListMatch[0].length;
      while (probe < text.length && (text[probe] === " " || text[probe] === "\t")) {
        probe += 1;
      }
      cursor = probe;
      continue;
    }

    return cursor;
  }

  return cursor;
}

function markdownDelimiterRunLengthAt(text: string, index: number): number {
  const marker = text[index];
  if (marker !== "*" && marker !== "_" && marker !== "~") {
    return 0;
  }

  let end = index;
  while (end < text.length && text[end] === marker && end - index < 3) {
    end += 1;
  }
  const length = end - index;

  if (marker === "~" && length < 2) {
    return 0;
  }

  if (length >= 2) {
    return length;
  }

  const previous = index > 0 ? text[index - 1] ?? "" : "";
  const next = text[end] ?? "";
  const previousWhitespace = previous.length === 0 || /\s/.test(previous);
  const nextWhitespace = next.length === 0 || /\s/.test(next);
  return !previousWhitespace && !nextWhitespace ? 1 : 0;
}

function findMarkdownLinkSpan(text: string, index: number): MarkdownLinkSpan | null {
  if (text[index] !== "[") {
    return null;
  }

  let labelEnd = index + 1;
  while (labelEnd < text.length) {
    const current = text[labelEnd];
    if (current === "\\" && labelEnd + 1 < text.length) {
      labelEnd += 2;
      continue;
    }
    if (current === "]") {
      break;
    }
    labelEnd += 1;
  }

  if (labelEnd >= text.length || text[labelEnd] !== "]" || text[labelEnd + 1] !== "(") {
    return null;
  }

  let depth = 1;
  let destinationEnd = labelEnd + 2;
  while (destinationEnd < text.length) {
    const current = text[destinationEnd];
    if (current === "\\" && destinationEnd + 1 < text.length) {
      destinationEnd += 2;
      continue;
    }
    if (current === "(") {
      depth += 1;
    } else if (current === ")") {
      depth -= 1;
      if (depth === 0) {
        return {
          labelEnd,
          destinationEnd: destinationEnd + 1,
        };
      }
    }
    destinationEnd += 1;
  }

  return null;
}

function markdownLinkDestinationEndAt(text: string, index: number): number | null {
  if (text[index] !== "]" || text[index + 1] !== "(") {
    return null;
  }

  let depth = 1;
  let cursor = index + 2;
  while (cursor < text.length) {
    const current = text[cursor];
    if (current === "\\" && cursor + 1 < text.length) {
      cursor += 2;
      continue;
    }
    if (current === "(") {
      depth += 1;
    } else if (current === ")") {
      depth -= 1;
      if (depth === 0) {
        return cursor + 1;
      }
    }
    cursor += 1;
  }

  return null;
}

function advancePastTrailingMarkdownSyntax(text: string, index: number): number {
  let cursor = index;

  while (cursor < text.length) {
    const linkDestinationEnd = markdownLinkDestinationEndAt(text, cursor);
    if (linkDestinationEnd !== null) {
      cursor = linkDestinationEnd;
      continue;
    }

    const backticks = backtickRunLengthAt(text, cursor);
    if (backticks > 0) {
      cursor += backticks;
      continue;
    }

    const delimiterLength = markdownDelimiterRunLengthAt(text, cursor);
    if (delimiterLength > 0) {
      cursor += delimiterLength;
      continue;
    }

    break;
  }

  return cursor;
}

function buildMarkdownVisibleOffsetMap(text: string): number[] {
  const offsets = [0];
  let cursor = 0;
  let lineStart = true;
  let fenceMarker: { char: string; length: number } | null = null;
  let inlineCodeTicks = 0;
  let activeLink: MarkdownLinkSpan | null = null;

  while (cursor < text.length) {
    if (lineStart) {
      if (fenceMarker) {
        const closingFenceLength = markdownFenceLengthAtLineStart(text, cursor);
        if (closingFenceLength >= fenceMarker.length && text[cursor] === fenceMarker.char) {
          cursor = skipMarkdownLine(text, cursor);
          lineStart = true;
          fenceMarker = null;
          continue;
        }
      } else {
        const openingFenceLength = markdownFenceLengthAtLineStart(text, cursor);
        if (openingFenceLength > 0) {
          fenceMarker = { char: text[cursor]!, length: openingFenceLength };
          cursor = skipMarkdownLine(text, cursor);
          lineStart = true;
          continue;
        }
      }

      const afterPrefix = skipMarkdownLinePrefix(text, cursor);
      if (afterPrefix !== cursor) {
        cursor = afterPrefix;
        lineStart = false;
        continue;
      }
    }

    if (activeLink && cursor === activeLink.labelEnd) {
      cursor = activeLink.destinationEnd;
      activeLink = null;
      continue;
    }

    if (inlineCodeTicks > 0) {
      const closingRun = backtickRunLengthAt(text, cursor);
      if (closingRun === inlineCodeTicks) {
        cursor += closingRun;
        inlineCodeTicks = 0;
        continue;
      }

      const char = text[cursor]!;
      cursor += 1;
      offsets.push(cursor);
      lineStart = char === "\n";
      continue;
    }

    if (fenceMarker) {
      const char = text[cursor]!;
      cursor += 1;
      offsets.push(cursor);
      lineStart = char === "\n";
      continue;
    }

    if (text[cursor] === "\\" && cursor + 1 < text.length) {
      const escapedChar = text[cursor + 1]!;
      cursor += 2;
      offsets.push(cursor);
      lineStart = escapedChar === "\n";
      continue;
    }

    if (text[cursor] === "[") {
      const linkSpan = findMarkdownLinkSpan(text, cursor);
      if (linkSpan) {
        activeLink = linkSpan;
        cursor += 1;
        continue;
      }
    }

    const openingBackticks = backtickRunLengthAt(text, cursor);
    if (openingBackticks > 0) {
      inlineCodeTicks = openingBackticks;
      cursor += openingBackticks;
      continue;
    }

    const delimiterLength = markdownDelimiterRunLengthAt(text, cursor);
    if (delimiterLength > 0) {
      cursor += delimiterLength;
      continue;
    }

    const char = text[cursor]!;
    cursor += 1;
    offsets.push(cursor);
    lineStart = char === "\n";
  }

  return offsets;
}

function isLetterOrNumber(char: string | undefined): boolean {
  return typeof char === "string" && /\p{L}|\p{N}/u.test(char);
}

function isSkippableMarkdownAnchorChar(char: string | undefined): boolean {
  return typeof char === "string" && /[\s*_`#[\]()<>+-]/.test(char);
}

function findPreviousAnchorCharIndex(text: string, index: number): number | null {
  let cursor = Math.min(index, text.length - 1);
  while (cursor >= 0) {
    const current = text[cursor];
    if (!isSkippableMarkdownAnchorChar(current)) {
      return cursor;
    }
    cursor -= 1;
  }
  return null;
}

function findPreviousSentenceBoundaryIndex(text: string, index: number): number | null {
  let cursor = Math.min(index, text.length - 1);
  while (cursor >= 0) {
    const current = text[cursor];
    if (current === "." || current === "!" || current === "?") {
      return cursor;
    }
    cursor -= 1;
  }
  return null;
}

function countLeadingWordCharsSince(text: string, boundaryIndex: number, targetIndex: number): number {
  let count = 0;
  for (let cursor = boundaryIndex + 1; cursor <= targetIndex && cursor < text.length; cursor += 1) {
    const current = text[cursor];
    if (isLetterOrNumber(current)) {
      count += 1;
      continue;
    }
    if (!isSkippableMarkdownAnchorChar(current)) {
      return Number.POSITIVE_INFINITY;
    }
  }
  return count;
}

function resolveRawAnnotationEndIndex(text: string, rawEndIndex: number): number {
  if (text.length === 0) {
    return 0;
  }

  const normalizedEndIndex = Math.max(0, Math.min(Math.trunc(rawEndIndex), text.length - 1));
  const previousAnchorCharIndex = findPreviousAnchorCharIndex(text, normalizedEndIndex);
  if (previousAnchorCharIndex === null) {
    return 0;
  }

  let anchorCharIndex = previousAnchorCharIndex;
  const previousSentenceBoundaryIndex = findPreviousSentenceBoundaryIndex(text, anchorCharIndex);
  if (previousSentenceBoundaryIndex !== null && previousSentenceBoundaryIndex < anchorCharIndex) {
    const leadingWordChars = countLeadingWordCharsSince(text, previousSentenceBoundaryIndex, anchorCharIndex);
    if (leadingWordChars > 0 && leadingWordChars <= 3) {
      anchorCharIndex = previousSentenceBoundaryIndex;
    }
  }

  return Math.min(advancePastTrailingMarkdownSyntax(text, anchorCharIndex + 1), text.length);
}

function resolveMarkdownAnnotationEndIndex(text: string, rawEndIndex: number): number {
  const visibleOffsetMap = buildMarkdownVisibleOffsetMap(text);
  const normalizedEndIndex = Math.max(0, Math.trunc(rawEndIndex));
  const mappedIndex = normalizedEndIndex < visibleOffsetMap.length
    ? visibleOffsetMap[normalizedEndIndex]!
    : Math.min(normalizedEndIndex, text.length);
  return Math.min(advancePastTrailingMarkdownSyntax(text, mappedIndex), text.length);
}

function scoreAnnotationBoundary(text: string, boundaryIndex: number): number {
  const previous = boundaryIndex > 0 ? text[boundaryIndex - 1] : "";
  const next = boundaryIndex < text.length ? text[boundaryIndex] : "";

  let score = 0;
  if (isLetterOrNumber(previous) && isLetterOrNumber(next)) {
    score -= 10;
  }
  if (previous === "." || previous === "!" || previous === "?") {
    score += 8;
  }
  if (isLetterOrNumber(previous) && (!next || /\s/.test(next))) {
    score += 4;
  }
  if (next === "*" || next === "#" || next === ">" || next === "-" || next === "+") {
    score -= 6;
  }
  if (previous === "\n" || previous === "\r") {
    score -= 4;
  }
  return score;
}

function resolveAnnotationEndIndex(text: string, rawEndIndex: number): number {
  const rawIndex = resolveRawAnnotationEndIndex(text, rawEndIndex);
  const markdownIndex = resolveMarkdownAnnotationEndIndex(text, rawEndIndex);
  return scoreAnnotationBoundary(text, rawIndex) >= scoreAnnotationBoundary(text, markdownIndex)
    ? rawIndex
    : markdownIndex;
}

function findLineStartIndex(text: string, index: number): number {
  const boundedIndex = Math.max(0, Math.min(index, text.length));
  const previousNewline = text.lastIndexOf("\n", Math.max(0, boundedIndex - 1));
  return previousNewline === -1 ? 0 : previousNewline + 1;
}

function findLineEndIndex(text: string, lineStartIndex: number): number {
  const nextNewline = text.indexOf("\n", lineStartIndex);
  return nextNewline === -1 ? text.length : nextNewline;
}

function trimTrailingInlineWhitespace(text: string, endIndex: number): number {
  let cursor = Math.max(0, Math.min(endIndex, text.length));
  while (cursor > 0) {
    const current = text[cursor - 1];
    if (current !== " " && current !== "\t" && current !== "\r") {
      break;
    }
    cursor -= 1;
  }
  return cursor;
}

function markdownLineKind(text: string, lineStartIndex: number): "blank" | "structured" | "plain" {
  const lineEndIndex = findLineEndIndex(text, lineStartIndex);
  const rawLine = text.slice(lineStartIndex, lineEndIndex);
  if (rawLine.trim().length === 0) {
    return "blank";
  }

  const normalized = rawLine.replace(/^[ \t]{0,3}/, "");
  if (/^(?:>\s?|#{1,6}\s+|[-+*]\s+|\d+[.)]\s+)/.test(normalized)) {
    return "structured";
  }

  return "plain";
}

function resolveCitationBlockEndIndex(text: string, anchorEndIndex: number): number {
  if (text.length === 0) {
    return 0;
  }

  const boundedAnchorEndIndex = Math.max(0, Math.min(anchorEndIndex, text.length));
  let lineStartIndex = findLineStartIndex(text, boundedAnchorEndIndex);
  let lineEndIndex = findLineEndIndex(text, lineStartIndex);
  let blockEndIndex = trimTrailingInlineWhitespace(text, lineEndIndex);

  if (markdownLineKind(text, lineStartIndex) === "structured") {
    return blockEndIndex;
  }

  while (lineEndIndex < text.length && text[lineEndIndex] === "\n") {
    const nextLineStartIndex = lineEndIndex + 1;
    const nextLineKind = markdownLineKind(text, nextLineStartIndex);
    if (nextLineKind !== "plain") {
      break;
    }

    lineStartIndex = nextLineStartIndex;
    lineEndIndex = findLineEndIndex(text, lineStartIndex);
    blockEndIndex = trimTrailingInlineWhitespace(text, lineEndIndex);
  }

  return blockEndIndex;
}

function extractLinkCitationAnnotations(value: unknown): LinkCitationAnnotation[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const annotations: LinkCitationAnnotation[] = [];
  for (const entry of value) {
    if (!isRecord(entry)) continue;
    if (entry.type !== "url_citation" && entry.type !== "place_citation") continue;
    if (typeof entry.url !== "string" || entry.url.trim().length === 0) continue;
    if (typeof entry.start_index !== "number" || !Number.isFinite(entry.start_index)) continue;
    if (typeof entry.end_index !== "number" || !Number.isFinite(entry.end_index)) continue;
    annotations.push({
      startIndex: Math.max(0, Math.trunc(entry.start_index)),
      endIndex: Math.max(0, Math.trunc(entry.end_index)),
      url: entry.url,
      ...(typeof entry.title === "string" && entry.title.trim().length > 0
        ? { title: entry.title }
        : typeof entry.name === "string" && entry.name.trim().length > 0
          ? { title: entry.name }
          : {}),
    });
  }

  return annotations.sort((left, right) => left.endIndex - right.endIndex || left.startIndex - right.startIndex);
}

export function extractCitationUrlsFromAnnotations(annotations: unknown): Map<number, string> {
  const byUrl = new Map<string, number>();
  const out = new Map<number, string>();

  for (const annotation of extractLinkCitationAnnotations(annotations)) {
    if (byUrl.has(annotation.url)) continue;
    const nextIndex = byUrl.size + 1;
    byUrl.set(annotation.url, nextIndex);
    out.set(nextIndex, annotation.url);
  }

  return out;
}

export type CitationSource = {
  url: string;
  title?: string;
};

export type CitationSourceDisplayInfo = {
  displayUrl: string | null;
  faviconHostname: string | null;
  hostLabel: string;
  opaqueRedirect: boolean;
  titleLabel: string;
};

const opaqueCitationRedirectHosts = new Set([
  "vertexaisearch.cloud.google.com",
]);

function citationSourceHostname(url: string): string | null {
  try {
    const hostname = new URL(url).hostname.replace(/^www\./, "");
    return hostname.length > 0 ? hostname : null;
  } catch {
    return null;
  }
}

function normalizeCitationHostnameLabel(value: string | undefined): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim().replace(/^https?:\/\//i, "").replace(/^www\./i, "");
  if (!trimmed || /[/?#\s]/.test(trimmed)) {
    return null;
  }

  return /^(?:[a-z0-9-]+\.)+[a-z]{2,}$/i.test(trimmed) ? trimmed.toLowerCase() : null;
}

export function isOpaqueCitationRedirectUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return opaqueCitationRedirectHosts.has(parsed.hostname) && parsed.pathname.startsWith("/grounding-api-redirect/");
  } catch {
    return false;
  }
}

export function describeCitationSource(source: CitationSource): CitationSourceDisplayInfo {
  const titleLabel = source.title?.trim() || citationSourceHostname(source.url) || source.url;
  const opaqueRedirect = isOpaqueCitationRedirectUrl(source.url);
  const titleHostname = normalizeCitationHostnameLabel(source.title);
  const urlHostname = citationSourceHostname(source.url);
  const hostLabel = opaqueRedirect
    ? titleHostname ?? urlHostname ?? "Source"
    : urlHostname ?? titleHostname ?? source.url;

  return {
    titleLabel,
    hostLabel,
    displayUrl: opaqueRedirect ? null : source.url,
    faviconHostname: titleHostname ?? urlHostname,
    opaqueRedirect,
  };
}

type CitationChipSourcePayload = {
  id: string;
  url: string;
  title?: string;
};

function extractCitationSourcesByIndexFromAnnotations(
  annotations: unknown,
  citationUrlsByIndex?: ReadonlyMap<number, string>,
): Map<number, CitationSource> {
  const resolvedCitationUrlsByIndex = citationUrlsByIndex ?? extractCitationUrlsFromAnnotations(annotations);
  const indexByUrl = new Map<string, number>();
  for (const [index, url] of resolvedCitationUrlsByIndex) {
    indexByUrl.set(url, index);
  }

  const out = new Map<number, CitationSource>();
  for (const annotation of extractLinkCitationAnnotations(annotations)) {
    const citationIndex = indexByUrl.get(annotation.url);
    if (!citationIndex || out.has(citationIndex)) {
      continue;
    }

    out.set(citationIndex, annotation.title
      ? { url: annotation.url, title: annotation.title }
      : { url: annotation.url });
  }
  return out;
}

function buildCitationSourcesByIndex(options: CitationDisplayOptions): Map<number, CitationSource> {
  const out = new Map<number, CitationSource>();

  for (const [index, source] of options.citationSourcesByIndex ?? []) {
    out.set(index, source);
  }

  for (const [index, source] of extractCitationSourcesByIndexFromAnnotations(options.annotations, options.citationUrlsByIndex)) {
    if (!out.has(index)) {
      out.set(index, source);
    }
  }

  for (const [index, url] of options.citationUrlsByIndex ?? []) {
    if (!out.has(index)) {
      out.set(index, { url });
    }
  }

  return out;
}

function displayCitationSourceLabel(source: CitationSource): string {
  const title = source.title?.trim();
  if (title && title.length > 0 && title.length <= 28) {
    return title;
  }

  try {
    const hostname = new URL(source.url).hostname.replace(/^www\./, "");
    return hostname || source.url;
  } catch {
    return source.url;
  }
}

function truncateLabel(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }
  return `${value.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}

function serializeCitationChipSources(sources: readonly CitationChipSourcePayload[]): string {
  return encodeURIComponent(JSON.stringify(sources));
}

function renderCitationChip(ids: string[], options: CitationDisplayOptions): string {
  if (ids.length === 0) {
    return "";
  }

  const citationSourcesByIndex = buildCitationSourcesByIndex(options);
  const resolvedSources = ids
    .map((id) => {
      const numericId = Number.parseInt(id, 10);
      if (!Number.isFinite(numericId)) {
        return null;
      }
      const source = citationSourcesByIndex.get(numericId);
      const url = source?.url ?? options.citationUrlsByIndex?.get(numericId);
      if (!url || url.trim().length === 0) {
        return null;
      }

      return source?.title
        ? { id, url, title: source.title }
        : { id, url };
    })
    .filter((source): source is CitationChipSourcePayload => Boolean(source));
  const primaryId = ids.find((id) => {
    const numericId = Number.parseInt(id, 10);
    return Number.isFinite(numericId) && citationSourcesByIndex.has(numericId);
  }) ?? ids[0]!;
  const primaryIndex = Number.parseInt(primaryId, 10);
  const primarySource = Number.isFinite(primaryIndex) ? citationSourcesByIndex.get(primaryIndex) : undefined;
  const primaryUrl = Number.isFinite(primaryIndex) ? options.citationUrlsByIndex?.get(primaryIndex) : undefined;
  const baseLabel = primarySource ? displayCitationSourceLabel(primarySource) : `Source ${primaryId}`;
  const chipLabel = ids.length > 1
    ? `${truncateLabel(baseLabel, 26)} +${ids.length - 1}`
    : truncateLabel(baseLabel, 30);
  const encodedSources = resolvedSources.length > 0 ? serializeCitationChipSources(resolvedSources) : "";

  if (!primaryUrl || primaryUrl.trim().length === 0) {
    return `<cite>${escapeHtml(chipLabel)}</cite>`;
  }

  return `<cite title="${escapeHtml(`${citationChipTitlePrefix}${encodedSources}`)}">${escapeHtml(chipLabel)}</cite>`;
}

function exaResultsArray(value: unknown): unknown[] {
  if (typeof value === "string") {
    const parsed = maybeParseJson(value);
    if (parsed !== undefined) {
      return exaResultsArray(parsed);
    }
    return [];
  }

  if (!isRecord(value)) {
    return [];
  }

  if (Array.isArray(value.results)) {
    return value.results;
  }

  if (isRecord(value.response) && Array.isArray(value.response.results)) {
    return value.response.results;
  }

  if ("output" in value) {
    return exaResultsArray(value.output);
  }

  if ("result" in value) {
    return exaResultsArray(value.result);
  }

  return [];
}

function extractStructuredCitationSourcesFromWebSearchResult(result: unknown): CitationSource[] {
  const sources: CitationSource[] = [];
  const seenUrls = new Set<string>();

  for (const entry of exaResultsArray(result)) {
    if (!isRecord(entry)) continue;
    const url = typeof entry.url === "string" ? entry.url.trim() : "";
    if (!url || seenUrls.has(url)) continue;
    seenUrls.add(url);

    const source: CitationSource = { url };
    const title = typeof entry.title === "string" ? entry.title.trim() : "";
    if (title) {
      source.title = title;
    }
    sources.push(source);
  }

  return sources;
}

function extractCitationUrlsFromNativeWebSearchResult(result: unknown): Map<number, string> {
  const record = isRecord(result) ? result : null;
  const directSources = Array.isArray(record?.sources)
    ? record.sources
    : isRecord(record?.action) && Array.isArray(record.action.sources)
      ? record.action.sources
      : [];
  const urls = directSources
    .map((source) => {
      if (!isRecord(source)) return null;
      return typeof source.url === "string" && source.url.trim().length > 0 ? source.url : null;
    })
    .filter((url): url is string => !!url);
  return new Map(urls.map((url, index) => [index + 1, url] as const));
}

function extractCitationSourcesFromNativeWebSearchResult(result: unknown): Map<number, CitationSource> {
  const record = isRecord(result) ? result : null;
  const directSources = Array.isArray(record?.sources)
    ? record.sources
    : isRecord(record?.action) && Array.isArray(record.action.sources)
      ? record.action.sources
      : [];
  const sources = directSources
    .map((source) => {
      if (!isRecord(source)) return null;
      if (typeof source.url !== "string" || source.url.trim().length === 0) return null;
      const entry: CitationSource = { url: source.url };
      if (typeof source.title === "string" && source.title.trim().length > 0) {
        entry.title = source.title;
      }
      return entry;
    })
    .filter((s): s is CitationSource => !!s);
  return new Map(sources.map((source, index) => [index + 1, source] as const));
}

function extractCitationSourcesFromNativeUrlContextResult(result: unknown): Map<number, CitationSource> {
  const record = isRecord(result) ? result : null;
  const urls = [
    ...(
      Array.isArray(record?.urls)
        ? record.urls
        : []
    ),
    ...(
      Array.isArray(record?.results)
        ? record.results.map((entry) => isRecord(entry) ? entry.url : undefined)
        : []
    ),
  ]
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0);
  const deduped = [...new Set(urls)];
  return new Map(deduped.map((url, index) => [index + 1, { url }] as const));
}

function extractCitationUrlsFromNativeUrlContextResult(result: unknown): Map<number, string> {
  return new Map(
    [...extractCitationSourcesFromNativeUrlContextResult(result).entries()].map(([index, source]) => [index, source.url] as const),
  );
}

function renderCitationIds(
  ids: string[],
  options: CitationDisplayOptions,
  previousChar: string,
): string {
  if (ids.length === 0) {
    return "";
  }

  const renderMode = options.citationMode ?? "plain";
  if (renderMode === "html") {
    return toHtmlCitationCluster(ids, options.citationUrlsByIndex);
  }

  const spacingPrefix = previousChar && !citationSpacingExemptPrefix.test(previousChar) ? " " : "";
  const renderedIds = ids.map((id) => {
    if (renderMode === "markdown") {
      return toMarkdownCitationLabel(id, options.citationUrlsByIndex);
    }
    return `[${id}]`;
  }).filter((value): value is string => Boolean(value));

  if (renderedIds.length === 0) {
    return "";
  }

  return `${spacingPrefix}${renderedIds.join(", ")}`;
}

function renderSourcesFooter(options: CitationDisplayOptions): string {
  const citationUrlsByIndex = options.citationUrlsByIndex;
  if (!citationUrlsByIndex || citationUrlsByIndex.size === 0) {
    return "";
  }

  const renderMode = options.citationMode ?? "plain";
  const ids = [...citationUrlsByIndex.keys()].sort((left, right) => left - right).map(String);
  if (renderMode === "html") {
    const links = ids
      .map((id) => toHtmlCitationLabel(id, citationUrlsByIndex))
      .filter((value): value is string => Boolean(value));
    return links.length > 0 ? `<p>Sources: ${links.join(", ")}</p>` : "";
  }
  const renderedIds = ids.map((id) => {
    if (renderMode === "markdown") {
      return toMarkdownCitationLabel(id, citationUrlsByIndex);
    }
    return `[${id}]`;
  }).filter((value): value is string => Boolean(value));
  return renderedIds.length > 0 ? `Sources: ${renderedIds.join(", ")}` : "";
}

function insertNativeCitationMarkers(text: string, options: CitationDisplayOptions): string {
  const annotations = extractLinkCitationAnnotations(options.annotations);
  if (annotations.length === 0) {
    return text;
  }

  const citationUrlsByIndex = options.citationUrlsByIndex ?? extractCitationUrlsFromAnnotations(options.annotations);
  const indexByUrl = new Map<string, number>();
  for (const [index, url] of citationUrlsByIndex) {
    indexByUrl.set(url, index);
  }

  const idsByEndIndex = new Map<number, string[]>();
  for (const annotation of annotations) {
    const citationIndex = indexByUrl.get(annotation.url);
    if (!citationIndex) continue;
    const resolvedEndIndex = resolveAnnotationEndIndex(text, annotation.endIndex);
    const insertionEndIndex = options.citationMode === "html"
      ? resolveCitationBlockEndIndex(text, resolvedEndIndex)
      : resolvedEndIndex;
    const currentIds = idsByEndIndex.get(insertionEndIndex) ?? [];
    const nextId = String(citationIndex);
    if (!currentIds.includes(nextId)) {
      currentIds.push(nextId);
      idsByEndIndex.set(insertionEndIndex, currentIds);
    }
  }

  if (idsByEndIndex.size === 0) {
    return text;
  }

  let out = "";
  let cursor = 0;
  const orderedEndIndexes = [...idsByEndIndex.keys()].sort((left, right) => left - right);
  for (const rawEndIndex of orderedEndIndexes) {
    const endIndex = Math.min(Math.max(rawEndIndex, cursor), text.length);
    out += text.slice(cursor, endIndex);
    const ids = idsByEndIndex.get(rawEndIndex) ?? [];
    if (options.citationMode === "html") {
      out += renderCitationChip(ids, {
        ...options,
        citationUrlsByIndex,
      });
    } else {
      const previousChar = endIndex > 0 ? text[endIndex - 1] ?? "" : "";
      out += renderCitationIds(ids, {
        ...options,
        citationUrlsByIndex,
      }, previousChar);
    }
    cursor = endIndex;
  }
  out += text.slice(cursor);
  return out;
}

export function extractCitationSourcesFromWebSearchResult(result: unknown): CitationSource[] {
  const structuredSources = extractStructuredCitationSourcesFromWebSearchResult(result);
  if (structuredSources.length > 0) {
    return structuredSources;
  }

  const text = extractToolResultText(result);
  if (!text) return [];

  const lines = text.split(/\r?\n/).map((line) => line.trim());
  const sources: CitationSource[] = [];

  for (let i = 0; i < lines.length; i++) {
    if (/^https?:\/\/\S+$/.test(lines[i])) {
      const url = lines[i];
      // The line before the URL is typically the title
      const titleCandidate = i > 0 ? lines[i - 1] : "";
      const title = titleCandidate && !/^https?:\/\//.test(titleCandidate) && titleCandidate.length > 0
        ? titleCandidate
        : undefined;
      sources.push({ url, title });
    }
  }

  return sources;
}

export function extractCitationUrlsFromWebSearchResult(result: unknown): Map<number, string> {
  const structuredSources = extractStructuredCitationSourcesFromWebSearchResult(result);
  if (structuredSources.length > 0) {
    return new Map(structuredSources.map((source, index) => [index + 1, source.url] as const));
  }

  const text = extractToolResultText(result);
  if (!text) {
    return new Map();
  }

  const urls = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /^https?:\/\/\S+$/.test(line));

  return new Map(urls.map((url, index) => [index + 1, url] as const));
}

export function extractCitationOverflowFilePathFromWebSearchResult(result: unknown): string | null {
  return extractOverflowFilePath(result);
}

export function buildCitationOverflowFilePathsByMessageId<T extends CitationFeedItem>(feed: readonly T[]): Map<string, string> {
  const overflowFilePathByMessageId = new Map<string, string>();
  let currentOverflowFilePath: string | null = null;

  for (const item of feed) {
    const itemKind = item.kind ?? item.type ?? "";

    if (itemKind === "message" && item.role === "user") {
      currentOverflowFilePath = null;
      continue;
    }

    if (itemKind === "tool" && item.name === "webSearch") {
      currentOverflowFilePath = extractCitationOverflowFilePathFromWebSearchResult(item.result);
      continue;
    }

    if (itemKind === "message" && item.role === "assistant" && currentOverflowFilePath) {
      overflowFilePathByMessageId.set(item.id, currentOverflowFilePath);
    }
  }

  return overflowFilePathByMessageId;
}

export function buildCitationUrlsByMessageId<T extends CitationFeedItem>(feed: readonly T[]): Map<string, Map<number, string>> {
  const citationUrlsByMessageId = new Map<string, Map<number, string>>();
  let currentCitationUrls = new Map<number, string>();

  for (const item of feed) {
    const itemKind = item.kind ?? item.type ?? "";

    if (itemKind === "message" && item.role === "user") {
      currentCitationUrls = new Map();
      continue;
    }

    if (itemKind === "tool" && item.name === "webSearch") {
      const nextCitationUrls = extractCitationUrlsFromWebSearchResult(item.result);
      currentCitationUrls = nextCitationUrls;
      continue;
    }

    if (itemKind === "tool" && item.name === "nativeWebSearch") {
      const nextCitationUrls = extractCitationUrlsFromNativeWebSearchResult(item.result);
      currentCitationUrls = nextCitationUrls;
      continue;
    }

    if (itemKind === "tool" && item.name === "nativeUrlContext") {
      const nextCitationUrls = extractCitationUrlsFromNativeUrlContextResult(item.result);
      currentCitationUrls = nextCitationUrls;
      continue;
    }

    if (itemKind === "message" && item.role === "assistant") {
      const annotationCitationUrls = extractCitationUrlsFromAnnotations(item.annotations);
      if (annotationCitationUrls.size > 0) {
        citationUrlsByMessageId.set(item.id, annotationCitationUrls);
        currentCitationUrls = annotationCitationUrls;
        continue;
      }
      if (currentCitationUrls.size > 0) {
        citationUrlsByMessageId.set(item.id, new Map(currentCitationUrls));
      }
    }
  }

  return citationUrlsByMessageId;
}

export function buildCitationSourcesByMessageId<T extends CitationFeedItem>(feed: readonly T[]): Map<string, CitationSource[]> {
  const sourcesByMessageId = new Map<string, CitationSource[]>();
  let currentSources: CitationSource[] = [];

  for (const item of feed) {
    const itemKind = item.kind ?? item.type ?? "";

    if (itemKind === "message" && item.role === "user") {
      currentSources = [];
      continue;
    }

    if (itemKind === "tool" && item.name === "nativeWebSearch") {
      const nextSources = extractCitationSourcesFromNativeWebSearchResult(item.result);
      currentSources = [...nextSources.values()];
      continue;
    }

    if (itemKind === "tool" && item.name === "nativeUrlContext") {
      const nextSources = extractCitationSourcesFromNativeUrlContextResult(item.result);
      currentSources = [...nextSources.values()];
      continue;
    }

    if (itemKind === "tool" && item.name === "webSearch") {
      const nextSources = extractCitationSourcesFromWebSearchResult(item.result);
      currentSources = nextSources;
      continue;
    }

    if (itemKind === "message" && item.role === "assistant" && currentSources.length > 0) {
      sourcesByMessageId.set(item.id, [...currentSources]);
    }
  }

  return sourcesByMessageId;
}

export function normalizeDisplayCitationMarkers(text: string, options: CitationDisplayOptions = {}): string {
  if (!text.includes("†")) {
    if (options.annotations) {
      return insertNativeCitationMarkers(text, options);
    }
    if (options.fallbackToSourcesFooter && options.citationUrlsByIndex?.size && !/\bSources:\b/i.test(text)) {
      const footer = renderSourcesFooter(options);
      return footer ? `${text}\n\n${footer}` : text;
    }
    return text;
  }

  return text.replace(citationClusterPattern, (match, offset, input) => {
    const ids: string[] = [];
    const seen = new Set<string>();

    for (const citationMatch of match.matchAll(citationMarkerPattern)) {
      const id = citationMatch[1];
      if (!id || seen.has(id)) {
        continue;
      }
      seen.add(id);
      ids.push(id);
    }

    if (ids.length === 0) {
      return match;
    }

    const leadingWhitespace = match.match(/^\s*/)?.[0] ?? "";
    const previousChar = offset > 0 ? input[offset - 1] ?? "" : "";
    const rendered = renderCitationIds(ids, options, previousChar);
    if (!rendered) {
      return "";
    }
    return leadingWhitespace.length > 0 ? `${leadingWhitespace}${rendered.trimStart()}` : rendered;
  });
}
