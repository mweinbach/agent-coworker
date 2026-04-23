import { useEffect, useId, useRef, useState, type CSSProperties } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { ActivityIcon, CheckIcon, MessageSquareIcon, PanelRightIcon, PencilIcon } from "lucide-react";

import { usePrefersReducedMotion } from "../../lib/usePrefersReducedMotion";

import type { ResearchDetail } from "../../app/types";
import { useAppStore } from "../../app/store";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { formatRelativeAge } from "../../lib/time";
import { ResearchExportMenu } from "./ResearchExportMenu";
import { ResearchFollowUpComposer } from "./ResearchFollowUpComposer";
import { ResearchReportRenderer } from "./ResearchReportRenderer";
import { ResearchSourcesList } from "./ResearchSourcesList";
import { cn } from "../../lib/utils";

const RESEARCH_SOURCES_PANEL_WIDTH = "clamp(18rem, 30vw, 26rem)";
const RESEARCH_INLINE_SOURCES_MIN_DETAIL_WIDTH = 36 * 16;

function statusClassName(status: ResearchDetail["status"]): string {
  switch (status) {
    case "completed":
      return "border-success/25 bg-success/10 text-success";
    case "running":
    case "pending":
      return "border-primary/25 bg-primary/10 text-primary";
    case "cancelled":
      return "border-warning/25 bg-warning/10 text-warning";
    case "failed":
      return "border-destructive/25 bg-destructive/10 text-destructive";
    default:
      return "";
  }
}

function statusLabel(status: ResearchDetail["status"]): string {
  return status.charAt(0).toUpperCase() + status.slice(1);
}

function formatElapsed(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const pad = (n: number) => n.toString().padStart(2, "0");
  if (hours > 0) {
    return `${hours}:${pad(minutes)}:${pad(seconds)}`;
  }
  return `${pad(minutes)}:${pad(seconds)}`;
}

