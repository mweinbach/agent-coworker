import { memo, useCallback, useMemo } from "react";
import type { CSSProperties } from "react";

import { ExpandIcon, SparklesIcon, Trash2Icon } from "lucide-react";

import { isBasicCatalogId } from "../../../../../../src/shared/a2ui/component";
import { cn } from "../../../lib/utils";
import { useAppStore } from "../../../app/store";
import type { FeedItem } from "../../../app/types";
import { A2uiRenderer, type A2uiActionDispatcher, type A2uiRenderableComponent } from "./A2uiRenderer";
import { extractSurfaceTitle } from "./surfaceTitle";
import { changeKindLabel, changeKindToneClass } from "./changeKind";

type UiSurfaceFeedItem = Extract<FeedItem, { kind: "ui_surface" }>;

function toRenderable(root: unknown): A2uiRenderableComponent | null {
  if (!root || typeof root !== "object" || Array.isArray(root)) return null;
  return root as A2uiRenderableComponent;
}

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

/**
 * Rich inline presentation for the latest A2UI surface revision in the chat.
 * Older revisions render as compact history chips. Clicking the card header
 * pins this revision in the floating dock so the user can pop it out into a
 * larger dialog or scrub to a neighboring revision from there.
 */
export const A2uiInlineCard = memo(function A2uiInlineCard({ item }: { item: UiSurfaceFeedItem }) {
  const threadId = useAppStore((s) => s.selectedThreadId);
  const focusA2uiSurface = useAppStore((s) => s.focusA2uiSurface);
  const setA2uiActiveRevision = useAppStore((s) => s.setA2uiActiveRevision);
  const setA2uiDockExpanded = useAppStore((s) => s.setA2uiDockExpanded);
  const dispatchA2uiAction = useAppStore((s) => s.dispatchA2uiAction);

  const rootComponent = useMemo(() => toRenderable(item.root), [item.root]);
  const themeStyle = useMemo(() => buildThemeStyle(item.theme), [item.theme]);
  const title = useMemo(
    () => extractSurfaceTitle(rootComponent, item.dataModel) ?? item.surfaceId,
    [rootComponent, item.dataModel, item.surfaceId],
  );
  const unsupportedCatalog = !isBasicCatalogId(item.catalogId);
  const kindLabel = changeKindLabel(item.changeKind);
  const reason = typeof item.reason === "string" ? item.reason.trim() : "";
  const isDeleted = item.deleted;

  const openInDock = useCallback(() => {
    if (!threadId) return;
    focusA2uiSurface(threadId, item.surfaceId);
    setA2uiActiveRevision(threadId, item.surfaceId, item.revision);
    setA2uiDockExpanded(threadId, true);
  }, [focusA2uiSurface, item.revision, item.surfaceId, setA2uiActiveRevision, setA2uiDockExpanded, threadId]);

  const onAction = useMemo<A2uiActionDispatcher | undefined>(() => {
    if (!threadId || isDeleted) return undefined;
    return async ({ componentId, eventType, payload }) => {
      await dispatchA2uiAction({
        threadId,
        surfaceId: item.surfaceId,
        componentId,
        eventType,
        ...(payload !== undefined ? { payload } : {}),
      });
    };
  }, [dispatchA2uiAction, isDeleted, item.surfaceId, threadId]);

  if (isDeleted) {
    return (
      <div className="w-full max-w-4xl rounded-2xl border border-dashed border-border/40 bg-muted/10">
        <div className="flex items-center gap-2 p-3 text-xs text-muted-foreground">
          <Trash2Icon className="size-3.5" />
          <span>
            Surface <code className="font-mono">{item.surfaceId}</code> was deleted at revision {item.revision}.
          </span>
        </div>
      </div>
    );
  }

  return (
    <div
      className={cn(
        "group/a2ui-inline w-full max-w-4xl overflow-hidden rounded-2xl border border-border/35 bg-card text-card-foreground shadow-sm",
      )}
    >
      <button
        type="button"
        onClick={openInDock}
        aria-label="Pin this revision in the dock"
        className={cn(
          "flex w-full items-center gap-2 border-b border-border/25 bg-muted/[0.03] px-3.5 py-2.5 text-left",
          "transition-colors hover:bg-muted/10",
        )}
      >
        <span className="flex size-6 flex-none items-center justify-center rounded-md bg-primary/10 text-primary">
          <SparklesIcon className="size-3.5" />
        </span>
        <span className="min-w-0 flex-1 truncate text-sm font-semibold text-foreground">{title}</span>
        <span
          className={cn(
            "flex-none rounded-full border px-1.5 py-0 text-[10px] font-semibold uppercase tracking-wide leading-[1.2]",
            changeKindToneClass(item.changeKind),
          )}
        >
          {kindLabel}
        </span>
        {reason ? (
          <span
            className="hidden min-w-0 truncate text-xs italic text-muted-foreground sm:inline"
            title={reason}
          >
            · {reason}
          </span>
        ) : null}
        {unsupportedCatalog ? (
          <span className="flex-none rounded-full border border-warning/40 bg-warning/10 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-warning">
            unknown catalog
          </span>
        ) : null}
        <code className="flex-none rounded-full bg-muted/45 px-2 py-0.5 font-mono text-[10px] text-muted-foreground">
          {item.surfaceId}
        </code>
        <ExpandIcon className="size-3.5 flex-none text-muted-foreground opacity-0 transition-opacity group-hover/a2ui-inline:opacity-100" />
      </button>
      <div className="px-5 py-4 pt-3.5" style={themeStyle}>
        {unsupportedCatalog ? (
          <div className="mb-3 rounded-md border border-warning/35 bg-warning/[0.08] px-3 py-2 text-xs text-warning">
            This surface uses an unsupported catalog. Rendering with best-effort basic primitives — some components may be skipped.
            <div className="mt-1 font-mono text-[10px] text-warning/80">{item.catalogId}</div>
          </div>
        ) : null}
        <A2uiRenderer
          root={rootComponent}
          dataModel={item.dataModel}
          {...(onAction ? { onAction } : {})}
        />
      </div>
    </div>
  );
});
