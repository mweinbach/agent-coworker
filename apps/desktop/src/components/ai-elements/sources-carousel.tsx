import { memo, useRef, useState, useCallback } from "react";
import type { CitationSource } from "../../../../../src/shared/displayCitationMarkers";
import { Button } from "../ui/button";
import { cn } from "../../lib/utils";
import { confirmAction } from "../../lib/desktopCommands";

function faviconUrl(siteUrl: string): string {
  try {
    const { hostname } = new URL(siteUrl);
    return `https://www.google.com/s2/favicons?domain=${encodeURIComponent(hostname)}&sz=32`;
  } catch {
    return "";
  }
}

function displayDomain(siteUrl: string): string {
  try {
    const { hostname } = new URL(siteUrl);
    return hostname.replace(/^www\./, "");
  } catch {
    return siteUrl;
  }
}

function titleFromUrlSlug(siteUrl: string): string | null {
  try {
    const { pathname } = new URL(siteUrl);
    // Get the last meaningful path segment
    const segments = pathname.split("/").filter(Boolean);
    if (segments.length === 0) return null;

    let slug = segments[segments.length - 1];
    // Strip common file extensions
    slug = slug.replace(/\.\w{2,5}$/, "");
    // Strip query-like suffixes (e.g., %3Fpage%3D20)
    slug = decodeURIComponent(slug).replace(/\?.*$/, "");
    // Only use slugs that look like article titles (contain separators)
    if (!/[-_]/.test(slug) || slug.length < 8) return null;

    return slug
      .replace(/[-_]+/g, " ")
      .replace(/\b\w/g, (c) => c.toUpperCase())
      .trim();
  } catch {
    return null;
  }
}

function displayTitle(source: CitationSource): string {
  if (source.title) return source.title;
  return titleFromUrlSlug(source.url) ?? displayDomain(source.url);
}

async function openSourceLink(url: string): Promise<void> {
  const confirmed = await confirmAction({
    title: "Open external link?",
    message: "This will open the link in your default browser.",
    detail: url,
    kind: "info",
    confirmLabel: "Open link",
    cancelLabel: "Cancel",
    defaultAction: "cancel",
  });
  if (confirmed) {
    window.open(url, "_blank", "noopener,noreferrer");
  }
}

function FaviconImage({ url, className }: { url: string; className?: string }) {
  const [failed, setFailed] = useState(false);
  const src = faviconUrl(url);

  if (!src || failed) {
    return (
      <div className={cn("flex items-center justify-center rounded bg-muted text-[10px] font-bold uppercase text-muted-foreground", className)}>
        {displayDomain(url).charAt(0)}
      </div>
    );
  }

  return (
    <img
      src={src}
      alt=""
      className={cn("rounded object-contain", className)}
      onError={() => setFailed(true)}
    />
  );
}

function SourceCard({ source }: { source: CitationSource }) {
  const title = displayTitle(source);
  const domain = displayDomain(source.url);

  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      className="h-auto w-44 shrink-0 justify-start gap-2.5 rounded-lg border border-border/70 bg-card px-3 py-2.5 text-left shadow-none transition-colors hover:border-border hover:bg-accent/50"
      onClick={() => void openSourceLink(source.url)}
    >
      <FaviconImage url={source.url} className="size-5 shrink-0" />
      <div className="min-w-0 flex-1">
        <div className="truncate text-xs font-medium text-foreground">{title}</div>
        <div className="truncate text-[10px] text-muted-foreground">{domain}</div>
      </div>
    </Button>
  );
}

export type SourcesCarouselProps = {
  sources: CitationSource[];
  className?: string;
};

export const SourcesCarousel = memo(function SourcesCarousel({ sources, className }: SourcesCarouselProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [canScrollLeft, setCanScrollLeft] = useState(false);
  const [canScrollRight, setCanScrollRight] = useState(false);

  const updateScrollState = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    setCanScrollLeft(el.scrollLeft > 1);
    setCanScrollRight(el.scrollLeft + el.clientWidth < el.scrollWidth - 1);
  }, []);

  const onScroll = useCallback(() => {
    updateScrollState();
  }, [updateScrollState]);

  const scrollBy = useCallback((delta: number) => {
    scrollRef.current?.scrollBy({ left: delta, behavior: "smooth" });
  }, []);

  if (sources.length === 0) return null;

  return (
    <div className={cn("relative group/carousel", className)}>
      <div className="mb-1.5 flex items-center gap-1.5">
        <span className="text-[10px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
          Sources
        </span>
        <span className="text-[10px] text-muted-foreground/60">
          {sources.length}
        </span>
      </div>
      <div className="relative">
        <div
          ref={(el) => {
            (scrollRef as React.MutableRefObject<HTMLDivElement | null>).current = el;
            if (el) {
              requestAnimationFrame(updateScrollState);
            }
          }}
          className="flex gap-2 overflow-x-auto scrollbar-none"
          onScroll={onScroll}
        >
          {sources.map((source) => (
            <SourceCard key={source.url} source={source} />
          ))}
        </div>

        {canScrollLeft && (
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            className="app-shadow-surface absolute -left-2 top-1/2 z-10 h-6 w-6 min-w-6 -translate-y-1/2 rounded-full border border-border bg-card p-0 opacity-0 transition-opacity group-hover/carousel:opacity-100"
            onClick={() => scrollBy(-180)}
          >
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none" className="text-foreground">
              <path d="M7.5 2.5L4 6l3.5 3.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </Button>
        )}
        {canScrollRight && (
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            className="app-shadow-surface absolute -right-2 top-1/2 z-10 h-6 w-6 min-w-6 -translate-y-1/2 rounded-full border border-border bg-card p-0 opacity-0 transition-opacity group-hover/carousel:opacity-100"
            onClick={() => scrollBy(180)}
          >
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none" className="text-foreground">
              <path d="M4.5 2.5L8 6l-3.5 3.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </Button>
        )}
      </div>
    </div>
  );
});
