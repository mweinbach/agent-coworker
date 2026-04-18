import { memo, useMemo } from "react";

import { SparklesIcon, Trash2Icon } from "lucide-react";

import { cn } from "../../../lib/utils";
import { useAppStore } from "../../../app/store";
import type { FeedItem } from "../../../app/types";
import type { A2uiRenderableComponent } from "./A2uiRenderer";
import { extractSurfaceTitle } from "./surfaceTitle";

type UiSurfaceFeedItem = Extract<FeedItem, { kind: "ui_surface" }>;

export type A2uiSurfaceHistoryRowProps = {
  item: UiSurfaceFeedItem;
};

function toRenderable(root: unknown): A2uiRenderableComponent | null {
  if (!root || typeof root !== "object" || Array.isArray(root)) return null;
  return root as A2uiRenderableComponent;
}

/**
 * Compact inline feed entry that announces an A2UI surface event without
 * re-rendering the full surface. Clicking it focuses the dock on that surface
 * and opens the accordion.
 */
export const A2uiSurfaceHistoryRow = memo(function A2uiSurfaceHistoryRow({
  item,
}: A2uiSurfaceHistoryRowProps) {
  const focusA2uiSurface = useAppStore((s) => s.focusA2uiSurface);
  const setA2uiDockExpanded = useAppStore((s) => s.setA2uiDockExpanded);
  const threadId = useAppStore((s) => s.selectedThreadId);
  const revisions = useAppStore((s) =>
    threadId ? s.threadRuntimeById[threadId]?.a2uiDock.revisionsBySurfaceId[item.surfaceId] : undefined,
  );

  const title = useMemo(() => {
    const root = toRenderable(item.root);
    return extractSurfaceTitle(root, item.dataModel) ?? item.surfaceId;
  }, [item.dataModel, item.root, item.surfaceId]);

  const isDeleted = item.deleted;
  const revisionCount = revisions?.length ?? 0;
  const label = isDeleted
    ? "Surface deleted"
    : revisionCount > 1
      ? `Updated · rev ${item.revision}`
      : `New surface · rev ${item.revision}`;

  const onClick = () => {
    if (!threadId) return;
    focusA2uiSurface(threadId, item.surfaceId);
    setA2uiDockExpanded(threadId, true);
  };

  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "group/a2ui-row inline-flex max-w-full items-center gap-2.5 rounded-full border border-border/45 bg-muted/15 py-1 pl-2 pr-3",
        "text-xs text-foreground/90 shadow-sm transition-colors hover:border-border/65 hover:bg-muted/30",
        isDeleted && "text-muted-foreground",
      )}
      title={`Focus ${title} in dock (rev ${item.revision})`}
    >
      <span
        className={cn(
          "flex size-5 flex-none items-center justify-center rounded-full",
          isDeleted ? "bg-muted/50 text-muted-foreground" : "bg-primary/10 text-primary",
        )}
      >
        {isDeleted ? <Trash2Icon className="size-3" /> : <SparklesIcon className="size-3" />}
      </span>
      <span className="truncate font-medium">{title}</span>
      <span className="flex-none text-[10px] uppercase tracking-wide text-muted-foreground">{label}</span>
    </button>
  );
});
