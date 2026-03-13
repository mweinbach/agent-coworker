const citationClusterPattern = /(?:[ \t]*[【\[]\d+(?::\d+)?†[^\]】]+[】\]])+/g;
const citationMarkerPattern = /[【\[](\d+)(?::\d+)?†[^\]】]+[】\]]/g;
const citationSpacingExemptPrefix = /[\s([{'"“‘-]/;

type CitationDisplayOptions = {
  citationUrlsByIndex?: ReadonlyMap<number, string>;
  citationMode?: "plain" | "markdown" | "html";
};

type CitationFeedItem = {
  id: string;
  kind?: string;
  type?: string;
  role?: string;
  name?: string;
  result?: unknown;
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

export function extractCitationUrlsFromWebSearchResult(result: unknown): Map<number, string> {
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
      if (nextCitationUrls.size > 0) {
        currentCitationUrls = nextCitationUrls;
      }
      continue;
    }

    if (itemKind === "message" && item.role === "assistant" && currentCitationUrls.size > 0) {
      citationUrlsByMessageId.set(item.id, new Map(currentCitationUrls));
    }
  }

  return citationUrlsByMessageId;
}

export function normalizeDisplayCitationMarkers(text: string, options: CitationDisplayOptions = {}): string {
  if (!text.includes("†")) {
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

    const renderMode = options.citationMode ?? "plain";
    if (renderMode === "html") {
      return toHtmlCitationCluster(ids, options.citationUrlsByIndex);
    }

    const leadingWhitespace = match.match(/^\s*/)?.[0] ?? "";
    const previousChar = offset > 0 ? input[offset - 1] ?? "" : "";
    const spacingPrefix = leadingWhitespace.length > 0
      ? leadingWhitespace
      : offset > 0 && !citationSpacingExemptPrefix.test(previousChar)
        ? " "
        : "";

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
  });
}
