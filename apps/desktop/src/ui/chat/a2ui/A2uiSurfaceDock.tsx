import { memo, useCallback, useEffect, useMemo, useState } from "react";
import type { CSSProperties } from "react";

import {
  ChevronDownIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  ExpandIcon,
  SparklesIcon,
  Trash2Icon,
} from "lucide-react";

import { isBasicCatalogId } from "../../../../../../src/shared/a2ui/component";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "../../../components/ui/dialog";
import { cn } from "../../../lib/utils";
import { useAppStore } from "../../../app/store";
import type { A2uiChangeKind, A2uiSurfaceRevision, A2uiThreadDock } from "../../../app/types";
import { A2uiRenderer, type A2uiActionDispatcher, type A2uiRenderableComponent } from "./A2uiRenderer";
import { extractSurfaceTitle } from "./surfaceTitle";
import { changeKindLabel, changeKindToneClass } from "./changeKind";

function buildThemeStyle(theme?: Record<string, unknown>): CSSProperties | undefined {
  if (!theme) return undefined;
  const style: Record<string, string> = {};
  const primaryColor = theme.primaryColor;
  if (typeof primaryColor === "string") style["--a2ui-primary"] = primaryColor;
  const fontFamily = theme.fontFamily;
  if (typeof fontFamily === "string") {
    style["--a2ui-font-family"] = fontFamily;
    style.fontFamily = fontFamily;
  }
  const background = theme.background;
  if (typeof background === "string") {
    style["--a2ui-background"] = background;
    style.background = background;
  }
  return style as CSSProperties;
}

function toRenderable(root: A2uiSurfaceRevision["root"]): A2uiRenderableComponent | null {
  if (!root || typeof root !== "object" || Array.isArray(root)) return null;
  return root as A2uiRenderableComponent;
}

/**
 * Produce a short "rev 3 of 5 • 2m ago" style caption. Keeps the picker compact
 * and avoids repeating the absolute timestamp, which rarely adds value.
 */
