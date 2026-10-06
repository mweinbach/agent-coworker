import { formatLinkDisplayLabel, normalizeInlineLinkHref } from "./inlineMarkdown";

export type SourceLinkItem = {
  label: string;
  href: string;
};

export function displayDomain(siteUrl: string): string {
  const normalized = normalizeInlineLinkHref(siteUrl);
  if (!normalized) {
    return siteUrl;
  }
  try {
    const { hostname } = new URL(normalized);
    return hostname.replace(/^www\./i, "");
  } catch {
    return siteUrl;
  }
}

function isPublicDomainHost(hostname: string): boolean {
  const lower = hostname.trim().toLowerCase();
  if (!lower || lower === "localhost" || lower.endsWith(".local") || lower.endsWith(".internal")) {
    return false;
  }
  if (!lower.includes(".") || /^\d+\.\d+\.\d+\.\d+$/.test(lower) || lower.includes(":")) {
    return false;
  }
  return true;
}

export function faviconUrl(siteUrl: string): string {
  const normalized = normalizeInlineLinkHref(siteUrl);
  if (!normalized) {
    return "";
  }
  try {
    const { hostname } = new URL(normalized);
    if (!isPublicDomainHost(hostname)) {
      return "";
    }
    return `https://www.google.com/s2/favicons?domain=${encodeURIComponent(hostname)}&sz=32`;
  } catch {
    return "";
  }
}

function titleFromUrlSlug(siteUrl: string): string | null {
  const normalized = normalizeInlineLinkHref(siteUrl);
  if (!normalized) {
    return null;
  }
  try {
    const { pathname } = new URL(normalized);
    const segments = pathname.split("/").filter(Boolean);
    if (segments.length === 0) return null;

    let slug = segments[segments.length - 1] ?? "";
    slug = slug.replace(/\.\w{2,5}$/, "");
    slug = decodeURIComponent(slug).replace(/\?.*$/, "");
    if (!/[-_]/.test(slug) || slug.length < 8) return null;

    return slug
      .replace(/[-_]+/g, " ")
      .replace(/\b\w/g, (character) => character.toUpperCase())
      .trim();
  } catch {
    return null;
  }
}

export function displaySourceTitle(item: SourceLinkItem): string {
  const label = item.label.trim();
  const looksLikeRawUrl = /^https?:\/\//i.test(label) || /^www\./i.test(label);
  if (label && !looksLikeRawUrl) {
    return label;
  }
  return titleFromUrlSlug(item.href) ?? formatLinkDisplayLabel(item.label, item.href);
}

export function displaySourceSubtitle(item: SourceLinkItem): string {
  return displayDomain(item.href);
}
