import type { SessionUsageSnapshot } from "../../app/types";
import { Button } from "../../components/ui/button";
import { cn } from "../../lib/utils";
import { sessionUsageTone } from "./chatLogic";

export function ChatThreadHeader(props: {
  title: string;
  sessionUsage: SessionUsageSnapshot | null;
  usageHeadline: string | null;
  usageBudgetLine: string | null;
  canClearHardCap: boolean;
  onClearHardCap: () => void;
}) {
  const { title, sessionUsage, usageHeadline, usageBudgetLine, canClearHardCap, onClearHardCap } =
    props;
  const hasUsageSummary = Boolean(usageHeadline || usageBudgetLine);

  return (
    <div className="pointer-events-none absolute top-0 left-0 right-0 z-10 flex items-start justify-center bg-gradient-to-b from-panel via-panel/88 to-transparent px-3 pt-2.5 pb-6">
      <div
        className={cn(
          "pointer-events-auto relative flex flex-col items-center outline-none",
          hasUsageSummary ? "group" : null,
        )}
        tabIndex={hasUsageSummary ? 0 : undefined}
      >
        <div
          className={cn(
            "max-w-lg truncate rounded-[calc(var(--radius)*1.35)] border border-border/45 bg-background/86 px-3 py-1 text-[13px] font-medium text-foreground shadow-none backdrop-blur-sm",
            hasUsageSummary
              ? "transition-[border-color,box-shadow,background-color] group-hover:border-border group-focus-within:border-border group-focus-within:ring-2 group-focus-within:ring-ring/40"
              : null,
          )}
        >
          {title}
        </div>
        {hasUsageSummary ? (
          <div
            className={cn(
              "pointer-events-none absolute top-full mt-2 flex max-w-3xl flex-wrap items-center justify-center gap-2 rounded-[calc(var(--radius)*1.35)] border px-3 py-1 text-[11px] shadow-none backdrop-blur-sm opacity-0 -translate-y-1 transition-all duration-150 ease-out group-hover:pointer-events-auto group-hover:translate-y-0 group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:translate-y-0 group-focus-within:opacity-100",
              sessionUsageTone(sessionUsage),
            )}
          >
            <span className="text-[10px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
              Usage
            </span>
            {usageHeadline ? <span>{usageHeadline}</span> : null}
            {usageBudgetLine ? <span className="font-medium">{usageBudgetLine}</span> : null}
            {canClearHardCap ? (
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="h-6 rounded-md px-2.5 text-[11px]"
                onClick={onClearHardCap}
              >
                Clear hard cap
              </Button>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}
