const citationClusterPattern = /(?:[ \t]*[【\[]\d+(?::\d+)?†[^\]】]+[】\]])+/g;
const citationMarkerPattern = /[【\[](\d+)(?::\d+)?†[^\]】]+[】\]]/g;
const citationSpacingExemptPrefix = /[\s([{'"“‘-]/;

type CitationDisplayOptions = {
  citationUrlsByIndex?: ReadonlyMap<number, string>;
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
    const currentIds = idsByEndIndex.get(annotation.endIndex) ?? [];
    const nextId = String(citationIndex);
    if (!currentIds.includes(nextId)) {
      currentIds.push(nextId);
      idsByEndIndex.set(annotation.endIndex, currentIds);
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
    const previousChar = endIndex > 0 ? text[endIndex - 1] ?? "" : "";
    out += renderCitationIds(idsByEndIndex.get(rawEndIndex) ?? [], {
      ...options,
      citationUrlsByIndex,
    }, previousChar);
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
