import { useMemo } from "react";

import type { ResearchDetail } from "../../app/types";
import type { CitationSource } from "../../../../../src/shared/displayCitationMarkers";
import { MessageResponse } from "../../components/ai-elements/message";

type ResearchStatus = ResearchDetail["status"];
type ResearchSources = ResearchDetail["sources"];

const CITE_MARKER_PATTERN = /\[cite:\s*([\d\s,]+?)\s*\]/g;

function buildCitationSources(sources: ResearchSources): CitationSource[] {
  return sources.map((source) => (source.title
    ? { url: source.url, title: source.title }
    : { url: source.url }));
}

function rewriteCiteMarkers(markdown: string, sources: readonly CitationSource[]): string {
  if (sources.length === 0 || !markdown.includes("[cite:")) {
    return markdown;
  }

  return markdown.replace(CITE_MARKER_PATTERN, (match, idsStr: string) => {
    const ids = idsStr
      .split(/[\s,]+/)
      .map((entry) => Number.parseInt(entry, 10))
      .filter((value) => Number.isFinite(value) && value > 0);
    if (ids.length === 0) {
      return match;
    }

    const rendered: string[] = [];
    for (const id of ids) {
      const source = sources[id - 1];
      if (!source) {
        continue;
      }
      const label = source.title?.trim() || safeHost(source.url) || source.url;
      rendered.push(`【${id}†${label}】`);
    }
    return rendered.length > 0 ? rendered.join("") : match;
  });
}

function safeHost(url: string): string | null {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return null;
  }
}

export function ResearchReportRenderer({
  markdown,
  status,
  sources,
}: {
  markdown: string;
  status: ResearchStatus;
  sources: ResearchSources;
}) {
  const hasMarkdown = markdown.trim().length > 0;
  const running = status === "running" || status === "pending";

  const citationSources = useMemo(() => buildCitationSources(sources), [sources]);
  const citationUrlsByIndex = useMemo(() => {
    const map = new Map<number, string>();
    citationSources.forEach((source, index) => {
      map.set(index + 1, source.url);
    });
    return map;
  }, [citationSources]);

  const prepared = useMemo(
    () => (hasMarkdown ? rewriteCiteMarkers(markdown, citationSources) : markdown),
    [citationSources, hasMarkdown, markdown],
  );

  if (!hasMarkdown && running) {
    return (
      <div
        className="rounded-2xl border border-border/65 bg-card/70 px-5 py-5"
        role="status"
        aria-label="Report streaming"
      >
        <div className="mb-3 flex items-center gap-2 text-xs font-medium text-muted-foreground">
          <span className="h-1.5 w-1.5 rounded-full bg-primary animate-pulse" aria-hidden="true" />
          Report streaming…
        </div>
        <div className="space-y-2.5" aria-hidden="true">
          <div className="h-3 w-[88%] animate-pulse rounded bg-muted/55" />
          <div className="h-3 w-[72%] animate-pulse rounded bg-muted/45" />
          <div className="h-3 w-[95%] animate-pulse rounded bg-muted/55" />
          <div className="h-3 w-[60%] animate-pulse rounded bg-muted/40" />
          <div className="h-3 w-[80%] animate-pulse rounded bg-muted/50" />
        </div>
      </div>
    );
  }

  if (!hasMarkdown) {
    return (
      <div className="rounded-2xl border border-border/65 bg-card/70 px-4 py-5 text-sm text-muted-foreground">
        This research run did not produce a markdown report.
      </div>
    );
  }

  return (
    <div className="research-report rounded-2xl border border-border/65 bg-card/80 px-6 py-6">
      <MessageResponse
        normalizeDisplayCitations
        citationSources={citationSources}
        citationUrlsByIndex={citationUrlsByIndex}
        fallbackToSourcesFooter={false}
        className="max-w-none text-[0.925rem] leading-7 [&>*:first-child]:mt-0 [&_h1]:mt-8 [&_h1]:text-2xl [&_h1]:font-semibold [&_h1]:tracking-tight [&_h2]:mt-7 [&_h2]:text-xl [&_h2]:font-semibold [&_h3]:mt-5 [&_h3]:text-lg [&_h3]:font-semibold [&_p]:my-3 [&_ul]:my-3 [&_ol]:my-3 [&_li]:my-1 [&_code]:rounded-sm [&_code]:bg-muted/45 [&_code]:px-1.5 [&_code]:py-0.5 [&_pre]:my-4 [&_pre]:overflow-x-auto [&_pre]:rounded-md [&_pre]:border [&_pre]:border-border/80 [&_pre]:bg-muted/35 [&_pre]:p-3"
      >
        {prepared}
      </MessageResponse>
    </div>
  );
}
