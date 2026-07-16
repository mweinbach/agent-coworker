const providerCitationReferencePattern = /(turn\d+[a-z]+\d+)/gi;

export type CitationSource = {
  url: string;
  title?: string;
  /** Provider-local reference used by inline markers such as turn0search7. */
  referenceId?: string;
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

  for (const key of ["output", "result", "content", "contentItems"] as const) {
    if (!(key in value)) continue;
    const text = extractToolResultText(value[key]);
    if (text) return text;
  }

  return null;
}

function normalizeHttpCitationUrl(value: string): string | null {
  const url = value.trim().replace(/[),.;:]+$/, "");
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? url : null;
  } catch {
    return null;
  }
}

function citationSourceFromProviderLine(line: string): CitationSource | null {
  const parenthesizedUrl = line.match(/\((https?:\/\/[^)\s]+)\)/i);
  const bareUrl = parenthesizedUrl ?? line.match(/https?:\/\/[^\s<]+/i);
  const rawUrl = bareUrl?.[1] ?? bareUrl?.[0];
  if (!rawUrl) {
    return null;
  }

  const url = normalizeHttpCitationUrl(rawUrl);
  if (!url) {
    return null;
  }

  const urlOffset = bareUrl?.index ?? line.indexOf(rawUrl);
  const titlePrefix = line
    .slice(0, Math.max(0, urlOffset))
    .trim()
    .replace(/\($/, "")
    .trim()
    .replace(/[-–—:|]+$/, "")
    .trim();
  const markdownTitle = titlePrefix.match(/\[([^\]]+)\]$/)?.[1]?.trim();
  const title = markdownTitle || titlePrefix;

  return title ? { url, title } : { url };
}

function extractStructuredReferencedCitationSources(value: unknown): CitationSource[] {
  if (!isRecord(value)) {
    return [];
  }

  if (Array.isArray(value.citationSources)) {
    return value.citationSources.flatMap((entry) => {
      if (!isRecord(entry)) return [];
      const url = typeof entry.url === "string" ? normalizeHttpCitationUrl(entry.url) : null;
      const referenceId = typeof entry.referenceId === "string" ? entry.referenceId.trim() : "";
      if (!url || !/^turn\d+[a-z]+\d+$/i.test(referenceId)) {
        return [];
      }
      const title = typeof entry.title === "string" ? entry.title.trim() : "";
      return [{ url, referenceId, ...(title ? { title } : {}) }];
    });
  }

  for (const key of ["output", "result", "content", "contentItems"] as const) {
    if (!(key in value)) continue;
    const sources = extractStructuredReferencedCitationSources(value[key]);
    if (sources.length > 0) {
      return sources;
    }
  }
  return [];
}

export function extractReferencedCitationSourcesFromToolResult(result: unknown): CitationSource[] {
  const structuredSources = extractStructuredReferencedCitationSources(result);
  if (structuredSources.length > 0) {
    return structuredSources;
  }

  const text = extractToolResultText(result);
  if (!text?.includes("cite")) {
    return [];
  }

  const sourcesByReference = new Map<string, CitationSource>();
  let nearestSource: CitationSource | null = null;

  for (const line of text.split(/\r?\n/)) {
    nearestSource = citationSourceFromProviderLine(line) ?? nearestSource;
    if (!nearestSource) {
      continue;
    }

    for (const match of line.matchAll(providerCitationReferencePattern)) {
      const referenceId = match[1];
      if (!referenceId || sourcesByReference.has(referenceId)) {
        continue;
      }
      sourcesByReference.set(referenceId, { ...nearestSource, referenceId });
    }
  }

  return [...sourcesByReference.values()];
}
