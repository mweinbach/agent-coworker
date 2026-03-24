import { isIP } from "node:net";

import type { SessionFeedItem, SessionSnapshot } from "../shared/sessionSnapshot";
import { resolveSafeWebUrl, type SafeWebResolution } from "../utils/webSafety";

export type CitationReference = {
  url: string;
  title?: string;
};

type ResolvedCitationReference = {
  url: string;
  title?: string;
};

const opaqueCitationRedirectHosts = new Set([
  "vertexaisearch.cloud.google.com",
]);
const citationResolutionTimeoutMs = 4_000;
const citationResolutionMaxBytes = 96 * 1024;
const citationResolutionMaxRedirects = 5;
const DEFAULT_MAX_SETTLED_CITATION_CACHE_ENTRIES = 512;
const DEFAULT_MAX_INFLIGHT_CITATION_RESOLUTIONS = 128;
let maxSettledCitationCacheEntries = DEFAULT_MAX_SETTLED_CITATION_CACHE_ENTRIES;
let maxInflightCitationResolutionEntries = DEFAULT_MAX_INFLIGHT_CITATION_RESOLUTIONS;
const citationResolutionCache = new Map<string, Promise<ResolvedCitationReference | null>>();
const settledCitationResolutionCache = new Map<string, ResolvedCitationReference | null>();

function evictOldestInflightCitationResolutions(): void {
  while (citationResolutionCache.size > maxInflightCitationResolutionEntries) {
    const first = citationResolutionCache.keys().next().value;
    if (first === undefined) break;
    citationResolutionCache.delete(first);
  }
}

function evictOldestSettledCitationEntries(): void {
  while (settledCitationResolutionCache.size > maxSettledCitationCacheEntries) {
    const first = settledCitationResolutionCache.keys().next().value;
    if (first === undefined) break;
    settledCitationResolutionCache.delete(first);
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function asRecordArray(value: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => asRecord(entry))
    .filter((entry): entry is Record<string, unknown> => entry !== null);
}

function asNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function normalizeHostnameLikeLabel(value: string | undefined): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim().replace(/^https?:\/\//i, "").replace(/^www\./i, "");
  if (!trimmed || /[/?#\s]/.test(trimmed)) {
    return null;
  }

  return /^(?:[a-z0-9-]+\.)+[a-z]{2,}$/i.test(trimmed) ? trimmed.toLowerCase() : null;
}

function isOpaqueCitationRedirectUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return opaqueCitationRedirectHosts.has(parsed.hostname) && parsed.pathname.startsWith("/grounding-api-redirect/");
  } catch {
    return false;
  }
}

function resolveCitationFinalUrl(currentUrl: string, responseUrl: string | undefined): string {
  const candidate = asNonEmptyString(responseUrl);
  if (!candidate) {
    return currentUrl;
  }

  try {
    const parsed = new URL(candidate);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return currentUrl;
    }
    if (parsed.username || parsed.password) {
      return currentUrl;
    }
    if (isIP(parsed.hostname) !== 0) {
      return currentUrl;
    }
    if (isOpaqueCitationRedirectUrl(candidate)) {
      return currentUrl;
    }
    return parsed.toString();
  } catch {
    return currentUrl;
  }
}

function needsCitationResolution(reference: CitationReference): boolean {
  return isOpaqueCitationRedirectUrl(reference.url) || !reference.title || normalizeHostnameLikeLabel(reference.title) !== null;
}

function decodeHtmlEntities(value: string): string {
  return value.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (match, entity: string) => {
    const lowered = entity.toLowerCase();
    switch (lowered) {
      case "amp":
        return "&";
      case "lt":
        return "<";
      case "gt":
        return ">";
      case "quot":
        return "\"";
      case "apos":
        return "'";
      case "nbsp":
        return " ";
      default:
        break;
    }

    if (lowered.startsWith("#x")) {
      const codePoint = Number.parseInt(lowered.slice(2), 16);
      return Number.isFinite(codePoint) ? String.fromCodePoint(codePoint) : match;
    }
    if (lowered.startsWith("#")) {
      const codePoint = Number.parseInt(lowered.slice(1), 10);
      return Number.isFinite(codePoint) ? String.fromCodePoint(codePoint) : match;
    }
    return match;
  });
}

