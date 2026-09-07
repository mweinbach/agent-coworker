import { ChevronLeftIcon, ChevronRightIcon, LinkIcon } from "lucide-react";
import { memo, useCallback, useRef, useState } from "react";
import { AccessibleIconButton, Button } from "../../components/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "../../components/ui/collapsible";
import { cn } from "../../lib/utils";

export type SourceItem = {
  url: string;
  title?: string;
};

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

function displayTitle(source: SourceItem): string {
  if (source.title) return source.title;
  return titleFromUrlSlug(source.url) ?? displayDomain(source.url);
}

function SourceIcon({ url, className }: { url: string; className?: string }) {
  return (
    <div
      aria-hidden="true"
      className={cn(
        "app-type-label flex items-center justify-center rounded bg-muted uppercase text-muted-foreground",
        className,
      )}
    >
      {displayDomain(url).charAt(0)}
    </div>
  );
}

function SourceCard({
  source,
  onOpenSource,
}: {
  source: SourceItem;
  onOpenSource?: (url: string) => void;
}) {
  const title = displayTitle(source);
  const domain = displayDomain(source.url);

  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      className="h-auto w-44 shrink-0 justify-start gap-2.5 rounded-lg border app-border-subtle bg-card px-3 py-2.5 text-left shadow-none transition-colors hover:app-border-default hover:bg-accent/50"
      onClick={() => onOpenSource?.(source.url)}
    >
      <SourceIcon url={source.url} className="size-5 shrink-0" />
      <div className="min-w-0 flex-1">
        <div className="truncate text-xs font-medium text-foreground">{title}</div>
        <div className="app-type-caption truncate text-muted-foreground">{domain}</div>
      </div>
    </Button>
  );
}

function SourcesCarouselBody({
  sources,
  onOpenSource,
}: {
  sources: SourceItem[];
  onOpenSource?: (url: string) => void;
}) {
  const scrollRef: { current: HTMLDivElement | null } = useRef(null);
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

  return (
    <div className="relative group/carousel pt-1.5">
      <div
        ref={(el) => {
          scrollRef.current = el;
          if (el) {
            requestAnimationFrame(updateScrollState);
          }
        }}
        className="flex gap-2 overflow-x-auto scrollbar-none"
        onScroll={onScroll}
      >
        {sources.map((source) => (
          <SourceCard key={source.url} source={source} onOpenSource={onOpenSource} />
        ))}
      </div>

      {canScrollLeft ? (
        <AccessibleIconButton
          type="button"
          variant="ghost"
          size="icon-sm"
          label="Previous sources"
          className="app-shadow-surface absolute -left-2 top-1/2 z-10 h-6 w-6 min-w-6 -translate-y-1/2 rounded-full border border-border bg-card p-0 opacity-0 transition-opacity group-hover/carousel:opacity-100 group-focus-within/carousel:opacity-100"
          onClick={() => scrollBy(-180)}
        >
          <ChevronLeftIcon className="size-3 text-foreground" aria-hidden />
        </AccessibleIconButton>
      ) : null}
      {canScrollRight ? (
        <AccessibleIconButton
          type="button"
          variant="ghost"
          size="icon-sm"
          label="Next sources"
          className="app-shadow-surface absolute -right-2 top-1/2 z-10 h-6 w-6 min-w-6 -translate-y-1/2 rounded-full border border-border bg-card p-0 opacity-0 transition-opacity group-hover/carousel:opacity-100 group-focus-within/carousel:opacity-100"
          onClick={() => scrollBy(180)}
        >
          <ChevronRightIcon className="size-3 text-foreground" aria-hidden />
        </AccessibleIconButton>
      ) : null}
    </div>
  );
}

export type CitationSourcesCarouselProps = {
  sources: SourceItem[];
  /** Invoked with the source URL when a card is activated. The caller owns the open flow. */
  onOpenSource?: (url: string) => void;
  className?: string;
  /** Start expanded. Defaults to collapsed so sources don't fill the transcript. */
  defaultOpen?: boolean;
};

export const CitationSourcesCarousel = memo(function CitationSourcesCarousel({
  sources,
  onOpenSource,
  className,
  defaultOpen = false,
}: CitationSourcesCarouselProps) {
  const [open, setOpen] = useState(defaultOpen);

  if (sources.length === 0) return null;

  const countLabel = sources.length === 1 ? "1 source" : `${sources.length} sources`;

  return (
    <Collapsible
      open={open}
      onOpenChange={setOpen}
      className={cn("max-w-full", className)}
      data-slot="citation-sources"
    >
      <CollapsibleTrigger asChild>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-7 gap-1.5 rounded-full app-border-subtle bg-background/60 px-2.5 text-xs font-medium app-text-muted shadow-none hover:bg-accent/50 hover:text-foreground"
          aria-label={open ? `Hide ${countLabel}` : `Show ${countLabel}`}
          data-slot="citation-sources-trigger"
        >
          <LinkIcon className="size-3.5 shrink-0" aria-hidden />
          <span>Sources</span>
          <span className="tabular-nums app-text-muted">{sources.length}</span>
          <ChevronRightIcon
            className={cn(
              "size-3.5 shrink-0 transition-transform duration-150",
              open && "rotate-90",
            )}
            aria-hidden
          />
        </Button>
      </CollapsibleTrigger>
      <CollapsibleContent className="activity-trace-content overflow-hidden">
        <SourcesCarouselBody sources={sources} onOpenSource={onOpenSource} />
      </CollapsibleContent>
    </Collapsible>
  );
});
