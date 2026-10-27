import { TabBar } from "glisse";
import * as React from "react";

import { cn } from "@/lib/utils";

type SegmentedControlItem<Value extends string> = {
  value: Value;
  label: React.ReactNode;
};

type SegmentedControlProps<Value extends string> = {
  items: readonly SegmentedControlItem<Value>[];
  value: Value | null;
  onValueChange: (value: Value) => void;
  /**
   * Preferred width of every segment, as in a native segmented control. Segments
   * shrink evenly (down to a floor) when the container is narrower than that.
   */
  segmentWidth?: number;
  /**
   * Tab/panel linkage: each tab gets the id `segmentedControlTabId(idBase, value)`
   * for the panel's `aria-labelledby`, and `aria-controls={panelId}`.
   */
  idBase?: string;
  panelId?: string;
  "aria-label": string;
  className?: string;
};

// The bar's 3px padding on each side (see `.app-glass-segmented` in glass.css).
const BAR_INLINE_PADDING_PX = 6;
const MIN_SEGMENT_WIDTH_PX = 64;

function segmentedControlTabId(idBase: string, value: string): string {
  return `${idBase}-tab-${value}`;
}

/**
 * Liquid Glass segmented control (glisse TabBar): a draggable lens slides
 * between equal-width segments. glisse renders the tab buttons itself, so their
 * ids and `aria-controls` are applied after each render.
 */
function SegmentedControl<Value extends string>({
  items,
  value,
  onValueChange,
  segmentWidth = 104,
  idBase,
  panelId,
  className,
  "aria-label": ariaLabel,
}: SegmentedControlProps<Value>) {
  const rootRef = React.useRef<HTMLDivElement>(null);
  const [fittedWidth, setFittedWidth] = React.useState(segmentWidth);
  const count = items.length;

  // glisse segments are a fixed width, so a bar that can't fit its container
  // would overflow it instead of wrapping. Shrink segments evenly to fit.
  React.useLayoutEffect(() => {
    const container = rootRef.current?.parentElement;
    if (!container || count === 0) return;
    const fit = () => {
      const available = container.clientWidth;
      if (!available) {
        setFittedWidth(segmentWidth);
        return;
      }
      const evenShare = Math.floor((available - BAR_INLINE_PADDING_PX) / count);
      setFittedWidth(Math.max(MIN_SEGMENT_WIDTH_PX, Math.min(segmentWidth, evenShare)));
    };
    fit();
    const observer = new ResizeObserver(fit);
    observer.observe(container);
    return () => observer.disconnect();
  }, [count, segmentWidth]);

  React.useLayoutEffect(() => {
    if (!idBase && !panelId) return;
    const tabs = rootRef.current?.querySelectorAll<HTMLElement>(".lg-tab") ?? [];
    tabs.forEach((tab, index) => {
      const item = items[index];
      if (!item) return;
      if (idBase) tab.id = segmentedControlTabId(idBase, item.value);
      if (panelId) tab.setAttribute("aria-controls", panelId);
    });
  });

  return (
    // TabBar does not forward refs; `display: contents` keeps the wrapper out of layout.
    <div ref={rootRef} className="contents">
      <TabBar
        data-slot="segmented-control"
        aria-label={ariaLabel}
        items={[...items]}
        value={value}
        onValueChange={(next) => onValueChange(next as Value)}
        className={cn("app-glass-segmented", className)}
        style={{ "--lg-tab-width": `${fittedWidth}px` } as React.CSSProperties}
      />
    </div>
  );
}

export { SegmentedControl, segmentedControlTabId };
