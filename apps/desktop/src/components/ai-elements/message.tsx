import type { ComponentProps, HTMLAttributes, ReactNode } from "react";
import type { Options as RehypeSanitizeOptions } from "rehype-sanitize";
import type { PluggableList } from "unified";

import { Children, memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  defaultRehypePlugins,
  defaultRemarkPlugins,
  Streamdown,
  type StreamdownProps,
} from "streamdown";
import { cjk } from "@streamdown/cjk";
import { code } from "@streamdown/code";
import { math } from "@streamdown/math";
import { mermaid } from "@streamdown/mermaid";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";

import {
  describeCitationSource,
  normalizeDisplayCitationMarkers,
  type CitationSource,
} from "../../../../../src/shared/displayCitationMarkers";
import { confirmAction, openExternalUrl, openPath } from "../../lib/desktopCommands";
import { cn } from "../../lib/utils";

export type MessageProps = HTMLAttributes<HTMLDivElement> & {
  from: "user" | "assistant";
};

export function Message({ className, from, ...props }: MessageProps) {
  return (
    <div
      className={cn(
        "group flex w-full max-w-[95%] flex-col gap-2",
        from === "user" ? "is-user ml-auto" : "is-assistant mr-auto",
        className,
      )}
      {...props}
    />
  );
}

export type MessageContentProps = HTMLAttributes<HTMLDivElement>;

export function MessageContent({ className, ...props }: MessageContentProps) {
  return (
    <div
      className={cn(
        "select-text min-w-0 text-sm leading-6",
        "group-[.is-user]:rounded-xl group-[.is-user]:border group-[.is-user]:border-primary/35 group-[.is-user]:bg-primary group-[.is-user]:text-primary-foreground group-[.is-user]:px-4 group-[.is-user]:py-3",
        "group-[.is-assistant]:text-foreground",
        className,
      )}
      {...props}
    />
  );
}

