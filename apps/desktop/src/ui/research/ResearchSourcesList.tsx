import { ExternalLinkIcon } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import type { ResearchDetail } from "../../app/types";
import { Button } from "../../components/ui/button";
import { describeCitationSource } from "../../../../../src/shared/displayCitationMarkers";
import { openExternalUrl } from "../../lib/desktopCommands";
import { cn } from "../../lib/utils";

type SourceRow = ResearchDetail["sources"][number];

export function ResearchSourcesList({
  sources,
  variant = "card",
}: {
  sources: ResearchDetail["sources"];
  variant?: "card" | "inline";
}) {
  if (sources.length === 0) {
    return null;
  }

  if (variant === "inline") {
    return (
      <ul className="space-y-0.5">
        {sources.map((source, index) => (
          <li key={`${source.sourceType}:${source.url}:${index}`}>
            <SourceRow source={source} />
          </li>
        ))}
      </ul>
    );
  }

  return (
    <div className="rounded-2xl border border-border/65 bg-card/70 px-4 py-4">
      <div className="mb-3">
        <div className="text-sm font-semibold text-foreground">Sources</div>
        <div className="text-xs text-muted-foreground">URLs captured from Google Search, URL Context, and file citations.</div>
      </div>
      <div className="space-y-2">
        {sources.map((source, index) => (
          <div
            key={`${source.sourceType}:${source.url}:${index}`}
            className="flex items-center justify-between gap-2 rounded-xl border border-border/60 bg-muted/10 px-3 py-2.5"
          >
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm font-medium text-foreground">{source.title ?? source.url}</div>
              <div className="truncate text-xs text-muted-foreground">{source.url}</div>
            </div>
            <Button
              size="icon-sm"
              variant="ghost"
              type="button"
              className="shrink-0 rounded-full"
              aria-label={`Open ${source.url}`}
              onClick={() => void openExternalUrl({ url: source.url })}
            >
              <ExternalLinkIcon className="h-4 w-4" />
            </Button>
          </div>
        ))}
      </div>
    </div>
  );
}

function SourceRow({ source }: { source: SourceRow }) {
  const display = useMemo(() => describeCitationSource({ url: source.url, ...(source.title ? { title: source.title } : {}) }), [source.title, source.url]);
  const faviconSrc = display.faviconHostname
    ? `https://www.google.com/s2/favicons?domain=${encodeURIComponent(display.faviconHostname)}&sz=32`
    : null;

  const open = () => void openExternalUrl({ url: source.url });

  return (
    <button
      type="button"
      onClick={open}
      className="group flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-foreground/[0.035] focus-visible:bg-foreground/[0.05] focus-visible:outline-none"
      title={display.displayUrl ?? display.hostLabel}
    >
      <SourceFavicon src={faviconSrc} letter={display.hostLabel.charAt(0)} />
      <div className="min-w-0 flex-1">
        <div className="truncate text-[12.5px] font-medium leading-tight text-foreground">
          {display.titleLabel}
        </div>
        <div className="truncate text-[11px] leading-tight text-muted-foreground">
          {display.hostLabel}
        </div>
      </div>
      <ExternalLinkIcon
        className="h-3 w-3 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100"
        aria-hidden="true"
      />
    </button>
  );
}

function SourceFavicon({ src, letter }: { src: string | null; letter: string }) {
  const [loaded, setLoaded] = useState(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    setLoaded(false);
    setFailed(false);
  }, [src]);

  return (
    <div
      className={cn(
        "relative flex size-4 shrink-0 items-center justify-center overflow-hidden rounded-sm bg-muted/70 text-[9px] font-semibold uppercase text-muted-foreground",
      )}
    >
      <span aria-hidden="true">{letter}</span>
      {src && !failed ? (
        <img
          src={src}
          alt=""
          decoding="async"
          className={cn(
            "absolute inset-0 size-full rounded-sm object-contain transition-opacity duration-150",
            loaded ? "opacity-100" : "opacity-0",
          )}
          onLoad={() => setLoaded(true)}
          onError={() => setFailed(true)}
        />
      ) : null}
    </div>
  );
}