function formatRelativeAge(nowMs: number, tsIso: string): string {
  const ts = Date.parse(tsIso);
  if (!Number.isFinite(ts)) return "";
  const deltaSeconds = Math.max(0, Math.round((nowMs - ts) / 1000));
  if (deltaSeconds < 5) return "just now";
  if (deltaSeconds < 60) return `${deltaSeconds}s ago`;
  const minutes = Math.round(deltaSeconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return `${days}d ago`;
}

export type A2uiSurfaceDockView = {
  surfaceId: string;
  activeRevision: A2uiSurfaceRevision;
  revisions: readonly A2uiSurfaceRevision[];
  activeIndex: number;
  title: string;
  hasUnseen: boolean;
};

/**
 * Given dock state for a thread, compute what (if anything) to render in the
 * dock. Exported for unit testing — keeps the selection logic separate from
 * the React component.
 */
export function selectDockView(dock: A2uiThreadDock): A2uiSurfaceDockView | null {
  const focusedId = dock.focusedSurfaceId;
  if (!focusedId) return null;
  const revisions = dock.revisionsBySurfaceId[focusedId];
  if (!revisions || revisions.length === 0) return null;
  const activeRevNumber = dock.activeRevisionBySurfaceId[focusedId] ?? revisions[revisions.length - 1]!.revision;
  const activeIndex = revisions.findIndex((r) => r.revision === activeRevNumber);
  const resolvedIndex = activeIndex >= 0 ? activeIndex : revisions.length - 1;
  const activeRevision = revisions[resolvedIndex]!;
  const latestRevision = revisions[revisions.length - 1]!;
  const root = toRenderable(activeRevision.root);
  const title = extractSurfaceTitle(root, activeRevision.dataModel) ?? focusedId;
  const lastSeen = dock.lastSeenRevisionBySurfaceId[focusedId] ?? -1;
  const hasUnseen = !activeRevision.deleted && latestRevision.revision > lastSeen;
  return {
    surfaceId: focusedId,
    activeRevision,
    revisions,
    activeIndex: resolvedIndex,
    title,
    hasUnseen,
  };
}

export type A2uiSurfaceDockProps = {
  threadId: string;
};

export const A2uiSurfaceDock = memo(function A2uiSurfaceDock({ threadId }: A2uiSurfaceDockProps) {
  const dock = useAppStore((s) => s.threadRuntimeById[threadId]?.a2uiDock);
  const setExpanded = useAppStore((s) => s.setA2uiDockExpanded);
  const setActiveRevision = useAppStore((s) => s.setA2uiActiveRevision);
  const markSeen = useAppStore((s) => s.markA2uiSurfaceSeen);
  const dispatchA2uiAction = useAppStore((s) => s.dispatchA2uiAction);

  const [poppedOut, setPoppedOut] = useState(false);

  const view = useMemo(() => (dock && dock.focusedSurfaceId ? selectDockView(dock) : null), [dock]);
  const expanded = dock?.expanded ?? false;

  // When the dock opens, mark the latest revision as seen so the pulse fades.
  useEffect(() => {
    if (!view || !dock || !expanded) return;
    const latest = view.revisions[view.revisions.length - 1]!;
    markSeen(threadId, view.surfaceId, latest.revision);
  }, [dock, expanded, markSeen, threadId, view]);

  const onAction = useMemo<A2uiActionDispatcher | undefined>(() => {
    if (!view || view.activeRevision.deleted) return undefined;
    const isLatest = view.activeIndex === view.revisions.length - 1;
    // Disable action dispatch when viewing an older revision — it would target
    // stale component ids and is semantically confusing.
    if (!isLatest) return undefined;
    return async ({ componentId, eventType, payload }) => {
      await dispatchA2uiAction({
        threadId,
        surfaceId: view.surfaceId,
        componentId,
        eventType,
        ...(payload !== undefined ? { payload } : {}),
      });
    };
  }, [dispatchA2uiAction, threadId, view]);

  const toggleExpanded = useCallback(() => {
    if (!view) return;
    setExpanded(threadId, !expanded);
  }, [expanded, setExpanded, threadId, view]);

  const stepRevision = useCallback(
    (direction: -1 | 1) => {
      if (!view) return;
      const nextIndex = Math.max(0, Math.min(view.revisions.length - 1, view.activeIndex + direction));
      if (nextIndex === view.activeIndex) return;
      setActiveRevision(threadId, view.surfaceId, view.revisions[nextIndex]!.revision);
    },
    [setActiveRevision, threadId, view],
  );

  if (!view) return null;

  const root = toRenderable(view.activeRevision.root);
  const themeStyle = buildThemeStyle(view.activeRevision.theme);
  const unsupportedCatalog = !isBasicCatalogId(view.activeRevision.catalogId);
  const isDeleted = view.activeRevision.deleted;
  const isLatest = view.activeIndex === view.revisions.length - 1;
  const canGoPrev = view.activeIndex > 0;
  const canGoNext = view.activeIndex < view.revisions.length - 1;

  return (
    <>
      <div className="mx-auto w-full max-w-[70rem]">
        <div
          className={cn(
            "relative overflow-hidden rounded-t-xl border border-b-0 border-border/35",
            "bg-gradient-to-b from-background to-muted/10",
            "transition-[border-radius] duration-200",
            expanded && "rounded-b-none",
          )}
        >
          <button
            type="button"
            onClick={toggleExpanded}
            aria-expanded={expanded}
            className={cn(
              "group/dockbar flex w-full items-center gap-3 px-3.5 py-2.5 text-left",
              "transition-colors hover:bg-muted/15",
            )}
          >
            <span className="relative flex size-6 flex-none items-center justify-center rounded-md bg-primary/10 text-primary">
              <SparklesIcon className="size-3.5" />
              {view.hasUnseen && !expanded ? (
                <span className="absolute -right-0.5 -top-0.5 flex size-2">
                  <span className="absolute inline-flex size-full animate-ping rounded-full bg-primary/60" />
                  <span className="relative inline-flex size-2 rounded-full bg-primary" />
                </span>
              ) : null}
            </span>
            <span className="flex min-w-0 flex-1 items-center gap-2">
              <span className="min-w-0 flex-1 truncate text-sm font-semibold text-foreground">
                {isDeleted ? (
                  <span className="inline-flex items-center gap-1.5 text-muted-foreground">
                    <Trash2Icon className="size-3.5" />
                    {view.title} <span className="text-xs">(deleted)</span>
                  </span>
                ) : (
                  view.title
                )}
              </span>
              {view.revisions.length > 1 ? (
                <span className="flex-none rounded-full bg-muted/45 px-2 py-0.5 font-mono text-[10px] text-muted-foreground">
                  rev {view.activeRevision.revision}
                  {!isLatest ? " (older)" : null}
                </span>
              ) : null}
              {unsupportedCatalog ? (
                <span className="flex-none rounded-full border border-warning/40 bg-warning/10 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-warning">
                  unknown catalog
                </span>
              ) : null}
              <code className="flex-none rounded-full bg-muted/45 px-2 py-0.5 font-mono text-[10px] text-muted-foreground">
                {view.surfaceId}
              </code>
            </span>
            <span className="flex flex-none items-center gap-1 text-muted-foreground">
              {expanded ? (
                <span
                  role="button"
                  tabIndex={0}
                  aria-label="Open in larger view"
                  title="Open in larger view"
                  onClick={(event) => {
                    event.stopPropagation();
                    event.preventDefault();
                    setPoppedOut(true);
                  }}
                  className="inline-flex size-7 items-center justify-center rounded-md transition-colors hover:bg-muted/30 hover:text-foreground"
                >
                  <ExpandIcon className="size-3.5" />
                </span>
              ) : null}
              <ChevronDownIcon
                className={cn(
                  "size-4 transition-transform duration-200",
                  expanded ? "rotate-180" : "rotate-0",
                )}
              />
            </span>
          </button>

          <div
            className={cn(
              "overflow-hidden transition-[max-height,opacity] duration-200 ease-out",
              expanded ? "max-h-[70vh] opacity-100" : "max-h-0 opacity-0",
            )}
            aria-hidden={!expanded}
          >
            <div className="min-h-0">
              <div className="max-h-[70vh] overflow-y-auto border-t border-border/40 bg-background/60 px-4 py-3" style={themeStyle}>
                {view.revisions.length > 1 ? (
                  <RevisionControls
                    revisions={view.revisions}
                    activeIndex={view.activeIndex}
                    canGoPrev={canGoPrev}
                    canGoNext={canGoNext}
                    onStep={stepRevision}
                    onJumpLatest={() =>
                      setActiveRevision(
                        threadId,
                        view.surfaceId,
                        view.revisions[view.revisions.length - 1]!.revision,
                      )
                    }
                  />
                ) : null}

                {isDeleted ? (
                  <div className="flex items-center gap-2 rounded-md border border-dashed border-border/60 bg-muted/20 px-3 py-2 text-xs text-muted-foreground">
                    <Trash2Icon className="size-3.5" />
                    <span>
                      Surface <code className="font-mono">{view.surfaceId}</code> was deleted at revision {view.activeRevision.revision}.
                    </span>
                  </div>
                ) : (
                  <>
                    {unsupportedCatalog ? (
                      <div className="mb-3 rounded-md border border-warning/35 bg-warning/[0.08] px-3 py-2 text-xs text-warning">
                        This surface uses an unsupported catalog. Rendering with best-effort basic primitives — some components may be skipped.
                        <div className="mt-1 font-mono text-[10px] text-warning/80">{view.activeRevision.catalogId}</div>
                      </div>
                    ) : null}
                    <A2uiRenderer
                      root={root}
                      dataModel={view.activeRevision.dataModel}
                      {...(onAction ? { onAction } : {})}
                    />
                  </>
                )}
              </div>
            </div>
          </div>
        </div>
      </div>
      <Dialog open={poppedOut} onOpenChange={setPoppedOut}>
        <DialogContent showClose className="max-w-5xl">
          <DialogHeader>
            <DialogTitle>
              <span className="flex items-center gap-2 text-sm font-semibold">
                <span className="flex size-6 items-center justify-center rounded-md bg-primary/10 text-primary">
                  <SparklesIcon className="size-3.5" />
                </span>
                {view.title}
              </span>
            </DialogTitle>
          </DialogHeader>
          <div className="max-h-[70vh] overflow-y-auto px-1" style={themeStyle}>
            {isDeleted ? (
              <div className="rounded-md border border-dashed border-border/60 bg-muted/20 px-3 py-2 text-xs text-muted-foreground">
                Surface <code className="font-mono">{view.surfaceId}</code> was deleted at revision {view.activeRevision.revision}.
              </div>
            ) : (
              <A2uiRenderer
                root={root}
                dataModel={view.activeRevision.dataModel}
                {...(onAction ? { onAction } : {})}
              />
            )}
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
});

function RevisionControls({
  revisions,
  activeIndex,
  canGoPrev,
  canGoNext,
  onStep,
  onJumpLatest,
}: {
  revisions: readonly A2uiSurfaceRevision[];
  activeIndex: number;
  canGoPrev: boolean;
  canGoNext: boolean;
  onStep: (direction: -1 | 1) => void;
  onJumpLatest: () => void;
}) {
  const active = revisions[activeIndex]!;
  const relAge = formatRelativeAge(Date.now(), active.ts);
  const kindLabel = changeKindLabel(active.changeKind);
  return (
    <div className="mb-3 flex flex-col gap-1 rounded-md border border-border/25 bg-muted/[0.05] px-2 py-1.5 text-[11px] text-muted-foreground">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1">
          <button
            type="button"
            aria-label="Previous revision"
            title="Previous revision"
            disabled={!canGoPrev}
            onClick={() => onStep(-1)}
            className="inline-flex size-6 items-center justify-center rounded transition-colors hover:bg-muted/40 disabled:cursor-not-allowed disabled:opacity-40"
          >
            <ChevronLeftIcon className="size-3.5" />
          </button>
          <button
            type="button"
            aria-label="Next revision"
            title="Next revision"
            disabled={!canGoNext}
            onClick={() => onStep(1)}
            className="inline-flex size-6 items-center justify-center rounded transition-colors hover:bg-muted/40 disabled:cursor-not-allowed disabled:opacity-40"
          >
            <ChevronRightIcon className="size-3.5" />
          </button>
          <span
            className={cn(
              "ml-1 inline-flex items-center rounded-full border px-1.5 py-0 text-[10px] font-semibold uppercase tracking-wide",
              changeKindToneClass(active.changeKind),
            )}
          >
            {kindLabel}
          </span>
        </div>
        <span className="tabular-nums">
          rev <span className="font-semibold text-foreground/85">{active.revision}</span> · {activeIndex + 1}/{revisions.length}
          {relAge ? <span className="ml-2">{relAge}</span> : null}
        </span>
        {canGoNext ? (
          <button
            type="button"
            onClick={onJumpLatest}
            className="rounded px-1.5 py-0.5 font-medium text-primary transition-colors hover:bg-primary/10"
          >
            Jump to latest
          </button>
        ) : (
          <span className="rounded px-1.5 py-0.5 font-medium text-muted-foreground/70">Latest</span>
        )}
      </div>
      {active.reason ? (
        <div className="truncate pl-1 italic text-muted-foreground/90" title={active.reason}>
          {active.reason}
        </div>
      ) : null}
    </div>
  );
}

export const __internal = {
  selectDockView,
  formatRelativeAge,
};