function useRunningElapsed(startedAtIso: string, running: boolean): number {
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    if (!running) {
      return;
    }
    const id = window.setInterval(() => setNowMs(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [running]);
  const startedMs = new Date(startedAtIso).getTime();
  if (Number.isNaN(startedMs)) {
    return 0;
  }
  return Math.max(0, nowMs - startedMs);
}

function useElementWidth<T extends HTMLElement>(ref: React.RefObject<T | null>, watchKey?: string | null): number {
  const [width, setWidth] = useState(0);

  useEffect(() => {
    const node = ref.current;
    if (!node) {
      return;
    }

    setWidth(node.getBoundingClientRect().width);

    if (typeof ResizeObserver !== "function") {
      return;
    }

    const observer = new ResizeObserver((entries) => {
      const nextWidth = entries[0]?.contentRect.width;
      if (typeof nextWidth === "number") {
        setWidth(nextWidth);
      }
    });

    observer.observe(node);
    return () => observer.disconnect();
  }, [ref, watchKey]);

  return width;
}

export function ResearchDetailPane({ research }: { research: ResearchDetail | null }) {
  const cancelResearch = useAppStore((s) => s.cancelResearch);
  const approveResearchPlan = useAppStore((s) => s.approveResearchPlan);
  const refineResearchPlan = useAppStore((s) => s.refineResearchPlan);
  const exportPendingIds = useAppStore((s) => s.researchExportPendingIds);
  const running = research ? research.status === "running" || research.status === "pending" : false;
  const elapsedMs = useRunningElapsed(research?.createdAt ?? new Date().toISOString(), running);
  const prefersReducedMotion = usePrefersReducedMotion();
  const sourcesPanelId = useId();
  const detailBodyRef = useRef<HTMLDivElement | null>(null);
  const [sourcesOpen, setSourcesOpen] = useState(false);
  const [refineOpen, setRefineOpen] = useState(false);
  const [refineInput, setRefineInput] = useState("");
  const [planActionLoading, setPlanActionLoading] = useState(false);
  const detailBodyWidth = useElementWidth(detailBodyRef, research?.id ?? null);

  useEffect(() => {
    setSourcesOpen(false);
    setRefineOpen(false);
    setRefineInput("");
    setPlanActionLoading(false);
  }, [research?.id]);

  if (!research) {
    return (
      <div className="flex h-full items-center justify-center px-6 text-center text-sm text-muted-foreground">
        Select a research card to inspect the report, sources, and follow-ups.
      </div>
    );
  }

  const exportPending = exportPendingIds.includes(research.id);
  const startedAgo = formatRelativeAge(research.createdAt);
  const canExport = research.status === "completed" && research.outputsMarkdown.trim().length > 0;
  const sourceCount = research.sources.length;
  const thoughtCount = research.thoughtSummaries.length;
  const showSourcesPanel = sourcesOpen && sourceCount > 0;
  const sourcesOverlay = detailBodyWidth > 0 && detailBodyWidth < RESEARCH_INLINE_SOURCES_MIN_DETAIL_WIDTH;
  const sourcesPanelStyle = {
    "--research-sources-panel-width": RESEARCH_SOURCES_PANEL_WIDTH,
    flexBasis: sourcesOverlay ? undefined : showSourcesPanel ? "var(--research-sources-panel-width)" : "0px",
    width: showSourcesPanel
      ? sourcesOverlay
        ? "min(var(--research-sources-panel-width), calc(100% - 0.75rem))"
        : "var(--research-sources-panel-width)"
      : "0px",
  } as CSSProperties;

  return (
    <div className="relative flex h-full min-h-0 flex-col">
      <div className="flex min-w-0 flex-wrap items-center gap-x-4 gap-y-2 border-b border-border/55 px-4 py-2">
        <div className="flex min-w-0 flex-1 basis-[26rem] flex-wrap items-center gap-x-4 gap-y-2">
          <div className="flex min-w-0 flex-1 basis-48 flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
            <Badge className={cn("shrink-0", research.planPending ? "border-info/25 bg-info/10 text-info" : statusClassName(research.status))}>
              {research.planPending ? "Plan Ready" : statusLabel(research.status)}
            </Badge>
            {running ? (
              <>
                <span className="whitespace-nowrap tabular-nums text-foreground/80">{formatElapsed(elapsedMs)}</span>
                <span aria-hidden="true">·</span>
                <span className="whitespace-nowrap">
                  <span className="tabular-nums text-foreground/80">{sourceCount}</span>{" "}
                  {sourceCount === 1 ? "source" : "sources"}
                </span>
                {thoughtCount > 0 ? (
                  <>
                    <span aria-hidden="true">·</span>
                    <span className="whitespace-nowrap">
                      <span className="tabular-nums text-foreground/80">{thoughtCount}</span>{" "}
                      {thoughtCount === 1 ? "reasoning update" : "reasoning updates"}
                    </span>
                  </>
                ) : null}
              </>
            ) : research.planPending ? (
              <span className="whitespace-nowrap">Awaiting your approval</span>
            ) : startedAgo ? (
              <span className="whitespace-nowrap">{startedAgo} ago</span>
            ) : null}
          </div>
        </div>

        <div className="ml-auto flex max-w-full shrink-0 flex-wrap items-center justify-end gap-2">
          {sourceCount > 0 ? (
            <Button
              size="sm"
              type="button"
              variant="outline"
              onClick={() => setSourcesOpen((open) => !open)}
              aria-pressed={sourcesOpen}
              aria-expanded={sourcesOpen}
              aria-controls={sourcesPanelId}
              aria-label={sourcesOpen ? "Hide sources panel" : "Show sources panel"}
              className={cn(
                "h-7 gap-1.5 rounded-full border-border/60 px-3 text-xs",
                sourcesOpen ? "bg-primary/10 border-primary/30 text-primary" : "bg-muted/15",
              )}
            >
              <PanelRightIcon className={cn("h-3.5 w-3.5 transition-transform", sourcesOpen && "rotate-180")} aria-hidden="true" />
              Sources
              <span className="rounded-full bg-muted/80 px-1.5 text-[10px] font-medium tabular-nums text-muted-foreground">
                {sourceCount}
              </span>
            </Button>
          ) : null}
          <ResearchExportMenu
            researchId={research.id}
            pending={exportPending}
            disabled={!canExport}
          />
          {running ? (
            <Button size="sm" variant="outline" type="button" onClick={() => void cancelResearch(research.id)}>
              Cancel
            </Button>
          ) : null}
        </div>
      </div>

      <div ref={detailBodyRef} className="relative flex min-h-0 min-w-0 flex-1 flex-row">
        <div className="min-w-0 flex-1 overflow-y-auto px-8 py-6">
          <div className="mx-auto flex max-w-4xl flex-col gap-6">
            {research.error ? (
              <div className="rounded-xl border border-destructive/35 bg-destructive/5 px-3 py-2 text-xs text-destructive">
                {research.error}
              </div>
            ) : null}

            {research.planPending ? (
              <div className="rounded-2xl border border-info/25 bg-info/5 px-5 py-4">
                <div className="mb-3 text-sm font-medium text-info">Research Plan</div>
                <div className="mb-4 text-xs text-muted-foreground">
                  Review the proposed plan below. Approve it to start the full research, or request changes.
                </div>
                {!refineOpen ? (
                  <div className="flex flex-wrap gap-2">
                    <Button
                      size="sm"
                      className="gap-1.5 rounded-full"
                      disabled={planActionLoading}
                      onClick={() => {
                        setPlanActionLoading(true);
                        void approveResearchPlan(research.id).finally(() => setPlanActionLoading(false));
                      }}
                    >
                      <CheckIcon className="h-3.5 w-3.5" />
                      Approve Plan
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      className="gap-1.5 rounded-full"
                      disabled={planActionLoading}
                      onClick={() => setRefineOpen(true)}
                    >
                      <PencilIcon className="h-3.5 w-3.5" />
                      Refine Plan
                    </Button>
                  </div>
                ) : (
                  <div className="space-y-2">
                    <textarea
                      className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:border-info focus:ring-1 focus:ring-info/20"
                      rows={3}
                      placeholder="What would you like to change about the plan?"
                      value={refineInput}
                      onChange={(e) => setRefineInput(e.target.value)}
                      autoFocus
                    />
                    <div className="flex flex-wrap gap-2">
                      <Button
                        size="sm"
                        className="gap-1.5 rounded-full"
                        disabled={planActionLoading || !refineInput.trim()}
                        onClick={() => {
                          setPlanActionLoading(true);
                          void refineResearchPlan(research.id, refineInput.trim()).finally(() => {
                            setPlanActionLoading(false);
                            setRefineOpen(false);
                            setRefineInput("");
                          });
                        }}
                      >
                        Submit Refinement
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={planActionLoading}
                        onClick={() => {
                          setRefineOpen(false);
                          setRefineInput("");
                        }}
                      >
                        Cancel
                      </Button>
                    </div>
                  </div>
                )}
              </div>
            ) : null}

            {running ? (
              <ResearchReasoningStream
                thoughtSummaries={research.thoughtSummaries}
                status={research.status}
              />
            ) : null}

            <ResearchReportRenderer
              markdown={research.outputsMarkdown}
              status={research.status}
              sources={research.sources}
            />
          </div>
        </div>

        {sourceCount > 0 ? (
          <aside
            id={sourcesPanelId}
            data-sources-presentation={sourcesOverlay ? "overlay" : "inline"}
            className={cn(
              "min-h-0 overflow-hidden bg-muted/15 transition-[width,opacity,border-color,transform] ease-out",
              prefersReducedMotion ? "duration-0" : "duration-200",
              sourcesOverlay
                ? showSourcesPanel
                  ? "absolute inset-y-0 right-0 z-20 border-l border-border/55 bg-background/96 opacity-100 shadow-2xl shadow-black/10 backdrop-blur-sm"
                  : "pointer-events-none absolute inset-y-0 right-0 z-20 border-l border-transparent opacity-0 translate-x-3"
                : showSourcesPanel
                  ? "shrink-0 border-l border-border/55 opacity-100"
                  : "pointer-events-none shrink-0 border-l border-transparent opacity-0",
            )}
            aria-label="Sources"
            aria-hidden={!showSourcesPanel}
            style={sourcesPanelStyle}
          >
            <div
              className="flex h-full min-h-0 min-w-0 flex-col"
              style={{ width: sourcesOverlay ? "100%" : "var(--research-sources-panel-width)" }}
            >
              <div className="flex h-9 items-center gap-2 border-b border-border/55 px-3 text-[11px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">
                Sources
                <span className="rounded-full bg-muted/80 px-1.5 text-[10px] font-medium tabular-nums text-muted-foreground">
                  {sourceCount}
                </span>
              </div>
              <div className="min-h-0 flex-1 overflow-y-auto p-2">
                <ResearchSourcesList sources={research.sources} variant="inline" />
              </div>
            </div>
          </aside>
        ) : null}
      </div>

      {research.status === "completed" && !research.planPending ? (
        <ResearchFollowUpFab parentResearchId={research.id} />
      ) : null}
    </div>
  );
}

function ResearchFollowUpFab({ parentResearchId }: { parentResearchId: string }) {
  const [expanded, setExpanded] = useState(false);
  const prefersReducedMotion = usePrefersReducedMotion();
  const composerShellRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    setExpanded(false);
  }, [parentResearchId]);

  useEffect(() => {
    if (!expanded) {
      return;
    }

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setExpanded(false);
      }
    };

    const onPointerDown = (event: MouseEvent) => {
      const shell = composerShellRef.current;
      if (!shell) {
        return;
      }
      if (event.target instanceof Node && shell.contains(event.target)) {
        return;
      }
      setExpanded(false);
    };

    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("mousedown", onPointerDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("mousedown", onPointerDown);
    };
  }, [expanded]);

  const springTransition = prefersReducedMotion
    ? { duration: 0 }
    : { type: "spring" as const, stiffness: 420, damping: 34, mass: 0.9 };

  return (
    <div className="pointer-events-none absolute bottom-4 left-4 right-4 z-30 flex items-end justify-start">
      <AnimatePresence mode="popLayout" initial={false}>
        {expanded ? (
          <motion.div
            key="composer"
            ref={composerShellRef}
            layout
            className="pointer-events-auto w-full max-w-2xl origin-bottom-left"
            initial={{ opacity: 0, scale: 0.88, y: 6 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.88, y: 6 }}
            transition={springTransition}
          >
            <ResearchFollowUpComposer
              parentResearchId={parentResearchId}
              autoFocus
              onSubmitted={() => setExpanded(false)}
              className="shadow-lg shadow-black/15"
            />
          </motion.div>
        ) : (
          <motion.div
            key="fab"
            layout
            className="pointer-events-auto origin-bottom-left"
            initial={{ opacity: 0, scale: 0.7 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.7 }}
            transition={springTransition}
            whileHover={prefersReducedMotion ? undefined : { scale: 1.06 }}
            whileTap={prefersReducedMotion ? undefined : { scale: 0.94 }}
          >
            <Button
              type="button"
              size="icon"
              onClick={() => setExpanded(true)}
              aria-label="Ask a follow-up"
              title="Ask a follow-up"
              className="size-11 rounded-full shadow-lg shadow-black/20"
            >
              <MessageSquareIcon className="h-5 w-5" />
            </Button>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function ResearchReasoningStream({
  thoughtSummaries,
  status,
}: {
  thoughtSummaries: ResearchDetail["thoughtSummaries"];
  status: ResearchDetail["status"];
}) {
  const running = status === "running" || status === "pending";

  if (thoughtSummaries.length === 0 && running) {
    return (
      <section
        aria-label="Reasoning stream"
        className="relative overflow-hidden rounded-2xl border border-primary/20 bg-gradient-to-br from-primary/10 via-card/80 to-muted/25 px-5 py-5"
      >
        <div className="pointer-events-none absolute inset-x-6 top-0 h-px bg-gradient-to-r from-transparent via-primary/35 to-transparent" />
        <div className="flex items-center gap-2 text-xs font-medium text-primary">
          <span className="flex h-6 w-6 items-center justify-center rounded-full bg-primary/12">
            <ActivityIcon className="h-3.5 w-3.5 animate-pulse" aria-hidden="true" />
          </span>
          Reasoning stream
        </div>
        <div className="mt-3 text-sm text-muted-foreground">
          Waiting for the first reasoning update...
        </div>
      </section>
    );
  }

  if (thoughtSummaries.length === 0) {
    return null;
  }

  return (
    <section
      aria-label="Reasoning stream"
      className="relative overflow-hidden rounded-2xl border border-primary/20 bg-gradient-to-br from-primary/10 via-card/80 to-muted/25 px-5 py-5 shadow-sm shadow-primary/5"
    >
      <div className="pointer-events-none absolute inset-x-6 top-0 h-px bg-gradient-to-r from-transparent via-primary/35 to-transparent" />
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2 text-xs font-medium text-primary">
          <span className="flex h-6 w-6 items-center justify-center rounded-full bg-primary/12">
            <ActivityIcon className="h-3.5 w-3.5 animate-pulse" aria-hidden="true" />
          </span>
          Reasoning stream
        </div>
        <div className="text-[11px] font-medium tabular-nums text-muted-foreground">
          {thoughtSummaries.length} {thoughtSummaries.length === 1 ? "update" : "updates"}
        </div>
      </div>
      <ol className="relative space-y-3 before:absolute before:bottom-2 before:left-[0.5625rem] before:top-2 before:w-px before:bg-primary/20">
        {thoughtSummaries.map((thought, index) => {
          const isLatest = index === thoughtSummaries.length - 1;
          return (
            <li key={thought.id} className="relative grid grid-cols-[1.25rem_1fr] gap-3">
              <span
                className={cn(
                  "relative z-10 mt-1 h-4 w-4 rounded-full border bg-background",
                  isLatest ? "border-primary shadow-[0_0_0_5px_hsl(var(--primary)/0.12)]" : "border-primary/35",
                )}
                aria-hidden="true"
              />
              <div
                className={cn(
                  "rounded-xl border px-3.5 py-3",
                  isLatest ? "border-primary/25 bg-background/80" : "border-border/45 bg-background/55",
                )}
              >
                <div className="mb-1 flex items-center gap-2 text-[11px] font-medium text-muted-foreground">
                  <span className="tabular-nums">Step {index + 1}</span>
                  <span aria-hidden="true">·</span>
                  <span>
                    {new Date(thought.ts).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit", second: "2-digit" })}
                  </span>
                </div>
                <div className="whitespace-pre-wrap text-sm leading-6 text-foreground/90">
                  {thought.text}
                </div>
              </div>
            </li>
          );
        })}
      </ol>
    </section>
  );
}
