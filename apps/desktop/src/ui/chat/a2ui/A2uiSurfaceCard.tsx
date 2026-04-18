import { memo, useMemo, useState } from "react";
import type { CSSProperties } from "react";

import { ChevronDownIcon, ExpandIcon, SparklesIcon, Trash2Icon } from "lucide-react";

import { Card, CardContent } from "../../../components/ui/card";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "../../../components/ui/collapsible";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "../../../components/ui/dialog";
import { cn } from "../../../lib/utils";
import { isBasicCatalogId } from "../../../../../../src/shared/a2ui/component";
import { stringifyDynamic } from "../../../../../../src/shared/a2ui/expressions";
import { resolveDynamicWithFunctions } from "../../../../../../src/shared/a2ui/functions";
import { useAppStore } from "../../../app/store";
import type { FeedItem } from "../../../app/types";
import { A2uiRenderer, type A2uiActionDispatcher, type A2uiRenderableComponent } from "./A2uiRenderer";

type UiSurfaceFeedItem = Extract<FeedItem, { kind: "ui_surface" }>;

type A2uiSurfaceCardProps = {
  item: UiSurfaceFeedItem;
};

/**
 * Convert `theme` to CSS custom properties scoped to the card. We accept a
 * permissive list of keys and silently ignore the rest to avoid leaking theme
 * data into the host styling.
 */
