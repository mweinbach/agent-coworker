import { memo, useMemo, useState } from "react";
import type { CSSProperties } from "react";

import { ChevronDownIcon, SparklesIcon, Trash2Icon } from "lucide-react";

import { Card, CardContent } from "../../../components/ui/card";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "../../../components/ui/collapsible";
import { cn } from "../../../lib/utils";
import { isBasicCatalogId } from "../../../../../../src/shared/a2ui/component";
import type { FeedItem } from "../../../app/types";
import { A2uiRenderer, type A2uiRenderableComponent } from "./A2uiRenderer";

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
  }
  const background = theme.background;
  if (typeof background === "string") {
    style["--a2ui-background"] = background;
  }
  return style as CSSProperties;
}

export const A2uiSurfaceCard = memo(function A2uiSurfaceCard({ item }: A2uiSurfaceCardProps) {
  const [expanded, setExpanded] = useState(true);
  const themeStyle = useMemo(() => buildThemeStyle(item.theme), [item.theme]);

  const rootComponent = useMemo<A2uiRenderableComponent | null>(() => {
    const root = item.root;
    if (!root || typeof root !== "object" || Array.isArray(root)) return null;
    return root as A2uiRenderableComponent;
  }, [item.root]);

  const unsupportedCatalog = !isBasicCatalogId(item.catalogId);

  if (item.deleted) {
    return (
      <Card className="max-w-3xl border-dashed border-border/60 bg-muted/20">
        <CardContent className="flex items-center gap-2 p-3 text-xs text-muted-foreground">
          <Trash2Icon className="size-3.5" />
          <span>Generative UI surface <code className="font-mono">{item.surfaceId}</code> was deleted.</span>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="max-w-3xl overflow-hidden border-border/50 bg-background/60">
      <Collapsible open={expanded} onOpenChange={setExpanded}>
        <CollapsibleTrigger asChild>
          <button
            type="button"
            className={cn(
              "flex w-full items-center justify-between gap-2 border-b border-border/40 px-3 py-2 text-left transition-colors hover:bg-muted/20",
              !expanded && "border-b-transparent",
            )}
          >
            <span className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.14em] text-muted-foreground">
              <SparklesIcon className="size-3.5 text-primary" />
              Generative UI
              <code className="rounded bg-muted/40 px-1.5 py-0.5 font-mono text-[10px] text-foreground/70">
                {item.surfaceId}
              </code>
              {unsupportedCatalog ? (
                <span className="rounded border border-warning/40 bg-warning/10 px-1.5 py-0.5 text-[10px] font-medium uppercase text-warning">
                  unknown catalog
                </span>
              ) : null}
            </span>
            <ChevronDownIcon
              className={cn(
                "size-3.5 text-muted-foreground transition-transform",
                expanded ? "rotate-0" : "-rotate-90",
              )}
            />
          </button>
        </CollapsibleTrigger>
        <CollapsibleContent>
          <CardContent className="p-3" style={themeStyle}>
            {unsupportedCatalog ? (
              <div className="mb-3 rounded border border-warning/35 bg-warning/[0.08] p-2 text-xs text-warning">
                This surface uses an unsupported catalog. Rendering with best-effort basic primitives — some components may be skipped.
                <div className="mt-1 font-mono text-[10px] text-warning/80">
                  {item.catalogId}
                </div>
              </div>
            ) : null}
            <A2uiRenderer root={rootComponent} dataModel={item.dataModel} interactive={false} />
          </CardContent>
        </CollapsibleContent>
      </Collapsible>
    </Card>
  );
});