const streamdownPlugins = { cjk, code, math, mermaid };
const DESKTOP_LOCAL_FILE_PROTOCOL = "cowork-file:";
const DESKTOP_EXTERNAL_URL_PROTOCOL = "cowork-external:";
const CITATION_CHIP_TITLE_PREFIX = "__cowork_citation_sources__:";
const CITATION_POPUP_MARGIN = 16;
const CITATION_POPUP_GAP = 10;
const preloadedCitationFaviconUrls = new Set<string>();
const desktopSanitizeSchema: RehypeSanitizeOptions = {
  ...defaultSchema,
  tagNames: [...(defaultSchema.tagNames ?? []), "cite", "span", "sup"],
  attributes: {
    ...defaultSchema.attributes,
    a: [...(defaultSchema.attributes?.a ?? []), "title"],
    cite: [...(defaultSchema.attributes?.cite ?? []), "data-citation-sources", "title"],
    span: [...(defaultSchema.attributes?.span ?? []), "title"],
  },
  protocols: {
    ...defaultSchema.protocols,
    href: [...(defaultSchema.protocols?.href ?? []), "tel", "cowork-file", "cowork-external"],
  },
};
const defaultDesktopRehypePlugins: PluggableList = [
  defaultRehypePlugins.raw,
  [rehypeSanitize, desktopSanitizeSchema],
  defaultRehypePlugins.harden,
];
const bareDesktopFilePathPatterns = [
  /(?:[A-Za-z]:\\(?:[^\\\r\n<>:"|?*]+\\)*[^\\\r\n<>:"|?*]+\.[A-Za-z0-9]{1,12})(?=$|[\s),\].!?:;"'])/g,
  /(?:\\\\[^\\\r\n<>:"|?*]+\\(?:[^\\\r\n<>:"|?*]+\\)*[^\\\r\n<>:"|?*]+\.[A-Za-z0-9]{1,12})(?=$|[\s),\].!?:;"'])/g,
  /(?:\/(?:Users|home|tmp|var|opt|Applications|Volumes)(?:\/[^\/\r\n]+)+\.[A-Za-z0-9]{1,12})(?=$|[\s),\].!?:;"'])/g,
] as const;
const autoLinkSkippedNodeTypes = new Set(["code", "inlineCode", "html", "link", "linkReference"]);

type HastNode = {
  type?: string;
  tagName?: string;
  url?: string;
  value?: string;
  properties?: Record<string, unknown>;
  children?: HastNode[];
};

type DesktopMessageLinkProps = ComponentProps<"a"> & {
  node?: unknown;
};

type DesktopPathMatch = {
  start: number;
  end: number;
  path: string;
};

type CitationChipSourcePayload = CitationSource & {
  id?: string;
};

type DesktopCitationChipProps = ComponentProps<"cite"> & {
  node?: unknown;
  "data-citation-sources"?: string;
};

type CitationPopupPosition = {
  left: number;
  top: number;
};

const useIsomorphicLayoutEffect = typeof window === "undefined" ? useEffect : useLayoutEffect;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function decodeCitationChipSources(rawValue?: string): CitationChipSourcePayload[] {
  if (typeof rawValue !== "string" || rawValue.trim().length === 0) {
    return [];
  }

  try {
    const parsed = JSON.parse(decodeURIComponent(rawValue));
    if (!Array.isArray(parsed)) {
      return [];
    }

    return parsed.flatMap((entry) => {
      if (!isRecord(entry) || typeof entry.url !== "string" || entry.url.trim().length === 0) {
        return [];
      }

      return [{
        url: entry.url,
        ...(typeof entry.title === "string" && entry.title.trim().length > 0 ? { title: entry.title } : {}),
        ...(typeof entry.id === "string" && entry.id.trim().length > 0 ? { id: entry.id } : {}),
      }];
    });
  } catch {
    return [];
  }
}

function citationChipSourcesAttrFromNode(node: unknown): string | undefined {
  if (!isRecord(node)) {
    return undefined;
  }

  const directValue = node["data-citation-sources"];
  if (typeof directValue === "string" && directValue.trim().length > 0) {
    return directValue;
  }

  const properties = isRecord(node.properties) ? node.properties : null;
  const propertyValue = properties?.["data-citation-sources"];
  if (typeof propertyValue === "string" && propertyValue.trim().length > 0) {
    return propertyValue;
  }

  return undefined;
}

function citationChipSourcesAttrFromTitle(value: unknown): string | undefined {
  if (typeof value !== "string" || !value.startsWith(CITATION_CHIP_TITLE_PREFIX)) {
    return undefined;
  }
  const encodedSources = value.slice(CITATION_CHIP_TITLE_PREFIX.length);
  return encodedSources.trim().length > 0 ? encodedSources : undefined;
}

function flattenReactText(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") {
    return String(node);
  }
  if (Array.isArray(node)) {
    return node.map((entry) => flattenReactText(entry)).join("");
  }
  if (isRecord(node) && "props" in node && isRecord(node.props) && "children" in node.props) {
    return flattenReactText(node.props.children as ReactNode);
  }
  return "";
}

function citationSourceTitle(source: CitationSource): string {
  return describeCitationSource(source).titleLabel;
}

function faviconUrl(hostname: string): string {
  return `https://www.google.com/s2/favicons?domain=${encodeURIComponent(hostname)}&sz=32`;
}

function citationFaviconSrc(source: CitationSource): string {
  const display = describeCitationSource(source);
  return display.faviconHostname ? faviconUrl(display.faviconHostname) : "";
}

function CitationFavicon({ source }: { source: CitationSource }) {
  const display = useMemo(() => describeCitationSource(source), [source]);
  const src = useMemo(() => citationFaviconSrc(source), [source]);
  const [loaded, setLoaded] = useState(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    setLoaded(false);
    setFailed(false);
  }, [src]);

  return (
    <div className="relative flex size-5 shrink-0 items-center justify-center overflow-hidden rounded-full bg-muted/80 text-[10px] font-semibold uppercase text-muted-foreground">
      <span aria-hidden="true">{display.hostLabel.charAt(0)}</span>
      {src && !failed ? (
        <img
          src={src}
          alt=""
          className={cn(
            "absolute inset-0 size-full rounded-full object-contain transition-opacity duration-150",
            loaded ? "opacity-100" : "opacity-0",
          )}
          decoding="async"
          onLoad={() => setLoaded(true)}
          onError={() => setFailed(true)}
        />
      ) : null}
    </div>
  );
}

