import { cjk } from "@streamdown/cjk";
import { code } from "@streamdown/code";
import { math } from "@streamdown/math";
import { mermaid } from "@streamdown/mermaid";
import { CheckIcon, ChevronLeftIcon, ChevronRightIcon, CopyIcon } from "lucide-react";
import type { ComponentProps, ReactNode } from "react";
import {
  Children,
  cloneElement,
  createContext,
  isValidElement,
  memo,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import type { Options as RehypeSanitizeOptions } from "rehype-sanitize";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import {
  defaultRehypePlugins,
  defaultRemarkPlugins,
  Streamdown,
  type StreamdownProps,
} from "streamdown";
import type { PluggableList } from "unified";

import {
  type CitationSource,
  describeCitationSource,
  normalizeDisplayCitationMarkers,
} from "../../../../../src/shared/displayCitationMarkers";
import { useAppStore } from "../../app/store";
import { Button } from "../../components/ui/button";
import { confirmAction, openExternalUrl, openPath } from "../../lib/desktopCommands";
import { getFilePreviewKind } from "../../lib/filePreviewKind";
import {
  decodeDesktopMediaUrl,
  encodeDesktopMediaUrl,
  isAbsoluteDesktopPath,
} from "../../lib/mediaProtocol";
import { cn } from "../../lib/utils";

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
    img: [...(defaultSchema.attributes?.img ?? []), "alt", "title"],
    span: [...(defaultSchema.attributes?.span ?? []), "title"],
  },
  protocols: {
    ...defaultSchema.protocols,
    href: [...(defaultSchema.protocols?.href ?? []), "tel", "cowork-file", "cowork-external"],
    src: [...(defaultSchema.protocols?.src ?? []), "cowork-media"],
  },
};
export const defaultDesktopRehypePlugins: PluggableList = [
  defaultRehypePlugins.raw,
  [rehypeSanitize, desktopSanitizeSchema],
  defaultRehypePlugins.harden,
];
const bareDesktopFilePathPatterns = [
  /(?:[A-Za-z]:\\(?:[^\\\r\n<>:"|?*]+\\)*[^\\\r\n<>:"|?*]+\.[A-Za-z0-9]{1,12})(?=$|[\s),\].!?:;"'])/g,
  /(?:\\\\[^\\\r\n<>:"|?*]+\\(?:[^\\\r\n<>:"|?*]+\\)*[^\\\r\n<>:"|?*]+\.[A-Za-z0-9]{1,12})(?=$|[\s),\].!?:;"'])/g,
  /(?:\/(?:Users|home|tmp|var|opt|Applications|Volumes)(?:\/[^/\r\n]+)+\.[A-Za-z0-9]{1,12})(?=$|[\s),\].!?:;"'])/g,
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

      return [
        {
          url: entry.url,
          ...(typeof entry.title === "string" && entry.title.trim().length > 0
            ? { title: entry.title }
            : {}),
          ...(typeof entry.id === "string" && entry.id.trim().length > 0 ? { id: entry.id } : {}),
        },
      ];
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

function CitationFavicon({ source, className }: { source: CitationSource; className?: string }) {
  const display = useMemo(() => describeCitationSource(source), [source]);
  const src = useMemo(() => citationFaviconSrc(source), [source]);
  const [loaded, setLoaded] = useState(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    setLoaded(false);
    setFailed(false);
  }, [src]);

  return (
    <div
      className={cn(
        "relative flex size-5 shrink-0 items-center justify-center overflow-hidden rounded-full bg-muted/80 text-[10px] font-semibold uppercase text-muted-foreground",
        className,
      )}
    >
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

function computeCitationPopupPosition(
  anchorRect: DOMRect,
  cardRect: DOMRect,
): CitationPopupPosition {
  const viewportWidth = window.innerWidth;
  const viewportHeight = window.innerHeight;
  const maxLeft = Math.max(
    CITATION_POPUP_MARGIN,
    viewportWidth - cardRect.width - CITATION_POPUP_MARGIN,
  );
  const preferredLeft = clamp(anchorRect.left, CITATION_POPUP_MARGIN, maxLeft);
  const belowTop = anchorRect.bottom + CITATION_POPUP_GAP;
  const aboveTop = anchorRect.top - cardRect.height - CITATION_POPUP_GAP;
  const maxTop = Math.max(
    CITATION_POPUP_MARGIN,
    viewportHeight - cardRect.height - CITATION_POPUP_MARGIN,
  );
  const top =
    belowTop + cardRect.height <= viewportHeight - CITATION_POPUP_MARGIN
      ? belowTop
      : aboveTop >= CITATION_POPUP_MARGIN
        ? aboveTop
        : clamp(belowTop, CITATION_POPUP_MARGIN, maxTop);

  return { left: preferredLeft, top };
}

function DesktopCitationChip({
  children,
  className,
  "data-citation-sources": encodedSources,
  node,
  title,
  ...props
}: DesktopCitationChipProps) {
  const resolvedEncodedSources =
    encodedSources ??
    citationChipSourcesAttrFromTitle(title) ??
    citationChipSourcesAttrFromNode(node);
  const sources = useMemo(
    () => decodeCitationChipSources(resolvedEncodedSources),
    [resolvedEncodedSources],
  );
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const rootRef = useRef<HTMLElement | null>(null);
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const cardRef = useRef<HTMLDivElement | null>(null);
  const citationTitleContainerRef = useRef<HTMLDivElement | null>(null);
  const citationTitleTextRef = useRef<HTMLParagraphElement | null>(null);
  const hoverCloseTimerRef = useRef<number | null>(null);
  const [popupPosition, setPopupPosition] = useState<CitationPopupPosition | null>(null);

  const cancelScheduledHoverClose = () => {
    if (hoverCloseTimerRef.current !== null) {
      window.clearTimeout(hoverCloseTimerRef.current);
      hoverCloseTimerRef.current = null;
    }
  };

  const handleHoverEnter = () => {
    cancelScheduledHoverClose();
    setOpen(true);
  };

  const handleHoverLeave = () => {
    cancelScheduledHoverClose();
    hoverCloseTimerRef.current = window.setTimeout(() => {
      setOpen(false);
      hoverCloseTimerRef.current = null;
    }, 180);
  };

  useEffect(() => () => cancelScheduledHoverClose(), []);

  const label = useMemo(() => {
    const text = flattenReactText(children).trim();
    return text.length > 0 ? text : "Source";
  }, [children]);
  const currentSource = sources[Math.min(activeIndex, Math.max(0, sources.length - 1))] ?? null;
  const currentSourceDisplay = useMemo(
    () => (currentSource ? describeCitationSource(currentSource) : null),
    [currentSource],
  );

  useEffect(() => {
    if (typeof window === "undefined" || typeof window.Image !== "function") {
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

  useLayoutEffect(() => {
    if (!open) {
      return;
    }
    const container = citationTitleContainerRef.current;
    const textEl = citationTitleTextRef.current;
    if (!container || !textEl) {
      return;
    }

    let animation: Animation | null = null;

    const applyPan = () => {
      animation?.cancel();
      animation = null;
      textEl.style.transform = "";

      const overflow = textEl.scrollWidth - container.clientWidth;
      const reduceMotion =
        typeof window !== "undefined" &&
        typeof window.matchMedia === "function" &&
        window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      if (overflow <= 1 || typeof textEl.animate !== "function" || reduceMotion) {
        return;
      }

      const duration = clamp(Math.round(4500 + overflow * 38), 5500, 15_000);
      animation = textEl.animate(
        [{ transform: "translateX(0)" }, { transform: `translateX(-${overflow}px)` }],
        {
          duration,
          direction: "alternate",
          easing: "ease-in-out",
          iterations: Infinity,
        },
      );
    };

    applyPan();

    let resizeObserver: ResizeObserver | null = null;
    if (typeof ResizeObserver === "function") {
      resizeObserver = new ResizeObserver(() => applyPan());
      resizeObserver.observe(container);
      resizeObserver.observe(textEl);
    }

    return () => {
      resizeObserver?.disconnect();
      animation?.cancel();
      textEl.style.transform = "";
    };
  }, [open, activeIndex, currentSource]);

  useEffect(() => {
    if (!open) {
      return;
    }

    const onPointerDown = (event: MouseEvent) => {
      const target = event.target;
      if (
        target instanceof Node &&
        (rootRef.current?.contains(target) || cardRef.current?.contains(target))
      ) {
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
      setPopupPosition(
        computeCitationPopupPosition(anchor.getBoundingClientRect(), card.getBoundingClientRect()),
      );
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
    <cite
      ref={rootRef}
      className={cn("relative ml-2 inline-flex not-italic", className)}
      onMouseEnter={handleHoverEnter}
      onMouseLeave={handleHoverLeave}
      {...props}
    >
      <Button
        ref={buttonRef}
        type="button"
        variant="outline"
        size="sm"
        className="h-auto min-w-0 rounded-full border-border/70 bg-muted/60 px-2.5 py-0.5 text-[0.72rem] font-medium leading-none text-muted-foreground shadow-none transition-colors hover:border-border hover:bg-muted"
        aria-expanded={open}
        aria-haspopup="dialog"
        onClick={() => {
          cancelScheduledHoverClose();
          setOpen((value) => !value);
        }}
      >
        {label}
      </Button>
      {open && currentSource && currentSourceDisplay && typeof document !== "undefined"
        ? createPortal(
            <div
              ref={cardRef}
              role="dialog"
              aria-label="Citation sources"
              className="app-surface-card app-shadow-surface-elevated fixed z-[70] w-[min(23rem,calc(100vw-2rem))] overflow-hidden rounded-lg border border-border/32 text-card-foreground"
              style={
                popupPosition
                  ? { left: popupPosition.left, top: popupPosition.top }
                  : { left: 0, top: 0, visibility: "hidden" }
              }
              onMouseEnter={handleHoverEnter}
              onMouseLeave={handleHoverLeave}
            >
              <div className="flex items-center gap-0 border-b border-border/32 bg-muted/20 px-1.5 py-0.5">
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  className="h-6 w-6 min-w-6 rounded-full p-0 shadow-none transition-colors hover:bg-accent disabled:cursor-not-allowed disabled:opacity-35"
                  aria-label="Previous source"
                  disabled={sources.length <= 1}
                  onClick={() =>
                    setActiveIndex((index) => (index - 1 + sources.length) % sources.length)
                  }
                >
                  <ChevronLeftIcon data-icon="inline-start" />
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  className="h-6 w-6 min-w-6 rounded-full p-0 shadow-none transition-colors hover:bg-accent disabled:cursor-not-allowed disabled:opacity-35"
                  aria-label="Next source"
                  disabled={sources.length <= 1}
                  onClick={() => setActiveIndex((index) => (index + 1) % sources.length)}
                >
                  <ChevronRightIcon data-icon="inline-start" />
                </Button>
                <div className="ml-auto pr-0.5 text-[11px] font-medium tabular-nums text-muted-foreground">
                  {activeIndex + 1}/{sources.length}
                </div>
              </div>
              <div
                role="button"
                tabIndex={0}
                aria-label={`Open source: ${citationSourceTitle(currentSource)}`}
                className="w-full cursor-pointer text-left outline-none transition-colors hover:bg-muted/[0.06] focus-visible:ring-2 focus-visible:ring-ring"
                onClick={() => {
                  setOpen(false);
                  void openExternalCitationSource(currentSource);
                }}
                onKeyDown={(event) => {
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    setOpen(false);
                    void openExternalCitationSource(currentSource);
                  }
                }}
              >
                <div className="flex items-start gap-2.5 px-3 py-2.5">
                  <CitationFavicon
                    source={currentSource}
                    className="mt-0.5 size-5 shrink-0 text-[10px]"
                  />
                  <div ref={citationTitleContainerRef} className="min-w-0 flex-1 overflow-hidden">
                    <p
                      ref={citationTitleTextRef}
                      className="block overflow-hidden text-[0.92rem] font-semibold leading-snug text-foreground [display:-webkit-box] [-webkit-box-orient:vertical] [-webkit-line-clamp:2]"
                    >
                      {currentSourceDisplay.titleLabel}
                    </p>
                    <p className="mt-1 truncate text-[0.72rem] font-medium leading-snug text-muted-foreground">
                      {currentSourceDisplay.displayUrl ?? currentSourceDisplay.hostLabel}
                    </p>
                  </div>
                </div>
              </div>
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

function desktopPathToFileUrl(rawPath: string): string | null {
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

  return (
    node.type === "element" &&
    (node.tagName === "a" || node.tagName === "code" || node.tagName === "pre")
  );
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

  matches.sort(
    (left, right) => left.start - right.start || right.end - right.start - (left.end - left.start),
  );

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

const URL_SCHEME_RE = /^[a-z][a-z0-9+.-]*:/i;
const RELATIVE_FILENAME_RE = /^[\w.\-+ ()%,&'!@$=~^]+\.[A-Za-z0-9]{1,12}$/;

function resolveAbsoluteDesktopFileHref(rawHref: string): string | null {
  if (!rawHref || rawHref.startsWith("#")) {
    return null;
  }

  const hasNonPathScheme = URL_SCHEME_RE.test(rawHref) && !/^[A-Za-z]:[\\/]/.test(rawHref);
  if (hasNonPathScheme) {
    return null;
  }

  const withoutDecorations = rawHref.replace(/[?#].*$/, "");
  let candidate = withoutDecorations;
  try {
    candidate = decodeURIComponent(withoutDecorations);
  } catch {
    candidate = withoutDecorations;
  }

  const matches = findBareDesktopFilePathMatches(candidate);
  if (matches.length !== 1) {
    return null;
  }

  const [match] = matches;
  if (match?.start !== 0 || match.end !== candidate.length) {
    return null;
  }

  return desktopPathToFileUrl(match.path);
}

/** Resolve a markdown href that looks like a bare filename (no scheme, no slashes) against the active workspace path. */
function resolveRelativeFileHref(rawHref: string, basePath: string | null): string | null {
  if (!basePath) return null;
  if (!rawHref || URL_SCHEME_RE.test(rawHref)) return null;
  if (rawHref.startsWith("/") || rawHref.startsWith("\\") || rawHref.startsWith("#")) {
    return null;
  }
  // Strip a query/fragment so `Foo.docx?x=1` still resolves.
  const cleaned = rawHref.replace(/[?#].*$/, "");
  if (!RELATIVE_FILENAME_RE.test(cleaned)) {
    return null;
  }
  const normalizedBase = basePath.replace(/\\/g, "/").replace(/\/+$/, "");
  if (!normalizedBase) return null;
  return desktopPathToFileUrl(`${normalizedBase}/${cleaned}`);
}

type DesktopImagePathResolution =
  | { kind: "local"; absPath: string }
  /** A workspace-relative local path that escapes the base — must not render. */
  | { kind: "blocked" }
  /** Remote/data/other src that should pass through untouched. */
  | { kind: "passthrough" };

const PASSTHROUGH: DesktopImagePathResolution = { kind: "passthrough" };
const BLOCKED: DesktopImagePathResolution = { kind: "blocked" };

/**
 * Resolve a markdown image src to an absolute desktop path when it points at a
 * local file (absolute path, `file://` URL, or workspace-relative path).
 * Remote/data URLs pass through untouched; workspace-relative paths that
 * escape the base resolve to "blocked" so callers can drop them instead of
 * letting downstream URL resolution rebuild an escaping path.
 */
function resolveDesktopImagePath(
  rawUrl: string,
  basePath: string | null,
): DesktopImagePathResolution {
  const trimmed = rawUrl.trim();
  if (!trimmed || trimmed.startsWith("#")) {
    return PASSTHROUGH;
  }

  if (/^file:/i.test(trimmed)) {
    const fromFileUrl = fileUrlToDesktopPath(trimmed);
    return fromFileUrl ? { kind: "local", absPath: fromFileUrl } : PASSTHROUGH;
  }

  const withoutDecorations = trimmed.replace(/[?#].*$/, "");
  let decoded = withoutDecorations;
  try {
    decoded = decodeURIComponent(withoutDecorations);
  } catch {
    decoded = withoutDecorations;
  }

  if (isAbsoluteDesktopPath(decoded)) {
    return { kind: "local", absPath: decoded };
  }

  // Any other scheme (https, data, cowork-media itself, ...) passes through.
  if (URL_SCHEME_RE.test(trimmed)) {
    return PASSTHROUGH;
  }

  if (!basePath) {
    return PASSTHROUGH;
  }
  const cleaned = decoded.replace(/\\/g, "/").replace(/^\.\//, "");
  if (!cleaned || cleaned.startsWith("/")) {
    return PASSTHROUGH;
  }
  const normalizedBase = basePath.replace(/\\/g, "/").replace(/\/+$/, "");
  if (!normalizedBase) {
    return PASSTHROUGH;
  }
  const joined = joinImagePathWithinBase(normalizedBase, cleaned);
  return joined ? { kind: "local", absPath: joined } : BLOCKED;
}

/**
 * Join a workspace-relative image path onto the base path, normalizing `.`/`..`
 * segments and rejecting anything that would escape the base (e.g.
 * `../outside/secret.png`). The main-process cowork-media handler enforces the
 * real workspace-root boundary; this just avoids constructing escaping URLs in
 * the renderer at all.
 */
function joinImagePathWithinBase(normalizedBase: string, relativePath: string): string | null {
  const segments: string[] = [];
  for (const segment of relativePath.split("/")) {
    if (!segment || segment === ".") {
      continue;
    }
    if (segment === "..") {
      if (segments.length === 0) {
        return null;
      }
      segments.pop();
      continue;
    }
    segments.push(segment);
  }
  if (segments.length === 0) {
    return null;
  }
  return `${normalizedBase}/${segments.join("/")}`;
}

/** Rewrite a local image src to a fetchable `cowork-media:` URL, or null to leave it unchanged. */
export function rewriteDesktopImageUrl(
  rawUrl: string,
  basePath: string | null = null,
): string | null {
  const resolution = resolveDesktopImagePath(rawUrl, basePath);
  if (resolution.kind !== "local") {
    return null;
  }
  return encodeDesktopMediaUrl(resolution.absPath);
}

/**
 * Apply an image src rewrite in the markdown tree: local files route through
 * cowork-media, base-escaping relative paths are dropped entirely (returning
 * `""`), and everything else is left as-is (returning null). Dropping matters:
 * if an escaping relative src survives to Streamdown's URL hardening it gets
 * resolved against the page origin into a root-absolute path, which would then
 * look like a legitimate local image. The main-process cowork-media handler
 * enforces the real workspace-root boundary; this keeps the renderer from
 * constructing escaping URLs in the first place.
 */
function rewriteDesktopImageSrcForTree(rawUrl: string, basePath: string | null): string | null {
  const resolution = resolveDesktopImagePath(rawUrl, basePath);
  if (resolution.kind === "blocked") {
    return "";
  }
  if (resolution.kind !== "local") {
    return null;
  }
  return encodeDesktopMediaUrl(resolution.absPath);
}

export function rewriteDesktopFileLinksInTree(
  node: HastNode,
  basePath: string | null = null,
): void {
  if (node.type === "image" && typeof node.url === "string") {
    // Images route through cowork-media (fetchable by <img>) instead of the
    // cowork-file link scheme used for click-to-open file chips.
    const mediaUrl = rewriteDesktopImageSrcForTree(node.url, basePath);
    if (mediaUrl !== null) {
      node.url = mediaUrl;
    }
  } else if (typeof node.url === "string") {
    const rebased =
      resolveAbsoluteDesktopFileHref(node.url) ?? resolveRelativeFileHref(node.url, basePath);
    if (rebased) {
      node.url = rebased;
    }
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

  if (
    node.type === "element" &&
    node.tagName === "img" &&
    typeof node.properties?.src === "string"
  ) {
    const mediaSrc = rewriteDesktopImageSrcForTree(node.properties.src, basePath);
    if (mediaSrc !== null) {
      node.properties.src = mediaSrc;
    }
  }

  if (
    node.type === "element" &&
    node.tagName === "a" &&
    typeof node.properties?.href === "string"
  ) {
    const href = node.properties.href;
    const rebased = resolveAbsoluteDesktopFileHref(href) ?? resolveRelativeFileHref(href, basePath);
    if (rebased) {
      node.properties.href = rebased;
    }
    const currentHref = node.properties.href as string;
    const desktopPath = fileUrlToDesktopPath(currentHref);
    if (desktopPath) {
      normalizeDesktopFileLinkLabel(node, desktopPath, currentHref);
    }

    const rewrittenHref = encodeDesktopLocalFileHref(currentHref);
    if (rewrittenHref) {
      node.properties.href = rewrittenHref;
    } else {
      const rewrittenExternalHref = encodeDesktopExternalHref(currentHref);
      if (rewrittenExternalHref) {
        node.properties.href = rewrittenExternalHref;
      }
    }
  }

  if (!Array.isArray(node.children)) {
    return;
  }

  for (const child of node.children) {
    rewriteDesktopFileLinksInTree(child, basePath);
  }
}

export function remarkRewriteDesktopFileLinks(opts?: { basePath?: string | null }) {
  const basePath = opts?.basePath ?? null;
  return (tree: HastNode) => {
    rewriteBareDesktopFilePathsInTree(tree);
    rewriteDesktopFileLinksInTree(tree, basePath);
  };
}

function rewriteRawImageSrcInHast(node: HastNode, basePath: string | null): void {
  if (
    node.type === "element" &&
    node.tagName === "img" &&
    typeof node.properties?.src === "string"
  ) {
    const mediaSrc = rewriteDesktopImageSrcForTree(node.properties.src, basePath);
    if (mediaSrc !== null) {
      node.properties.src = mediaSrc;
    }
  }
  if (Array.isArray(node.children)) {
    for (const child of node.children) {
      rewriteRawImageSrcInHast(child, basePath);
    }
  }
}

/**
 * Rehype plugin (runs after rehype-raw, before sanitize/harden) that upgrades
 * raw HTML `<img>` sources the same way markdown images are rewritten at the
 * remark stage. Without it, workspace-relative raw-HTML image srcs are blocked
 * by the harden step before reaching the renderer's img component.
 */
export function rehypeRewriteDesktopImages(opts?: { basePath?: string | null }) {
  const basePath = opts?.basePath ?? null;
  return (tree: HastNode) => {
    rewriteRawImageSrcInHast(tree, basePath);
  };
}

async function openDesktopMessageLink(href: string): Promise<void> {
  const localPath = decodeDesktopLocalFileHref(href);
  if (localPath) {
    const kind = getFilePreviewKind(localPath);
    if (kind !== "unsupported" && kind !== "unknown") {
      useAppStore.getState().openFilePreview({ path: localPath });
      return;
    }
    await openPath({ path: localPath });
    return;
  }

  const forwardedExternalHref = decodeDesktopExternalHref(href) ?? href;
  const externalTarget = classifyExternalMessageHref(forwardedExternalHref);
  if (externalTarget) {
    const confirmed = await confirmAction({
      title:
        externalTarget === "browser"
          ? "Open external link?"
          : externalTarget === "mail"
            ? "Open mail link?"
            : "Open app link?",
      message:
        externalTarget === "browser"
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

export function DesktopMessageLink({
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
      <Button
        type="button"
        variant="link"
        size="sm"
        className={cn(
          "wrap-anywhere appearance-none bg-transparent p-0 text-left font-medium text-primary underline",
          className,
        )}
        data-streamdown="link"
        onClick={(_event) => {
          if (!href) {
            return;
          }
          void openDesktopMessageLink(href);
        }}
      >
        {children}
      </Button>
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

// Raw HTML <img> tags materialize only after rehype-raw, bypassing the remark
// image rewrite, so the img component needs the workspace base path to resolve
// relative sources the same way markdown images are resolved.
const DesktopMarkdownBasePathContext = createContext<string | null>(null);

type DesktopMarkdownImageProps = ComponentProps<"img"> & { node?: unknown };

function imageFallbackLabel(
  alt: string | undefined,
  src: string,
  localPath: string | null,
): string {
  const trimmedAlt = alt?.trim();
  if (trimmedAlt) {
    return trimmedAlt;
  }
  if (localPath) {
    return localPath.split(/[\\/]/).pop() ?? localPath;
  }
  return src;
}

/**
 * Inline chat image: constrained, click-to-preview. Local images (served via
 * cowork-media) open in the in-app file preview; remote images open externally
 * after confirmation. Failed loads degrade to a file-chip style link.
 */
function DesktopMarkdownImage({
  alt,
  className,
  node: _node,
  src,
  title,
  ...props
}: DesktopMarkdownImageProps) {
  // Markdown images are rewritten to cowork-media at the remark stage, but raw
  // HTML <img> tags only materialize after rehype-raw — upgrade those here,
  // resolving workspace-relative sources against the same base path.
  const basePath = useContext(DesktopMarkdownBasePathContext);
  const rawSrc = typeof src === "string" ? src : "";
  const srcString = rawSrc ? (rewriteDesktopImageUrl(rawSrc, basePath) ?? rawSrc) : "";
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    setFailed(false);
  }, [srcString]);

  if (!srcString) {
    return null;
  }

  const localPath = decodeDesktopMediaUrl(srcString);

  const handleOpen = () => {
    if (localPath) {
      useAppStore.getState().openFilePreview({ path: localPath });
      return;
    }
    void openDesktopMessageLink(srcString);
  };

  if (failed) {
    return (
      <Button
        type="button"
        variant="link"
        size="sm"
        className="wrap-anywhere appearance-none bg-transparent p-0 text-left font-medium text-primary underline"
        data-streamdown="image-fallback"
        onClick={handleOpen}
        title={localPath ?? srcString}
      >
        {imageFallbackLabel(alt, srcString, localPath)}
      </Button>
    );
  }

  return (
    <button
      type="button"
      className="my-3 block max-w-full cursor-zoom-in appearance-none border-0 bg-transparent p-0 text-left"
      data-streamdown="image"
      onClick={handleOpen}
      title={title ?? localPath ?? undefined}
    >
      <img
        {...props}
        src={srcString}
        alt={alt ?? ""}
        loading="lazy"
        decoding="async"
        className={cn(
          "max-h-[420px] max-w-full rounded-md border border-border/60 object-contain",
          className,
        )}
        onError={() => setFailed(true)}
      />
    </button>
  );
}

export type DesktopMarkdownProps = StreamdownProps & {
  normalizeDisplayCitations?: boolean;
  citationUrlsByIndex?: ReadonlyMap<number, string>;
  citationSources?: readonly CitationSource[];
  citationAnnotations?: unknown;
  fallbackToSourcesFooter?: boolean;
  /** Absolute workspace path used to resolve bare filename hrefs in markdown links. */
  desktopBasePath?: string | null;
};

/**
 * Tracks whether the app is currently rendering in dark mode by observing the
 * `dark` class that App.tsx toggles on `<html>` when system appearance changes.
 */
function useDocumentIsDark(): boolean {
  const [isDark, setIsDark] = useState(
    () => typeof document !== "undefined" && document.documentElement.classList.contains("dark"),
  );

  useEffect(() => {
    if (typeof document === "undefined" || typeof MutationObserver === "undefined") {
      return;
    }
    const root = document.documentElement;
    const observer = new MutationObserver(() => {
      setIsDark(root.classList.contains("dark"));
    });
    observer.observe(root, { attributes: true, attributeFilter: ["class"] });
    return () => observer.disconnect();
  }, []);

  return isDark;
}

/**
 * Wraps rendered `<pre>` (code) blocks with a hover-revealed Copy button.
 * Additive only: the original `<pre>` element and its children render unchanged,
 * so existing `[&_pre]` styling and Streamdown code-block structure are preserved.
 *
 * Mermaid fences are the exception: Streamdown's diagram renderer only engages
 * when the child `<code>` carries `data-block` (its default `pre` behavior), so
 * those are passed through instead of wrapped.
 */
function PreWithCopy({
  children,
  node: _node,
  ...props
}: ComponentProps<"pre"> & { node?: unknown }) {
  const preRef = useRef<HTMLPreElement | null>(null);
  const [copied, setCopied] = useState(false);

  if (isValidElement<Record<string, unknown>>(children)) {
    const childClassName =
      typeof children.props.className === "string" ? children.props.className : "";
    if (/\blanguage-mermaid\b/.test(childClassName)) {
      return cloneElement(children, { "data-block": "true" });
    }
  }

  const handleCopy = () => {
    const text = preRef.current?.textContent ?? "";
    if (!text) return;
    void Promise.resolve(
      typeof navigator !== "undefined" && navigator.clipboard
        ? navigator.clipboard.writeText(text)
        : Promise.reject(new Error("clipboard unavailable")),
    ).then(
      () => {
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1200);
      },
      () => {
        // Clipboard unavailable (e.g. insecure context) — fail silently.
      },
    );
  };

  return (
    <div className="group relative">
      <pre ref={preRef} {...props}>
        {children}
      </pre>
      <button
        type="button"
        onClick={handleCopy}
        aria-label={copied ? "Copied" : "Copy code"}
        title={copied ? "Copied" : "Copy"}
        className="absolute right-2 top-2 inline-flex size-7 items-center justify-center rounded-md border border-border/50 bg-background/85 text-muted-foreground opacity-0 shadow-sm backdrop-blur-sm transition-opacity hover:bg-background hover:text-foreground focus-visible:opacity-100 group-hover:opacity-100"
      >
        {copied ? (
          <CheckIcon className="size-3.5 text-success" />
        ) : (
          <CopyIcon className="size-3.5" />
        )}
      </button>
    </div>
  );
}

function normalizeDesktopMarkdownChildren(
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
      citationSourcesByIndex: citationSources
        ? new Map(citationSources.map((source, index) => [index + 1, source] as const))
        : undefined,
      citationMode: "html",
      annotations: citationAnnotations,
      fallbackToSourcesFooter,
    });
  }

  return Children.map(children, (child) =>
    typeof child === "string"
      ? normalizeDisplayCitationMarkers(child, {
          citationUrlsByIndex,
          citationSourcesByIndex: citationSources
            ? new Map(citationSources.map((source, index) => [index + 1, source] as const))
            : undefined,
          citationMode: "html",
          annotations: citationAnnotations,
          fallbackToSourcesFooter,
        })
      : child,
  );
}

export const DesktopMarkdown = memo(function DesktopMarkdown({
  className,
  citationUrlsByIndex,
  citationSources,
  citationAnnotations,
  normalizeDisplayCitations = false,
  fallbackToSourcesFooter = true,
  desktopBasePath = null,
  controls,
  mermaid: mermaidOptions,
  ...props
}: DesktopMarkdownProps) {
  const { children, components, plugins, rehypePlugins, remarkPlugins, ...restProps } = props;
  const isDark = useDocumentIsDark();
  const desktopFileLinksPlugin = useMemo<
    [typeof remarkRewriteDesktopFileLinks, { basePath: string | null }]
  >(() => [remarkRewriteDesktopFileLinks, { basePath: desktopBasePath }], [desktopBasePath]);
  // Rewrite raw-HTML <img> srcs after rehype-raw but before sanitize/harden so
  // workspace-relative raw images survive to the renderer's img component.
  const desktopRehypePlugins = useMemo<PluggableList>(
    () =>
      rehypePlugins ?? [
        defaultRehypePlugins.raw,
        [rehypeRewriteDesktopImages, { basePath: desktopBasePath }],
        [rehypeSanitize, desktopSanitizeSchema],
        defaultRehypePlugins.harden,
      ],
    [rehypePlugins, desktopBasePath],
  );
  const resolvedControls = useMemo(
    () =>
      controls === false
        ? false
        : {
            table: false,
            mermaid: { copy: false, download: false, fullscreen: true, panZoom: true },
            ...(typeof controls === "object" ? controls : {}),
          },
    [controls],
  );
  const resolvedMermaid = useMemo<StreamdownProps["mermaid"]>(
    () => ({
      ...mermaidOptions,
      config: {
        theme: isDark ? "dark" : "default",
        ...mermaidOptions?.config,
      },
    }),
    [isDark, mermaidOptions],
  );

  return (
    <DesktopMarkdownBasePathContext.Provider value={desktopBasePath}>
      <Streamdown
        {...restProps}
        controls={resolvedControls}
        mermaid={resolvedMermaid}
        children={normalizeDesktopMarkdownChildren(
          children,
          normalizeDisplayCitations,
          citationUrlsByIndex,
          citationSources,
          citationAnnotations,
          fallbackToSourcesFooter,
        )}
        className={cn(
          "select-text [&>*:first-child]:mt-0 [&>*:last-child]:mb-0 [&_a]:underline [&_ol]:my-3 [&_ol]:list-decimal [&_ol]:pl-5 [&_ul]:my-3 [&_ul]:list-disc [&_ul]:pl-5 [&_li]:my-1.5 [&_li]:pl-1 [&_li::marker]:text-muted-foreground [&_li>p]:my-1 [&_li>p:first-child]:mt-0 [&_li>p:last-child]:mb-0 [&_pre]:overflow-x-auto [&_pre]:rounded-md [&_pre]:border [&_pre]:border-border/80 [&_pre]:bg-muted/45 [&_pre]:p-3 [&_sup]:ml-0.5 [&_sup]:align-super [&_sup]:text-[0.72em] [&_sup]:leading-none [&_sup_a]:font-medium [&_sup_a]:text-primary [&_sup_a]:no-underline hover:[&_sup_a]:underline",
          // GFM tables: fill the bubble, wrap cell text (~3 lines) before horizontal scroll.
          "[&_table]:w-full [&_table]:min-w-0 [&_table]:table-auto [&_table]:text-sm [&_th]:border [&_th]:border-border/60 [&_th]:px-2 [&_th]:py-1 [&_th]:align-top [&_th]:whitespace-normal [&_th]:break-words [&_td]:border [&_td]:border-border/60 [&_td]:px-2 [&_td]:py-1 [&_td]:align-top [&_td]:whitespace-normal [&_td]:break-words",
          // Streamdown wraps GFM tables in a card even with controls disabled — flatten it.
          "[&_[data-streamdown=table-wrapper]]:my-0 [&_[data-streamdown=table-wrapper]]:w-full [&_[data-streamdown=table-wrapper]]:max-w-full [&_[data-streamdown=table-wrapper]]:gap-0 [&_[data-streamdown=table-wrapper]]:rounded-none [&_[data-streamdown=table-wrapper]]:border-0 [&_[data-streamdown=table-wrapper]]:bg-transparent [&_[data-streamdown=table-wrapper]]:p-0",
          "[&_[data-streamdown=table-wrapper]>div]:max-w-full [&_[data-streamdown=table-wrapper]>div]:overflow-x-auto [&_[data-streamdown=table-wrapper]>div]:rounded-none [&_[data-streamdown=table-wrapper]>div]:border-0 [&_[data-streamdown=table-wrapper]>div]:bg-transparent",
          "[&_[data-streamdown=table]]:w-full [&_[data-streamdown=table]]:min-w-0 [&_[data-streamdown=table]]:table-auto [&_[data-streamdown=table]]:border-0",
          "[&_[data-streamdown=table-header-cell]]:min-w-[5rem] [&_[data-streamdown=table-header-cell]]:max-w-[13rem] [&_[data-streamdown=table-header-cell]]:px-2 [&_[data-streamdown=table-header-cell]]:py-1 [&_[data-streamdown=table-header-cell]]:align-top [&_[data-streamdown=table-header-cell]]:whitespace-normal [&_[data-streamdown=table-header-cell]]:break-words [&_[data-streamdown=table-header-cell]]:[overflow-wrap:anywhere]",
          "[&_[data-streamdown=table-cell]]:min-w-[5rem] [&_[data-streamdown=table-cell]]:max-w-[13rem] [&_[data-streamdown=table-cell]]:px-2 [&_[data-streamdown=table-cell]]:py-1 [&_[data-streamdown=table-cell]]:align-top [&_[data-streamdown=table-cell]]:whitespace-normal [&_[data-streamdown=table-cell]]:break-words [&_[data-streamdown=table-cell]]:leading-snug [&_[data-streamdown=table-cell]]:[overflow-wrap:anywhere]",
          className,
        )}
        components={{
          ...components,
          a: DesktopMessageLink,
          cite: DesktopCitationChip,
          img: DesktopMarkdownImage,
          pre: PreWithCopy,
        }}
        plugins={{
          ...streamdownPlugins,
          ...plugins,
        }}
        remarkPlugins={
          remarkPlugins
            ? [...remarkPlugins, desktopFileLinksPlugin]
            : [defaultRemarkPlugins.gfm, desktopFileLinksPlugin]
        }
        rehypePlugins={desktopRehypePlugins}
      />
    </DesktopMarkdownBasePathContext.Provider>
  );
});