function buildThemeStyle(theme?: Record<string, unknown>): CSSProperties | undefined {
  if (!theme) return undefined;
  const style: Record<string, string> = {};
  const primaryColor = theme.primaryColor;
  if (typeof primaryColor === "string") {
    style["--a2ui-primary"] = primaryColor;
  }
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

function extractSurfaceTitle(root: A2uiRenderableComponent | null, dataModel: unknown): string | null {
  if (!root) return null;
  const queue: A2uiRenderableComponent[] = [root];
  let bestHeading: { text: string; level: number } | null = null;
  let fallbackText: string | null = null;
  while (queue.length > 0) {
    const current = queue.shift()!;
    if (
      (current.type === "Heading" || current.type === "Text" || current.type === "Paragraph")
      && current.props
      && typeof current.props === "object"
    ) {
      const props = current.props as Record<string, unknown>;
      const text = stringifyDynamic(
        resolveDynamicWithFunctions(props.text ?? props.label ?? props.value, dataModel),
      ).trim();
      if (text) {
        if (current.type === "Heading") {
          const rawLevel = Number(props.level);
          const level = Number.isFinite(rawLevel) ? Math.min(Math.max(rawLevel, 1), 6) : 2;
          if (!bestHeading || level < bestHeading.level) {
            bestHeading = { text, level };
            if (level === 1) return text;
          }
        } else if (!fallbackText) {
          fallbackText = text;
        }
      }
    }
    if (Array.isArray(current.children)) {
      for (const child of current.children) {
        if (child && typeof child === "object" && !Array.isArray(child)) {
          queue.push(child as A2uiRenderableComponent);
        }
      }
    }
  }
  return bestHeading?.text ?? fallbackText;
}

export const A2uiSurfaceCard = memo(function A2uiSurfaceCard({ item }: A2uiSurfaceCardProps) {
  const [expanded, setExpanded] = useState(true);
  const [poppedOut, setPoppedOut] = useState(false);
  const themeStyle = useMemo(() => buildThemeStyle(item.theme), [item.theme]);

  const selectedThreadId = useAppStore((s) => s.selectedThreadId);
  const dispatchA2uiAction = useAppStore((s) => s.dispatchA2uiAction);

  const onAction = useMemo<A2uiActionDispatcher | undefined>(() => {
    if (!selectedThreadId || item.deleted) return undefined;
    return async ({ componentId, eventType, payload }) => {
      await dispatchA2uiAction({
        threadId: selectedThreadId,
        surfaceId: item.surfaceId,
        componentId,
        eventType,
        ...(payload !== undefined ? { payload } : {}),
      });
    };
  }, [dispatchA2uiAction, item.deleted, item.surfaceId, selectedThreadId]);


  const rootComponent = useMemo<A2uiRenderableComponent | null>(() => {
    const root = item.root;
    if (!root || typeof root !== "object" || Array.isArray(root)) return null;
    return root as A2uiRenderableComponent;
  }, [item.root]);
  const surfaceTitle = useMemo(
    () => extractSurfaceTitle(rootComponent, item.dataModel) ?? item.surfaceId,
    [item.dataModel, item.surfaceId, rootComponent],
  );

  const unsupportedCatalog = !isBasicCatalogId(item.catalogId);

  if (item.deleted) {
    return (
      <Card className="w-full max-w-4xl border-dashed border-border/60 bg-muted/20">
        <CardContent className="flex items-center gap-2 p-3 text-xs text-muted-foreground">
          <Trash2Icon className="size-3.5" />
          <span>Generative UI surface <code className="font-mono">{item.surfaceId}</code> was deleted.</span>
        </CardContent>
      </Card>
    );
  }

  return (
    <>
      <Card
        className={cn(
          "group/a2ui w-full max-w-4xl overflow-hidden border-border/45 shadow-sm",
          "bg-gradient-to-b from-background to-muted/10",
        )}
      >
        <Collapsible open={expanded} onOpenChange={setExpanded}>
          <div
            className={cn(
              "flex items-center gap-1 pr-2 transition-colors",
              expanded ? "border-b border-border/35 bg-muted/[0.06]" : "bg-transparent",
            )}
          >
            <CollapsibleTrigger asChild>
              <button
                type="button"
                className="flex flex-1 items-center gap-3 px-4 py-2.5 text-left transition-colors hover:bg-muted/15"
              >
                <span className="flex size-6 flex-none items-center justify-center rounded-md bg-primary/10 text-primary">
                  <SparklesIcon className="size-3.5" />
                </span>
                <span className="flex min-w-0 flex-1 items-center gap-2">
                  <span className="min-w-0 flex-1 truncate text-sm font-semibold text-foreground">
                    {surfaceTitle}
                  </span>
                  {unsupportedCatalog ? (
                    <span className="flex-none rounded-full border border-warning/40 bg-warning/10 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-warning">
                      unknown catalog
                    </span>
                  ) : null}
                  <code className="flex-none rounded-full bg-muted/45 px-2 py-0.5 font-mono text-[10px] text-muted-foreground">
                    {item.surfaceId}
                  </code>
                </span>
                <ChevronDownIcon
                  className={cn(
                    "size-3.5 flex-none text-muted-foreground transition-transform duration-150",
                    expanded ? "rotate-0" : "-rotate-90",
                  )}
                />
              </button>
            </CollapsibleTrigger>
            <button
              type="button"
              title="Open in larger view"
              aria-label="Open in larger view"
              onClick={() => setPoppedOut(true)}
              className="inline-flex size-7 items-center justify-center rounded-md text-muted-foreground/70 opacity-0 transition-all hover:bg-muted/30 hover:text-foreground group-hover/a2ui:opacity-100 focus-visible:opacity-100"
            >
              <ExpandIcon className="size-3.5" />
            </button>
          </div>
          <CollapsibleContent>
            <CardContent className="p-4 pt-3.5" style={themeStyle}>
              {unsupportedCatalog ? (
                <div className="mb-3 rounded-md border border-warning/35 bg-warning/[0.08] px-3 py-2 text-xs text-warning">
                  This surface uses an unsupported catalog. Rendering with best-effort basic primitives — some components may be skipped.
                  <div className="mt-1 font-mono text-[10px] text-warning/80">
                    {item.catalogId}
                  </div>
                </div>
              ) : null}
              <A2uiRenderer
                root={rootComponent}
                dataModel={item.dataModel}
                {...(onAction ? { onAction } : {})}
              />
            </CardContent>
          </CollapsibleContent>
        </Collapsible>
      </Card>
      <Dialog open={poppedOut} onOpenChange={setPoppedOut}>
        <DialogContent showClose className="max-w-5xl">
          <DialogHeader>
            <DialogTitle>
              <span className="flex items-center gap-2 text-sm font-semibold">
                <span className="flex size-6 items-center justify-center rounded-md bg-primary/10 text-primary">
                  <SparklesIcon className="size-3.5" />
                </span>
                {surfaceTitle}
              </span>
            </DialogTitle>
          </DialogHeader>
          <div className="max-h-[70vh] overflow-y-auto px-1" style={themeStyle}>
            {unsupportedCatalog ? (
              <div className="mb-3 rounded-md border border-warning/35 bg-warning/[0.08] px-3 py-2 text-xs text-warning">
                Unsupported catalog: <span className="font-mono text-[10px] text-warning/80">{item.catalogId}</span>
              </div>
            ) : null}
            <A2uiRenderer
              root={rootComponent}
              dataModel={item.dataModel}
              {...(onAction ? { onAction } : {})}
            />
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
});

export const __internal = {
  extractSurfaceTitle,
};