function normalizeResolvedTitle(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const normalized = decodeHtmlEntities(value).replace(/\s+/g, " ").trim();
  return normalized.length > 0 ? normalized : undefined;
}

function extractAttribute(tag: string, name: string): string | undefined {
  const match = tag.match(new RegExp(`${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i"));
  return normalizeResolvedTitle(match?.[1] ?? match?.[2] ?? match?.[3]);
}

function extractMetaTitle(html: string): string | undefined {
  const metaTags = html.match(/<meta\b[^>]*>/gi) ?? [];
  for (const tag of metaTags) {
    const property = extractAttribute(tag, "property")?.toLowerCase();
    const name = extractAttribute(tag, "name")?.toLowerCase();
    const content = extractAttribute(tag, "content");
    if (!content) continue;
    if (property === "og:title" || property === "twitter:title" || name === "twitter:title") {
      return content;
    }
  }
  return undefined;
}

function extractDocumentTitle(html: string): string | undefined {
  const metaTitle = extractMetaTitle(html);
  if (metaTitle) return metaTitle;

  const match = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return normalizeResolvedTitle(match?.[1]);
}

function createTimeoutController(timeoutMs: number): { controller: AbortController; dispose: () => void } {
  const controller = new AbortController();
  const handle = setTimeout(() => controller.abort(), timeoutMs);
  return {
    controller,
    dispose: () => clearTimeout(handle),
  };
}

function isRedirectStatus(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

function buildPinnedCitationUrl(resolved: SafeWebResolution): { pinnedUrl: URL; hostHeader: string } {
  const address = resolved.addresses[0];
  if (!address) {
    throw new Error(`Blocked unresolved host: ${resolved.url.hostname}`);
  }

  const pinnedUrl = new URL(resolved.url.toString());
  const hostHeader = pinnedUrl.host;
  pinnedUrl.hostname = address.family === 6 ? `[${address.address}]` : address.address;
  return { pinnedUrl, hostHeader };
}

async function fetchCitationWithSafeRedirects(
  url: string,
  signal: AbortSignal
): Promise<{ response: Response; finalUrl: string }> {
  let current = await resolveSafeWebUrl(url);

  for (let hop = 0; hop < citationResolutionMaxRedirects; hop++) {
    const { pinnedUrl, hostHeader } = buildPinnedCitationUrl(current);
    const response = await globalThis.fetch(pinnedUrl, {
      redirect: "manual",
      signal,
      headers: {
        Accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.1",
        Host: hostHeader,
        "User-Agent": "Mozilla/5.0 (compatible; Cowork/1.0)",
      },
    });

    if (!isRedirectStatus(response.status)) {
      return {
        response,
        finalUrl: resolveCitationFinalUrl(current.url.toString(), response.url),
      };
    }

    const location = response.headers.get("location");
    if (!location) {
      throw new Error(`Redirect missing location header: ${current.url.toString()}`);
    }

    current = await resolveSafeWebUrl(new URL(location, current.url).toString());
  }

  throw new Error(`Too many redirects while resolving citation: ${url}`);
}

async function readResponsePrefix(response: Response, maxBytes: number): Promise<string> {
  const body = response.body;
  if (!body || typeof body.getReader !== "function") {
    const text = await response.text();
    return text.slice(0, maxBytes);
  }

  const reader = body.getReader();
  const decoder = new TextDecoder();
  let remaining = maxBytes;
  let out = "";

  try {
    while (remaining > 0) {
      const { done, value } = await reader.read();
      if (done || !value) break;
      const chunk = value.byteLength > remaining ? value.subarray(0, remaining) : value;
      out += decoder.decode(chunk, { stream: true });
      remaining -= chunk.byteLength;
      if (chunk.byteLength < value.byteLength) {
        break;
      }
    }
    out += decoder.decode();
  } finally {
    try {
      await reader.cancel();
    } catch {
      // Best-effort early abort once the title region has been read.
    }
  }

  return out;
}

async function resolveCitationReference(url: string): Promise<ResolvedCitationReference | null> {
  if (typeof globalThis.fetch !== "function") {
    return null;
  }

  const { controller, dispose } = createTimeoutController(citationResolutionTimeoutMs);
  try {
    const { response, finalUrl } = await fetchCitationWithSafeRedirects(url, controller.signal);
    const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
    if (!contentType.includes("text/html") && !contentType.includes("application/xhtml+xml")) {
      return { url: finalUrl };
    }

    const html = await readResponsePrefix(response, citationResolutionMaxBytes);
    const title = extractDocumentTitle(html);
    return title ? { url: finalUrl, title } : { url: finalUrl };
  } catch {
    return null;
  } finally {
    dispose();
  }
}

function getCachedResolvedCitationReference(url: string): ResolvedCitationReference | null | undefined {
  if (!settledCitationResolutionCache.has(url)) {
    return undefined;
  }
  return settledCitationResolutionCache.get(url) ?? null;
}

async function getResolvedCitationReference(url: string): Promise<ResolvedCitationReference | null> {
  const cached = getCachedResolvedCitationReference(url);
  if (cached !== undefined) {
    return cached;
  }

  const existing = citationResolutionCache.get(url);
  if (existing) {
    return await existing;
  }

  const pending = resolveCitationReference(url).then((resolved) => {
    settledCitationResolutionCache.set(url, resolved);
    evictOldestSettledCitationEntries();
    citationResolutionCache.delete(url);
    return resolved;
  });
  evictOldestInflightCitationResolutions();
  citationResolutionCache.set(url, pending);
  try {
    return await pending;
  } catch {
    citationResolutionCache.delete(url);
    settledCitationResolutionCache.delete(url);
    return null;
  }
}

function primeCitationReference(url: string): void {
  void getResolvedCitationReference(url).catch(() => {
    // Best-effort background cache warm.
  });
}

export async function enrichCitationReferences<T extends CitationReference>(references: readonly T[]): Promise<T[]> {
  if (references.length === 0) {
    return [];
  }

  return await Promise.all(references.map(async (reference) => {
    if (!needsCitationResolution(reference)) {
      return reference;
    }

    const resolved = await getResolvedCitationReference(reference.url);
    if (!resolved) {
      return reference;
    }

    const nextTitle = resolved.title ?? reference.title;
    const nextUrl = resolved.url || reference.url;
    if (nextUrl === reference.url && nextTitle === reference.title) {
      return reference;
    }

    return {
      ...reference,
      url: nextUrl,
      ...(nextTitle ? { title: nextTitle } : {}),
    };
  }));
}

export function enrichCitationAnnotationsFromCache(
  annotations: unknown,
): Array<Record<string, unknown>> | undefined {
  const entries = asRecordArray(annotations);
  if (entries.length === 0) {
    return undefined;
  }

  let changed = false;
  const nextEntries = entries.map((entry) => {
    const url = asNonEmptyString(entry.url);
    if (!url) {
      return entry;
    }
    if (entry.type !== "url_citation" && entry.type !== "place_citation") {
      return entry;
    }

    const title = asNonEmptyString(entry.title);
    if (!needsCitationResolution({ url, title })) {
      return entry;
    }

    const resolved = getCachedResolvedCitationReference(url);
    if (resolved === undefined || !resolved) {
      return entry;
    }

    const nextTitle = resolved.title ?? title;
    const nextUrl = resolved.url || url;
    if (nextUrl === url && nextTitle === title) {
      return entry;
    }

    changed = true;
    return {
      ...entry,
      url: nextUrl,
      ...(nextTitle ? { title: nextTitle } : {}),
    };
  });

  return changed ? nextEntries : entries;
}

export async function enrichCitationAnnotations(
  annotations: unknown,
): Promise<Array<Record<string, unknown>> | undefined> {
  const entries = asRecordArray(annotations);
  if (entries.length === 0) {
    return undefined;
  }

  let changed = false;
  const nextEntries = await Promise.all(entries.map(async (entry) => {
    const url = asNonEmptyString(entry.url);
    if (!url) {
      return entry;
    }
    if (entry.type !== "url_citation" && entry.type !== "place_citation") {
      return entry;
    }

    const title = asNonEmptyString(entry.title);
    if (!needsCitationResolution({ url, title })) {
      return entry;
    }

    const [resolved] = await enrichCitationReferences([{ url, ...(title ? { title } : {}) }]);
    if (!resolved || (resolved.url === url && resolved.title === title)) {
      return entry;
    }

    changed = true;
    return {
      ...entry,
      url: resolved.url,
      ...(resolved.title ? { title: resolved.title } : {}),
    };
  }));

  return changed ? nextEntries : entries;
}

function annotationsEqual(
  left: Array<Record<string, unknown>> | undefined,
  right: Array<Record<string, unknown>> | undefined,
): boolean {
  if (left === right) return true;
  if (!left || !right) return !left && !right;
  if (left.length !== right.length) return false;
  return left.every((entry, index) => JSON.stringify(entry) === JSON.stringify(right[index]));
}

export function primeSessionSnapshotCitationCache(snapshot: SessionSnapshot): void {
  for (const item of snapshot.feed) {
    if (item.kind !== "message" || item.role !== "assistant" || !Array.isArray(item.annotations) || item.annotations.length === 0) {
      continue;
    }

    for (const entry of asRecordArray(item.annotations)) {
      const url = asNonEmptyString(entry.url);
      if (!url) {
        continue;
      }
      if (entry.type !== "url_citation" && entry.type !== "place_citation") {
        continue;
      }

      const title = asNonEmptyString(entry.title);
      if (!needsCitationResolution({ url, title })) {
        continue;
      }

      primeCitationReference(url);
    }
  }
}

export function enrichSessionSnapshotCitationsFromCache(snapshot: SessionSnapshot): SessionSnapshot {
  let changed = false;
  const feed = snapshot.feed.map((item) => {
    if (item.kind !== "message" || item.role !== "assistant" || !Array.isArray(item.annotations) || item.annotations.length === 0) {
      return item;
    }

    const nextAnnotations = enrichCitationAnnotationsFromCache(item.annotations);
    if (annotationsEqual(item.annotations, nextAnnotations)) {
      return item;
    }

    changed = true;
    return {
      ...item,
      ...(nextAnnotations ? { annotations: nextAnnotations } : {}),
    };
  });

  return changed
    ? {
        ...snapshot,
        feed,
      }
    : snapshot;
}

export async function enrichSessionSnapshotCitations(snapshot: SessionSnapshot): Promise<SessionSnapshot> {
  let changed = false;
  const feed = await Promise.all(snapshot.feed.map(async (item) => {
    if (item.kind !== "message" || item.role !== "assistant" || !Array.isArray(item.annotations) || item.annotations.length === 0) {
      return item;
    }

    const nextAnnotations = await enrichCitationAnnotations(item.annotations);
    if (annotationsEqual(item.annotations, nextAnnotations)) {
      return item;
    }

    changed = true;
    return {
      ...item,
      ...(nextAnnotations ? { annotations: nextAnnotations } : {}),
    };
  }));

  return changed
    ? {
        ...snapshot,
        feed,
      }
    : snapshot;
}

export const __internal = {
  clearCitationResolutionCache: () => {
    citationResolutionCache.clear();
    settledCitationResolutionCache.clear();
  },
  extractDocumentTitle,
  fetchCitationWithSafeRedirects,
  isOpaqueCitationRedirectUrl,
  needsCitationResolution,
  normalizeHostnameLikeLabel,
  __testSetCitationCacheLimits: (limits: { maxSettled?: number; maxInflight?: number }) => {
    if (typeof limits.maxSettled === "number" && Number.isFinite(limits.maxSettled) && limits.maxSettled > 0) {
      maxSettledCitationCacheEntries = Math.floor(limits.maxSettled);
    }
    if (typeof limits.maxInflight === "number" && Number.isFinite(limits.maxInflight) && limits.maxInflight > 0) {
      maxInflightCitationResolutionEntries = Math.floor(limits.maxInflight);
    }
  },
  __testResetCitationCacheLimits: () => {
    maxSettledCitationCacheEntries = DEFAULT_MAX_SETTLED_CITATION_CACHE_ENTRIES;
    maxInflightCitationResolutionEntries = DEFAULT_MAX_INFLIGHT_CITATION_RESOLUTIONS;
  },
  __testGetSettledCacheSize: () => settledCitationResolutionCache.size,
  __testGetInflightCacheSize: () => citationResolutionCache.size,
};
