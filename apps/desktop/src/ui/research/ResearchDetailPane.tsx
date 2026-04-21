import { useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { MessageSquareIcon } from "lucide-react";

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

type DetailTab = "report" | "notes" | "sources" | "prompt";

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

function TabButton({
  active,
  children,
  count,
  onClick,
}: {
  active: boolean;
  children: React.ReactNode;
  count?: number;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "flex h-7 items-center gap-1.5 rounded-md px-2.5 text-xs font-medium transition-colors",
        active
          ? "bg-background text-foreground shadow-sm"
          : "text-muted-foreground hover:bg-foreground/[0.04] hover:text-foreground",
      )}
      aria-selected={active}
      role="tab"
    >
      {children}
      {count !== undefined && count > 0 ? (
        <span className="min-w-4 rounded-full bg-muted px-1 text-center text-[10px] tabular-nums text-muted-foreground">
          {count}
        </span>
      ) : null}
    </button>
  );
}

export function ResearchDetailPane({ research }: { research: ResearchDetail | null }) {
  const cancelResearch = useAppStore((s) => s.cancelResearch);
  const exportPendingIds = useAppStore((s) => s.researchExportPendingIds);
  const running = research ? research.status === "running" || research.status === "pending" : false;
  const elapsedMs = useRunningElapsed(research?.createdAt ?? new Date().toISOString(), running);
  const [tab, setTab] = useState<DetailTab>("report");

  useEffect(() => {
    setTab("report");
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

  return (
    <div className="relative flex h-full min-h-0 flex-col">
      <div
        className="flex min-w-0 flex-wrap items-center gap-x-4 gap-y-2 border-b border-border/55 px-4 py-2"
        role="tablist"
      >
        <div className="flex shrink-0 items-center gap-1 overflow-x-auto rounded-lg bg-muted/30 p-0.5">
          <TabButton active={tab === "report"} onClick={() => setTab("report")}>
            Report
          </TabButton>
          <TabButton active={tab === "notes"} count={thoughtCount} onClick={() => setTab("notes")}>
            Notes
          </TabButton>
          <TabButton active={tab === "sources"} count={sourceCount} onClick={() => setTab("sources")}>
            Sources
          </TabButton>
          <TabButton active={tab === "prompt"} onClick={() => setTab("prompt")}>
            Prompt
          </TabButton>
        </div>

        <div className="flex min-w-0 flex-1 basis-0 flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
          <Badge className={cn("shrink-0", statusClassName(research.status))}>
            {statusLabel(research.status)}
          </Badge>
          {running ? (
            <>
              <span className="whitespace-nowrap tabular-nums text-foreground/80">{formatElapsed(elapsedMs)}</span>
              <span aria-hidden="true">·</span>
              <span className="whitespace-nowrap">
                <span className="tabular-nums text-foreground/80">{sourceCount}</span>{" "}
                {sourceCount === 1 ? "source" : "sources"}
              </span>
              <span aria-hidden="true">·</span>
              <span className="whitespace-nowrap">
                <span className="tabular-nums text-foreground/80">{thoughtCount}</span>{" "}
                {thoughtCount === 1 ? "note" : "notes"}
              </span>
            </>
          ) : startedAgo ? (
            <span className="whitespace-nowrap">{startedAgo} ago</span>
          ) : null}
        </div>

        <div className="ml-auto flex shrink-0 items-center gap-2">
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

      <div className="min-h-0 flex-1 overflow-y-auto px-8 py-6">
        <div className="mx-auto flex max-w-4xl flex-col gap-6">
          {research.error && tab !== "prompt" ? (
            <div className="rounded-xl border border-destructive/35 bg-destructive/5 px-3 py-2 text-xs text-destructive">
              {research.error}
            </div>
          ) : null}

          {tab === "report" ? (
            <ResearchReportRenderer
              markdown={research.outputsMarkdown}
              status={research.status}
              sources={research.sources}
            />
          ) : null}

          {tab === "notes" ? (
            <ResearchNotesTab
              thoughtSummaries={research.thoughtSummaries}
              status={research.status}
            />
          ) : null}

          {tab === "sources" ? (
            <ResearchSourcesList sources={research.sources} />
          ) : null}

          {tab === "prompt" ? (
            <section className="rounded-2xl border border-border/55 bg-card/60 px-5 py-5">
              <div className="mb-2 text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
                Prompt
              </div>
              <p className="whitespace-pre-wrap text-sm leading-6 text-foreground/90">
                {research.prompt}
              </p>
            </section>
          ) : null}
        </div>
      </div>

      {research.status === "completed" ? (
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
    <div className="pointer-events-none absolute bottom-4 left-4 right-4 z-30 flex items-end">
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

function ResearchNotesTab({
  thoughtSummaries,
  status,
}: {
  thoughtSummaries: ResearchDetail["thoughtSummaries"];
  status: ResearchDetail["status"];
}) {
  const running = status === "running" || status === "pending";

  if (thoughtSummaries.length === 0 && running) {
    return (
      <div className="rounded-2xl border border-border/65 bg-card/70 px-5 py-5 text-sm text-muted-foreground">
        <div className="mb-2 flex items-center gap-2 text-xs font-medium">
          <span className="h-1.5 w-1.5 rounded-full bg-primary animate-pulse" aria-hidden="true" />
          Waiting for the first progress note…
        </div>
      </div>
    );
  }

  if (thoughtSummaries.length === 0) {
    return (
      <div className="rounded-2xl border border-border/65 bg-card/70 px-4 py-5 text-sm text-muted-foreground">
        No progress notes were captured for this run.
      </div>
    );
  }

  return (
    <ol className="space-y-3">
      {thoughtSummaries.map((thought, index) => (
        <li
          key={thought.id}
          className="rounded-2xl border border-border/60 bg-card/70 px-4 py-3"
        >
          <div className="mb-1 flex items-center gap-2 text-[11px] font-medium uppercase tracking-[0.12em] text-muted-foreground">
            <span className="tabular-nums">Note {index + 1}</span>
            <span aria-hidden="true">·</span>
            <span>{new Date(thought.ts).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit", second: "2-digit" })}</span>
          </div>
          <div className="whitespace-pre-wrap text-sm leading-6 text-foreground/90">
            {thought.text}
          </div>
        </li>
      ))}
    </ol>
  );
}
