import { Streamdown } from "streamdown";

export function ResearchReportRenderer({
  markdown,
  status,
}: {
  markdown: string;
  status: "pending" | "running" | "completed" | "cancelled" | "failed";
}) {
  const hasMarkdown = markdown.trim().length > 0;
  const running = status === "running" || status === "pending";

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
    <div className="rounded-2xl border border-border/65 bg-card/80 px-5 py-5">
      <Streamdown className="max-w-none text-sm leading-7 [&>*:first-child]:mt-0 [&_a]:underline [&_code]:rounded-sm [&_code]:bg-muted/45 [&_code]:px-1.5 [&_code]:py-0.5 [&_pre]:overflow-x-auto [&_pre]:rounded-md [&_pre]:border [&_pre]:border-border/80 [&_pre]:bg-muted/35 [&_pre]:p-3">
        {markdown}
      </Streamdown>
    </div>
  );
}