async function openExternalCitationSource(source: CitationSource): Promise<void> {
  const display = describeCitationSource(source);
  const confirmed = await confirmAction({
    title: "Open external link?",
    message: "This will open the link in your default browser.",
    detail: display.displayUrl ?? display.hostLabel,
    kind: "info",
    confirmLabel: "Open link",
    cancelLabel: "Cancel",
    defaultAction: "cancel",
  });
  if (confirmed) {
    await openExternalUrl({ url: source.url });
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function computeCitationPopupPosition(anchorRect: DOMRect, cardRect: DOMRect): CitationPopupPosition {
  const viewportWidth = window.innerWidth;
  const viewportHeight = window.innerHeight;
  const maxLeft = Math.max(CITATION_POPUP_MARGIN, viewportWidth - cardRect.width - CITATION_POPUP_MARGIN);
  const preferredLeft = clamp(anchorRect.left, CITATION_POPUP_MARGIN, maxLeft);
  const belowTop = anchorRect.bottom + CITATION_POPUP_GAP;
  const aboveTop = anchorRect.top - cardRect.height - CITATION_POPUP_GAP;
  const maxTop = Math.max(CITATION_POPUP_MARGIN, viewportHeight - cardRect.height - CITATION_POPUP_MARGIN);
  const top = belowTop + cardRect.height <= viewportHeight - CITATION_POPUP_MARGIN
    ? belowTop
    : aboveTop >= CITATION_POPUP_MARGIN
      ? aboveTop
      : clamp(belowTop, CITATION_POPUP_MARGIN, maxTop);

  return { left: preferredLeft, top };
}

function CitationArrow({ direction }: { direction: "left" | "right" }) {
  return (
    <svg width="14" height="14" viewBox="0 0 12 12" fill="none" className="text-foreground">
      {direction === "left" ? (
        <path d="M7.5 2.5L4 6l3.5 3.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
      ) : (
        <path d="M4.5 2.5L8 6l-3.5 3.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
      )}
    </svg>
  );
}

function DesktopCitationChip({
  children,
  className,
  "data-citation-sources": encodedSources,
  node,
  title,
  ...props
}: DesktopCitationChipProps) {
  const resolvedEncodedSources = encodedSources
    ?? citationChipSourcesAttrFromTitle(title)
    ?? citationChipSourcesAttrFromNode(node);
  const sources = useMemo(() => decodeCitationChipSources(resolvedEncodedSources), [resolvedEncodedSources]);
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const rootRef = useRef<HTMLElement | null>(null);
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const cardRef = useRef<HTMLDivElement | null>(null);
  const [popupPosition, setPopupPosition] = useState<CitationPopupPosition | null>(null);
  const label = useMemo(() => {
    const text = flattenReactText(children).trim();
    return text.length > 0 ? text : "Source";
  }, [children]);
  const currentSource = sources[Math.min(activeIndex, Math.max(0, sources.length - 1))] ?? null;
  const currentSourceDisplay = useMemo(
    () => currentSource ? describeCitationSource(currentSource) : null,
    [currentSource],
  );

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    for (const source of sources) {
      const src = citationFaviconSrc(source);
      if (!src || preloadedCitationFaviconUrls.has(src)) {
        continue;
      }
      preloadedCitationFaviconUrls.add(src);
      const image = new window.Image();
      image.src = src;
    }
  }, [sources]);

  useEffect(() => {
    if (activeIndex < sources.length) {
      return;
    }
    setActiveIndex(0);
  }, [activeIndex, sources.length]);

  useEffect(() => {
    if (!open) {
      return;
    }

    const onPointerDown = (event: MouseEvent) => {
      const target = event.target;
      if (target instanceof Node && (rootRef.current?.contains(target) || cardRef.current?.contains(target))) {
        return;
      }
      setOpen(false);
    };

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpen(false);
        return;
      }
      if (sources.length <= 1) {
        return;
      }
      if (event.key === "ArrowLeft") {
        event.preventDefault();
        setActiveIndex((index) => (index - 1 + sources.length) % sources.length);
      } else if (event.key === "ArrowRight") {
        event.preventDefault();
        setActiveIndex((index) => (index + 1) % sources.length);
      }
    };

    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open, sources.length]);

  useIsomorphicLayoutEffect(() => {
    if (!open) {
      setPopupPosition(null);
      return;
    }

    if (typeof window === "undefined") {
      return;
    }

    const updatePosition = () => {
      const anchor = buttonRef.current;
      const card = cardRef.current;
      if (!anchor || !card) {
        return;
      }
      setPopupPosition(computeCitationPopupPosition(anchor.getBoundingClientRect(), card.getBoundingClientRect()));
    };

    updatePosition();
    window.addEventListener("resize", updatePosition);
    window.addEventListener("scroll", updatePosition, true);
    return () => {
      window.removeEventListener("resize", updatePosition);
      window.removeEventListener("scroll", updatePosition, true);
    };
  }, [currentSource, open]);

  if (sources.length === 0) {
    return (
      <cite className={cn("ml-2 inline-flex not-italic", className)} {...props}>
        {children}
      </cite>
    );
  }

  return (
    <cite ref={rootRef} className={cn("relative ml-2 inline-flex not-italic", className)} {...props}>
      <button
        ref={buttonRef}
        type="button"
        className="inline-flex items-center rounded-full border border-border/70 bg-muted/60 px-2.5 py-0.5 text-[0.72rem] font-medium leading-none text-muted-foreground transition-colors hover:border-border hover:bg-muted"
        aria-expanded={open}
        aria-haspopup="dialog"
        onClick={() => setOpen((value) => !value)}
      >
        {label}
      </button>
      {open && currentSource && typeof document !== "undefined"
        ? createPortal(
          <div
            ref={cardRef}
            role="dialog"
            aria-label="Citation sources"
            className="fixed z-[70] w-[min(18rem,calc(100vw-2rem))] overflow-hidden rounded-[1.1rem] border border-border/70 bg-card shadow-[0_14px_28px_rgba(0,0,0,0.13)]"
            style={popupPosition ? { left: popupPosition.left, top: popupPosition.top } : { left: 0, top: 0, visibility: "hidden" }}
          >
            <div className="flex items-center gap-0.5 border-b border-border/60 bg-muted/25 px-2.5 py-1.5">
              <button
                type="button"
                className="flex size-7 items-center justify-center rounded-full transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-border/40 disabled:cursor-not-allowed disabled:opacity-35"
                aria-label="Previous source"
                disabled={sources.length <= 1}
                onClick={() => setActiveIndex((index) => (index - 1 + sources.length) % sources.length)}
              >
                <CitationArrow direction="left" />
              </button>
              <button
                type="button"
                className="flex size-7 items-center justify-center rounded-full transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-border/40 disabled:cursor-not-allowed disabled:opacity-35"
                aria-label="Next source"
                disabled={sources.length <= 1}
                onClick={() => setActiveIndex((index) => (index + 1) % sources.length)}
              >
                <CitationArrow direction="right" />
              </button>
              <div className="ml-auto text-xs font-medium text-muted-foreground">
                {activeIndex + 1}/{sources.length}
              </div>
            </div>
            <button
              type="button"
              className="block w-full px-3.5 py-3 text-left transition-colors hover:bg-accent/35"
              onClick={() => {
                setOpen(false);
                void openExternalCitationSource(currentSource);
              }}
            >
              <div className="flex items-center gap-2.5">
                <CitationFavicon source={currentSource} />
                <div className="min-w-0">
                  {currentSourceDisplay && currentSourceDisplay.hostLabel !== citationSourceTitle(currentSource) ? (
                    <div className="truncate text-xs font-medium text-muted-foreground">{currentSourceDisplay.hostLabel}</div>
                  ) : null}
                  <div className="truncate text-[0.98rem] font-semibold leading-5 text-foreground">{citationSourceTitle(currentSource)}</div>
                </div>
              </div>
              {currentSourceDisplay?.displayUrl ? (
                <div className="mt-2 break-all text-xs leading-5 text-muted-foreground">{currentSourceDisplay.displayUrl}</div>
              ) : null}
            </button>
          </div>,
          document.body,
        )
        : null}
    </cite>
  );
}

