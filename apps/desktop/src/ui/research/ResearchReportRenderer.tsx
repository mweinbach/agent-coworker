import { Streamdown } from "streamdown";

export function ResearchReportRenderer({
  markdown,
  status,
}: {
  markdown: string;
  status: "pending" | "running" | "completed" | "cancelled" | "failed";
}) {
  if (!markdown.trim()) {
    return (
      <div className="rounded-2xl border border-border/65 bg-card/70 px-4 py-5 text-sm text-muted-foreground">
        {status === "running" || status === "pending"
          ? "Waiting for the report stream to produce content..."
          : "This research run did not produce a markdown report."}
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

