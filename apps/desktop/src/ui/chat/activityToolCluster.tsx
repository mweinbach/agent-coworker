import {
  ChevronRightIcon,
  GlobeIcon,
  ListTodoIcon,
  SearchIcon,
  ShieldAlertIcon,
  TerminalIcon,
  WrenchIcon,
  XCircleIcon,
} from "lucide-react";
import type { ReactNode } from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { ToolFeedState } from "../../app/types";
import { Badge } from "../../components/ui/badge";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "../../components/ui/collapsible";
import { cn } from "../../lib/utils";
import type { ActivityFeedItem, ActivityGroupSummary } from "./activityGroups";
import { formatToolCard } from "./toolCards/toolCardFormatting";

function TimelineToolIcon({ title, className }: { title: string; className?: string }) {
  const t = title.toLowerCase();
  if (t.includes("todo") || t.includes("task")) return <ListTodoIcon className={className} />;
  if (t.includes("search") || t.includes("grep") || t.includes("glob"))
    return <SearchIcon className={className} />;
  if (t.includes("fetch") || t.includes("web") || t.includes("browser"))
    return <GlobeIcon className={className} />;
  if (t.includes("bash") || t.includes("shell") || t.includes("run") || t.includes("command"))
    return <TerminalIcon className={className} />;
  return <WrenchIcon className={className} />;
}

function ToolStateIndicator({ state }: { state: ToolFeedState }) {
  if (state === "output-available") return null;
  if (state === "output-error" || state === "output-denied") {
    return <XCircleIcon className="size-3 text-destructive" />;
  }
  if (state === "approval-requested") {
    return (
      <Badge
        variant="destructive"
        className="gap-1 px-1.5 py-0 text-xs font-semibold uppercase tracking-wide"
      >
        <ShieldAlertIcon className="size-2.5" />
        Review
      </Badge>
    );
  }
  return (
    <span className="activity-live-dot size-1.5 shrink-0 rounded-full bg-primary" aria-hidden />
  );
}

/* ── Timeline building block ────────────────────────────────────────────────── */

export function TimelineNode({
  icon,
  isLast,
  children,
}: {
  icon: ReactNode;
  isLast: boolean;
  children: ReactNode;
}) {
  return (
    <div className="flex gap-2.5">
      <div className="flex flex-col items-center">
        <div className="mt-0.5 flex size-[1.125rem] shrink-0 items-center justify-center">
          {icon}
        </div>
        {!isLast && <div className="mt-1 w-px flex-1 bg-border/35" />}
      </div>
      <div className="min-w-0 flex-1 pb-3">{children}</div>
    </div>
  );
}

