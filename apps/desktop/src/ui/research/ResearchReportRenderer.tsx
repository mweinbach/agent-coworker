import { useMemo } from "react";
import type { CitationSource } from "../../../../../src/shared/displayCitationMarkers";
import type { ResearchDetail } from "../../app/types";
import { MessageResponse } from "../../components/ai-elements/message";

type ResearchStatus = ResearchDetail["status"];
type ResearchSources = ResearchDetail["sources"];

const CITE_MARKER_PATTERN = /\[cite:\s*([\d\s,]+?)\s*\]/g;

function buildCitationSources(sources: ResearchSources): CitationSource[] {
  return sources.map((source) =>
    source.title ? { url: source.url, title: source.title } : { url: source.url },
  );
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
      <div role="status" aria-label="Report streaming">
        <div className="mb-4 flex items-center gap-2 text-xs font-medium text-muted-foreground">
          <span className="h-1.5 w-1.5 rounded-full bg-primary animate-pulse" aria-hidden="true" />
          Report streaming…
        </div>
        <div className="space-y-3" aria-hidden="true">
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
      <div className="text-sm text-muted-foreground">
        This research run did not produce a markdown report.
      </div>
    );
  }

  return (
    <MessageResponse
      normalizeDisplayCitations
      citationSources={citationSources}
      citationUrlsByIndex={citationUrlsByIndex}
      fallbackToSourcesFooter={false}
      className="research-report max-w-none text-[0.925rem] leading-7 [&>*:first-child]:mt-0 [&_h1]:mt-8 [&_h1]:text-2xl [&_h1]:font-semibold [&_h1]:tracking-tight [&_h2]:mt-7 [&_h2]:text-xl [&_h2]:font-semibold [&_h3]:mt-5 [&_h3]:text-lg [&_h3]:font-semibold [&_p]:my-3 [&_ul]:my-3 [&_ol]:my-3 [&_li]:my-1 [&_p_code]:rounded-sm [&_p_code]:bg-muted/45 [&_p_code]:px-1.5 [&_p_code]:py-0.5 [&_li_code]:rounded-sm [&_li_code]:bg-muted/45 [&_li_code]:px-1.5 [&_li_code]:py-0.5 [&_[data-streamdown=code-block]]:relative [&_[data-streamdown=code-block]]:my-4 [&_[data-streamdown=code-block]]:rounded-md [&_[data-streamdown=code-block]]:border [&_[data-streamdown=code-block]]:border-border/55 [&_[data-streamdown=code-block]]:bg-muted/25 [&_[data-streamdown=code-block]]:gap-0 [&_[data-streamdown=code-block]]:p-0 [&_[data-streamdown=code-block]]:overflow-hidden [&_[data-streamdown=code-block-header]]:h-7 [&_[data-streamdown=code-block-header]]:px-3 [&_[data-streamdown=code-block-header]]:border-b [&_[data-streamdown=code-block-header]]:border-border/40 [&_[data-streamdown=code-block-header]]:bg-muted/20 [&_[data-streamdown=code-block-header]_span]:ml-0 [&_[data-streamdown=code-block-header]_span]:text-[11px] [&_[data-streamdown=code-block-header]_span]:font-medium [&_[data-streamdown=code-block-header]_span]:tracking-wide [&_[data-streamdown=code-block]>div:not([data-streamdown])]:absolute [&_[data-streamdown=code-block]>div:not([data-streamdown])]:top-0.5 [&_[data-streamdown=code-block]>div:not([data-streamdown])]:right-1.5 [&_[data-streamdown=code-block]>div:not([data-streamdown])]:mt-0 [&_[data-streamdown=code-block]>div:not([data-streamdown])]:h-6 [&_[data-streamdown=code-block]>div:not([data-streamdown])]:z-10 [&_[data-streamdown=code-block-actions]]:h-6 [&_[data-streamdown=code-block-actions]]:border-border/40 [&_[data-streamdown=code-block-actions]]:bg-background/70 [&_[data-streamdown=code-block-body]]:border-0 [&_[data-streamdown=code-block-body]]:bg-transparent [&_[data-streamdown=code-block-body]]:rounded-none [&_[data-streamdown=code-block-body]]:px-4 [&_[data-streamdown=code-block-body]]:py-3 [&_pre]:bg-transparent [&_pre]:border-0 [&_pre]:p-0 [&_pre]:m-0"
    >
      {prepared}
    </MessageResponse>
  );
}