function classifyExternalMessageHref(rawHref: string): "browser" | "mail" | "app" | null {
  try {
    const parsed = new URL(rawHref);
    switch (parsed.protocol) {
      case "http:":
      case "https:":
        return "browser";
      case "mailto:":
        return "mail";
      case "file:":
      case DESKTOP_LOCAL_FILE_PROTOCOL:
      case DESKTOP_EXTERNAL_URL_PROTOCOL:
      case "about:":
      case "blob:":
      case "data:":
      case "javascript:":
        return null;
      default:
        return "app";
    }
  } catch {
    return null;
  }
}

function isExternalMessageHref(rawHref: string): boolean {
  return classifyExternalMessageHref(rawHref) !== null;
}

function desktopPathBasename(rawPath: string): string {
  const normalized = rawPath.replace(/[\\/]+$/, "").replace(/\\/g, "/");
  const parts = normalized.split("/").filter(Boolean);
  return parts[parts.length - 1] || rawPath;
}

export function fileUrlToDesktopPath(rawHref: string): string | null {
  try {
    const parsed = new URL(rawHref);
    if (parsed.protocol !== "file:") {
      return null;
    }

    const pathname = decodeURIComponent(parsed.pathname);
    if (!pathname) {
      return null;
    }

    if (parsed.hostname && parsed.hostname !== "localhost") {
      return `\\\\${parsed.hostname}${pathname.replace(/\//g, "\\")}`;
    }

    if (/^\/[a-zA-Z]:/.test(pathname)) {
      return pathname.slice(1).replace(/\//g, "\\");
    }

    return pathname;
  } catch {
    return null;
  }
}

export function desktopPathToFileUrl(rawPath: string): string | null {
  const normalized = rawPath.trim();
  if (!normalized) {
    return null;
  }

  if (normalized.startsWith("\\\\")) {
    const parts = normalized.slice(2).split("\\").filter(Boolean);
    const [host, ...rest] = parts;
    if (!host || rest.length === 0) {
      return null;
    }
    return `file://${host}/${rest.map((part) => encodeURIComponent(part)).join("/")}`;
  }

  const slashPath = normalized.replace(/\\/g, "/");
  if (/^[A-Za-z]:\//.test(slashPath)) {
    const [drive, ...rest] = slashPath.split("/");
    return `file:///${drive}/${rest.map((part) => encodeURIComponent(part)).join("/")}`;
  }

  if (!slashPath.startsWith("/")) {
    return null;
  }

  return `file:///${slashPath
    .split("/")
    .filter(Boolean)
    .map((part) => encodeURIComponent(part))
    .join("/")}`;
}

export function encodeDesktopLocalFileHref(rawHref: string): string | null {
  const path = fileUrlToDesktopPath(rawHref);
  if (!path) {
    return null;
  }
  return `${DESKTOP_LOCAL_FILE_PROTOCOL}//open?path=${encodeURIComponent(path)}`;
}

export function encodeDesktopExternalHref(rawHref: string): string | null {
  return classifyExternalMessageHref(rawHref) === "app"
    ? `${DESKTOP_EXTERNAL_URL_PROTOCOL}//open?url=${encodeURIComponent(rawHref)}`
    : null;
}

export function decodeDesktopLocalFileHref(rawHref?: string | null): string | null {
  if (!rawHref) {
    return null;
  }

  try {
    const parsed = new URL(rawHref);
    if (parsed.protocol !== DESKTOP_LOCAL_FILE_PROTOCOL) {
      return null;
    }
    const path = parsed.searchParams.get("path");
    return path ? path : null;
  } catch {
    return null;
  }
}

export function decodeDesktopExternalHref(rawHref?: string | null): string | null {
  if (!rawHref) {
    return null;
  }

  try {
    const parsed = new URL(rawHref);
    if (parsed.protocol !== DESKTOP_EXTERNAL_URL_PROTOCOL) {
      return null;
    }
    const url = parsed.searchParams.get("url");
    return url ? url : null;
  } catch {
    return null;
  }
}

function normalizeDesktopFileLinkLabel(node: HastNode, desktopPath: string, rawHref: string): void {
  if (!Array.isArray(node.children) || node.children.length !== 1) {
    return;
  }

  const [onlyChild] = node.children;
  if (onlyChild?.type !== "text" || typeof onlyChild.value !== "string") {
    return;
  }

  const candidate = onlyChild.value.trim();
  const normalizedDesktopPath = desktopPath.replace(/\\/g, "/");
  if (candidate === desktopPath || candidate === normalizedDesktopPath || candidate === rawHref) {
    onlyChild.value = desktopPathBasename(desktopPath);
  }
}

function isAutoLinkSkippedNode(node: HastNode): boolean {
  if (autoLinkSkippedNodeTypes.has(node.type ?? "")) {
    return true;
  }

  return node.type === "element" && (node.tagName === "a" || node.tagName === "code" || node.tagName === "pre");
}

function findBareDesktopFilePathMatches(text: string): DesktopPathMatch[] {
  const matches: DesktopPathMatch[] = [];

  for (const pattern of bareDesktopFilePathPatterns) {
    for (const match of text.matchAll(pattern)) {
      if (typeof match.index !== "number") {
        continue;
      }

      matches.push({
        start: match.index,
        end: match.index + match[0].length,
        path: match[0],
      });
    }
  }

  matches.sort((left, right) => left.start - right.start || (right.end - right.start) - (left.end - left.start));

  const deduped: DesktopPathMatch[] = [];
  for (const match of matches) {
    const previous = deduped[deduped.length - 1];
    if (previous && match.start < previous.end) {
      continue;
    }
    deduped.push(match);
  }

  return deduped;
}

function buildBareDesktopPathNodes(text: string): HastNode[] | null {
  const matches = findBareDesktopFilePathMatches(text);
  if (matches.length === 0) {
    return null;
  }

  const nodes: HastNode[] = [];
  let cursor = 0;

  for (const match of matches) {
    if (match.start > cursor) {
      nodes.push({ type: "text", value: text.slice(cursor, match.start) });
    }

    const fileUrl = desktopPathToFileUrl(match.path);
    if (fileUrl) {
      nodes.push({
        type: "link",
        url: fileUrl,
        children: [{ type: "text", value: desktopPathBasename(match.path) }],
      });
    } else {
      nodes.push({ type: "text", value: text.slice(match.start, match.end) });
    }

    cursor = match.end;
  }

  if (cursor < text.length) {
    nodes.push({ type: "text", value: text.slice(cursor) });
  }

  return nodes.filter((node) => node.type !== "text" || Boolean(node.value));
}

export function rewriteBareDesktopFilePathsInTree(node: HastNode): void {
  if (isAutoLinkSkippedNode(node) || !Array.isArray(node.children)) {
    return;
  }

  const nextChildren: HastNode[] = [];
  for (const child of node.children) {
    if (child.type === "text" && typeof child.value === "string") {
      const rewrittenNodes = buildBareDesktopPathNodes(child.value);
      if (rewrittenNodes) {
        nextChildren.push(...rewrittenNodes);
        continue;
      }
    }

    // Convert inlineCode nodes that are entirely a file path into a clickable link
    if (child.type === "inlineCode" && typeof child.value === "string") {
      const trimmed = child.value.trim();
      const matches = findBareDesktopFilePathMatches(trimmed);
      if (matches.length === 1 && matches[0].start === 0 && matches[0].end === trimmed.length) {
        const fileUrl = desktopPathToFileUrl(matches[0].path);
        if (fileUrl) {
          nextChildren.push({
            type: "link",
            url: fileUrl,
            children: [{ type: "text", value: desktopPathBasename(matches[0].path) }],
          });
          continue;
        }
      }
    }

    rewriteBareDesktopFilePathsInTree(child);
    nextChildren.push(child);
  }

  node.children = nextChildren;
}

export function rewriteDesktopFileLinksInTree(node: HastNode): void {
  if (typeof node.url === "string") {
    const desktopPath = fileUrlToDesktopPath(node.url);
    if (desktopPath) {
      normalizeDesktopFileLinkLabel(node, desktopPath, node.url);
    }

    const rewrittenUrl = encodeDesktopLocalFileHref(node.url);
    if (rewrittenUrl) {
      node.url = rewrittenUrl;
    } else {
      const rewrittenExternalUrl = encodeDesktopExternalHref(node.url);
      if (rewrittenExternalUrl) {
        node.url = rewrittenExternalUrl;
      }
    }
  }

  if (node.type === "element" && node.tagName === "a" && typeof node.properties?.href === "string") {
    const href = node.properties.href;
    const desktopPath = fileUrlToDesktopPath(href);
    if (desktopPath) {
      normalizeDesktopFileLinkLabel(node, desktopPath, href);
    }

    const rewrittenHref = encodeDesktopLocalFileHref(href);
    if (rewrittenHref) {
      node.properties.href = rewrittenHref;
    } else {
      const rewrittenExternalHref = encodeDesktopExternalHref(href);
      if (rewrittenExternalHref) {
        node.properties.href = rewrittenExternalHref;
      }
    }
  }

  if (!Array.isArray(node.children)) {
    return;
  }

  for (const child of node.children) {
    rewriteDesktopFileLinksInTree(child);
  }
}

export function remarkRewriteDesktopFileLinks() {
  return (tree: HastNode) => {
    rewriteBareDesktopFilePathsInTree(tree);
    rewriteDesktopFileLinksInTree(tree);
  };
}

async function openDesktopMessageLink(href: string): Promise<void> {
  const localPath = decodeDesktopLocalFileHref(href);
  if (localPath) {
    await openPath({ path: localPath });
    return;
  }

  const forwardedExternalHref = decodeDesktopExternalHref(href) ?? href;
  const externalTarget = classifyExternalMessageHref(forwardedExternalHref);
  if (externalTarget) {
    const confirmed = await confirmAction({
      title: externalTarget === "browser"
        ? "Open external link?"
        : externalTarget === "mail"
          ? "Open mail link?"
          : "Open app link?",
      message: externalTarget === "browser"
        ? "This will open the link in your default browser."
        : externalTarget === "mail"
          ? "This will open the link in your default mail app."
          : "This will open the link in another app on this Mac.",
      detail: forwardedExternalHref,
      kind: "info",
      confirmLabel: externalTarget === "browser" ? "Open link" : "Open",
      cancelLabel: "Cancel",
      defaultAction: "cancel",
    });
    if (!confirmed) {
      return;
    }
    await openExternalUrl({ url: forwardedExternalHref });
    return;
  }

  window.open(href, "_blank", "noopener,noreferrer");
}

function DesktopMessageLink({
  children,
  className,
  href,
  node: _node,
  onClick,
  rel: _rel,
  target: _target,
  ...props
}: DesktopMessageLinkProps) {
  const localPath = decodeDesktopLocalFileHref(href);
  const forwardedExternalHref = decodeDesktopExternalHref(href);

  if (localPath || forwardedExternalHref) {
    return (
      <button
        className={cn("wrap-anywhere appearance-none bg-transparent p-0 text-left font-medium text-primary underline", className)}
        data-streamdown="link"
        onClick={(event) => {
          if (!href) {
            return;
          }
          void openDesktopMessageLink(href);
        }}
        type="button"
      >
        {children}
      </button>
    );
  }

  return (
    <a
      className={cn("wrap-anywhere font-medium text-primary underline", className)}
      data-streamdown="link"
      href={href}
      onClick={(event) => {
        onClick?.(event);
        if (event.defaultPrevented || !href || !isExternalMessageHref(href)) {
          return;
        }
        event.preventDefault();
        void openDesktopMessageLink(href);
      }}
      rel="noreferrer"
      target="_blank"
      {...props}
    >
      {children}
    </a>
  );
}

export type MessageResponseProps = StreamdownProps & {
  normalizeDisplayCitations?: boolean;
  citationUrlsByIndex?: ReadonlyMap<number, string>;
  citationSources?: readonly CitationSource[];
  citationAnnotations?: unknown;
  fallbackToSourcesFooter?: boolean;
};

function normalizeMessageResponseChildren(
  children: StreamdownProps["children"],
  normalizeDisplayCitations: boolean,
  citationUrlsByIndex?: ReadonlyMap<number, string>,
  citationSources?: readonly CitationSource[],
  citationAnnotations?: unknown,
  fallbackToSourcesFooter = true,
): StreamdownProps["children"] {
  if (!normalizeDisplayCitations) {
    return children;
  }

  if (typeof children === "string") {
    return normalizeDisplayCitationMarkers(children, {
      citationUrlsByIndex,
      citationSourcesByIndex: citationSources ? new Map(citationSources.map((source, index) => [index + 1, source] as const)) : undefined,
      citationMode: "html",
      annotations: citationAnnotations,
      fallbackToSourcesFooter,
    });
  }

  return Children.map(children, (child) => typeof child === "string"
    ? normalizeDisplayCitationMarkers(child, {
      citationUrlsByIndex,
      citationSourcesByIndex: citationSources ? new Map(citationSources.map((source, index) => [index + 1, source] as const)) : undefined,
      citationMode: "html",
      annotations: citationAnnotations,
      fallbackToSourcesFooter,
    })
    : child);
}

export const MessageResponse = memo(function MessageResponse({
  className,
  citationUrlsByIndex,
  citationSources,
  citationAnnotations,
  normalizeDisplayCitations = false,
  fallbackToSourcesFooter = true,
  ...props
}: MessageResponseProps) {
  const { children, components, plugins, rehypePlugins, remarkPlugins, ...restProps } = props;

  return (
    <Streamdown
      {...restProps}
      children={normalizeMessageResponseChildren(
        children,
        normalizeDisplayCitations,
        citationUrlsByIndex,
        citationSources,
        citationAnnotations,
        fallbackToSourcesFooter,
      )}
      className={cn(
        "[&>*:first-child]:mt-0 [&>*:last-child]:mb-0 [&_a]:underline [&_pre]:overflow-x-auto [&_pre]:rounded-md [&_pre]:border [&_pre]:border-border/80 [&_pre]:bg-muted/45 [&_pre]:p-3 [&_sup]:ml-0.5 [&_sup]:align-super [&_sup]:text-[0.72em] [&_sup]:leading-none [&_sup_a]:font-medium [&_sup_a]:text-primary [&_sup_a]:no-underline hover:[&_sup_a]:underline",
        className,
      )}
      components={{
        ...components,
        a: DesktopMessageLink,
        cite: DesktopCitationChip,
      }}
      plugins={{
        ...streamdownPlugins,
        ...plugins,
      }}
      remarkPlugins={
        remarkPlugins ? [...remarkPlugins, remarkRewriteDesktopFileLinks] : [defaultRemarkPlugins.gfm, remarkRewriteDesktopFileLinks]
      }
      rehypePlugins={rehypePlugins ?? defaultDesktopRehypePlugins}
    />
  );
});
