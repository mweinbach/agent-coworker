import { ExternalLinkIcon } from "lucide-react";

import type { ResearchDetail } from "../../app/types";
import { Button } from "../../components/ui/button";
import { openExternalUrl } from "../../lib/desktopCommands";

export function ResearchSourcesList({ sources }: { sources: ResearchDetail["sources"] }) {
  if (sources.length === 0) {
    return null;
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
            className="flex items-center justify-between gap-3 rounded-xl border border-border/60 bg-muted/10 px-3 py-3"
          >
            <div className="min-w-0">
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