function toPrettyJson(value: unknown): string {
  if (value === undefined) return "";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function ToolRowSummary({
  title,
  subtitle,
  recovered,
  state,
  hideTitle,
  fallbackLabel,
  command,
  retryOf,
}: {
  title: string;
  subtitle: string;
  recovered: boolean;
  state: ToolFeedState;
  hideTitle?: boolean;
  fallbackLabel?: string;
  command?: boolean;
  retryOf?: string;
}) {
  return (
    <div className="min-w-0 flex-1">
      <div className="flex items-center gap-1.5">
        {hideTitle ? (
          <span
            className={cn(
              "min-w-0 truncate app-type-body text-foreground",
              command && subtitle && "font-mono text-xs",
            )}
          >
            {subtitle || fallbackLabel || title}
          </span>
        ) : (
          <span className="app-type-body font-medium text-foreground">{title}</span>
        )}
        {recovered ? (
          <Badge
            variant="outline"
            className="px-1.5 py-0 text-xs font-semibold uppercase tracking-wide"
            data-tool-recovery="recovered"
          >
            Recovered
          </Badge>
        ) : (
          <ToolStateIndicator state={state} />
        )}
      </div>
      {!hideTitle && subtitle ? (
        <div
          className={cn(
            "mt-0.5 truncate text-xs leading-snug app-text-muted",
            command && "font-mono",
          )}
        >
          {subtitle}
        </div>
      ) : null}
      {retryOf ? (
        <div className="mt-0.5 text-xs font-medium app-text-muted" data-tool-recovery="retry">
          Retry of failed call
        </div>
      ) : null}
    </div>
  );
}

function ToolTimelineNode({
  item,
  isLast,
  recovered,
  hideTitle = false,
  embedded = false,
  fallbackLabel,
}: {
  item: Extract<ActivityFeedItem, { kind: "tool" }>;
  isLast: boolean;
  recovered: boolean;
  /** When true, the parent cluster already shows the tool name — only render the row detail. */
  hideTitle?: boolean;
  /** Skip the outer timeline rail when nested under a cluster disclosure. */
  embedded?: boolean;
  fallbackLabel?: string;
}) {
  const formatting = useMemo(
    () => formatToolCard(item.name, item.args, item.result, item.state),
    [item.args, item.name, item.result, item.state],
  );
  const detailRows = useMemo(
    () =>
      formatting.details.filter(
        (row) => row.label !== "Status" && !(row.label === "Path" && formatting.subtitle),
      ),
    [formatting.details, formatting.subtitle],
  );
  const argsText = useMemo(() => toPrettyJson(item.args), [item.args]);
  const resultText = useMemo(() => toPrettyJson(item.result), [item.result]);
  const hasRawPayload = Boolean(argsText || resultText);
  const hasDetails = detailRows.length > 0 || hasRawPayload || Boolean(item.approval);
  const shouldAutoExpand =
    item.state === "approval-requested" ||
    item.state === "output-error" ||
    item.state === "output-denied";
  const [open, setOpen] = useState(shouldAutoExpand && hasDetails);
  const [rawOpen, setRawOpen] = useState(false);
  const userToggledRef = useRef(false);
  const handleOpenChange = (nextOpen: boolean) => {
    userToggledRef.current = true;
    setOpen(nextOpen);
  };

  useEffect(() => {
    if (!userToggledRef.current && shouldAutoExpand && hasDetails) {
      setOpen(true);
    }
  }, [hasDetails, shouldAutoExpand]);

  const summary = (
    <ToolRowSummary
      title={formatting.title}
      subtitle={formatting.subtitle}
      recovered={recovered}
      state={item.state}
      hideTitle={hideTitle}
      fallbackLabel={fallbackLabel}
      command={formatting.title === "Run command"}
      retryOf={item.retryOf}
    />
  );

  const body = hasDetails ? (
    <Collapsible open={open} onOpenChange={handleOpenChange}>
      <CollapsibleTrigger className="group/tool-row flex w-full min-w-0 items-start gap-1.5 rounded-md py-0.5 text-left outline-none hover:app-hover-wash focus-visible:ring-1 focus-visible:ring-ring">
        {summary}
        <ChevronRightIcon
          className={cn(
            "mt-0.5 size-3.5 shrink-0 app-text-muted transition-transform duration-150 group-hover/tool-row:text-muted-foreground",
            open && "rotate-90",
          )}
          aria-hidden
        />
      </CollapsibleTrigger>
      <CollapsibleContent className="activity-trace-content pt-1.5">
        {detailRows.length > 0 ? (
          <div className="grid gap-1.5 sm:grid-cols-2">
            {detailRows.map((row) => (
              <div
                key={`${item.id}-${row.label}`}
                className="rounded-lg app-fill-subtle px-2 py-1.5"
              >
                <div className="text-xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">
                  {row.label}
                </div>
                <div className="mt-0.5 break-words text-xs leading-snug app-text-secondary">
                  {row.value}
                </div>
              </div>
            ))}
          </div>
        ) : null}
        {item.approval ? (
          <div className="mt-1.5 rounded-lg app-fill-subtle px-2 py-1.5 app-type-caption app-text-secondary">
            Approval required
          </div>
        ) : null}
        {hasRawPayload ? (
          <Collapsible open={rawOpen} onOpenChange={setRawOpen}>
            <CollapsibleTrigger className="mt-1.5 flex items-center gap-1 text-xs font-medium app-text-muted outline-none hover:text-foreground">
              <ChevronRightIcon
                className={cn("size-3 transition-transform", rawOpen && "rotate-90")}
              />
              Raw input/output
            </CollapsibleTrigger>
            <CollapsibleContent>
              {argsText ? (
                <pre className="mt-1.5 max-h-40 overflow-auto rounded-lg app-fill-subtle p-2 app-type-caption app-text-secondary">
                  {argsText}
                </pre>
              ) : null}
              {resultText ? (
                <pre
                  className={cn(
                    "mt-1.5 max-h-48 overflow-auto rounded-lg p-2 text-xs leading-relaxed",
                    item.state === "output-error" || item.state === "output-denied"
                      ? "bg-destructive/[0.06] text-destructive"
                      : "app-fill-subtle app-text-secondary",
                  )}
                >
                  {resultText}
                </pre>
              ) : null}
            </CollapsibleContent>
          </Collapsible>
        ) : null}
      </CollapsibleContent>
    </Collapsible>
  ) : (
    <div className="min-w-0 py-0.5">{summary}</div>
  );

  if (embedded) {
    return body;
  }

  return (
    <TimelineNode
      icon={<TimelineToolIcon title={formatting.title} className="size-3 app-text-muted" />}
      isLast={isLast}
    >
      {body}
    </TimelineNode>
  );
}

type TimelineRenderBucket =
  | { kind: "reasoning"; entry: ActivityGroupSummary["entries"][number] & { kind: "reasoning" } }
  | {
      kind: "tool-cluster";
      name: string;
      entries: Array<ActivityGroupSummary["entries"][number] & { kind: "tool" }>;
    };

/**
 * Cluster consecutive same-name tools so parallel bursts (e.g. four webSearch
 * calls) read as one intentional group instead of a shuffled checklist.
 */
export function bucketTimelineEntries(
  entries: ActivityGroupSummary["entries"],
): TimelineRenderBucket[] {
  const buckets: TimelineRenderBucket[] = [];
  for (const entry of entries) {
    if (entry.kind === "reasoning") {
      buckets.push({ kind: "reasoning", entry });
      continue;
    }
    const previous = buckets[buckets.length - 1];
    if (
      previous?.kind === "tool-cluster" &&
      formatToolCard(previous.name, undefined, undefined, "output-available").title ===
        formatToolCard(entry.item.name, undefined, undefined, "output-available").title
    ) {
      previous.entries.push(entry);
      continue;
    }
    buckets.push({ kind: "tool-cluster", name: entry.item.name, entries: [entry] });
  }
  return buckets;
}

export function ToolClusterNode({
  entries,
  isLastBucket,
  recoveredToolIds,
}: {
  entries: Array<ActivityGroupSummary["entries"][number] & { kind: "tool" }>;
  isLastBucket: boolean;
  recoveredToolIds: ReadonlySet<string>;
}) {
  const showClusterChrome = entries.length > 1;
  const clusterLabel = formatToolCard(
    entries[0].item.name,
    undefined,
    undefined,
    "output-available",
  ).title;
  const clusterOpenByDefault = entries.some(
    (entry) =>
      entry.item.state === "approval-requested" ||
      entry.item.state === "output-error" ||
      entry.item.state === "output-denied" ||
      entry.item.state === "input-streaming" ||
      entry.item.state === "input-available",
  );
  const [clusterOpen, setClusterOpen] = useState(clusterOpenByDefault || !showClusterChrome);
  const userToggledRef = useRef(false);
  const handleClusterOpenChange = (open: boolean) => {
    userToggledRef.current = true;
    setClusterOpen(open);
  };

  useEffect(() => {
    if (!userToggledRef.current && clusterOpenByDefault && showClusterChrome) {
      setClusterOpen(true);
    }
  }, [clusterOpenByDefault, showClusterChrome]);

  const previews = entries
    .map((entry) => ({
      id: entry.item.id,
      text: formatToolCard(entry.item.name, entry.item.args, entry.item.result, entry.item.state)
        .subtitle,
    }))
    .filter((preview) => preview.text.length > 0)
    .slice(0, 3);

  if (!showClusterChrome) {
    const entry = entries[0];
    return (
      <div
        data-activity-entry-kind="tool-cluster"
        data-tool-cluster-size="1"
        data-scroll-anchor-id={entry.item.id}
      >
        <div data-activity-entry-kind="tool" data-scroll-anchor-id={entry.item.id}>
          <ToolTimelineNode
            item={entry.item}
            isLast={isLastBucket}
            recovered={recoveredToolIds.has(entry.item.id)}
          />
        </div>
      </div>
    );
  }

  return (
    <div
      data-activity-entry-kind="tool-cluster"
      data-tool-cluster-size={entries.length}
      data-scroll-anchor-id={entries[0].item.id}
      className="mb-0.5"
    >
      <TimelineNode
        icon={<TimelineToolIcon title={clusterLabel} className="size-3 app-text-muted" />}
        isLast={isLastBucket}
      >
        <Collapsible open={clusterOpen} onOpenChange={handleClusterOpenChange}>
          <CollapsibleTrigger
            className="group/cluster flex w-full min-w-0 items-start gap-1.5 rounded-md py-0.5 text-left outline-none hover:app-hover-wash focus-visible:ring-1 focus-visible:ring-ring"
            data-slot="tool-cluster-label"
          >
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-1.5 app-type-body font-medium text-foreground">
                <span>{clusterLabel}</span>
                <span className="tabular-nums app-text-muted">×{entries.length}</span>
              </div>
              {previews.length > 0 && !clusterOpen ? (
                <div
                  className={cn(
                    "mt-0.5 flex flex-col gap-0.5 app-type-caption app-text-muted",
                    clusterLabel === "Run command" && "font-mono",
                  )}
                >
                  {previews.map((preview) => (
                    <div key={preview.id} className="truncate">
                      {preview.text}
                    </div>
                  ))}
                  {entries.length > previews.length ? (
                    <div>+{entries.length - previews.length} more</div>
                  ) : null}
                </div>
              ) : null}
            </div>
            <ChevronRightIcon
              className={cn(
                "mt-0.5 size-3.5 shrink-0 app-text-muted transition-transform duration-150",
                clusterOpen && "rotate-90",
              )}
              aria-hidden
            />
          </CollapsibleTrigger>
          <CollapsibleContent className="activity-trace-content pt-1.5">
            <div className="ml-0.5 flex flex-col gap-1 border-l app-border-subtle pl-2.5">
              {entries.map((entry, index) => (
                <div
                  key={entry.item.id}
                  data-activity-entry-kind="tool"
                  data-scroll-anchor-id={entry.item.id}
                >
                  <ToolTimelineNode
                    item={entry.item}
                    isLast
                    recovered={recoveredToolIds.has(entry.item.id)}
                    hideTitle
                    embedded
                    fallbackLabel={
                      clusterLabel === "Run command" ? `Command ${index + 1}` : `Step ${index + 1}`
                    }
                  />
                </div>
              ))}
            </div>
          </CollapsibleContent>
        </Collapsible>
      </TimelineNode>
    </div>
  );
}
