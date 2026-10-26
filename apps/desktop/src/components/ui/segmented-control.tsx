import { TabBar } from "glisse";
import type * as React from "react";

import { cn } from "@/lib/utils";

type SegmentedControlItem<Value extends string> = {
  value: Value;
  label: React.ReactNode;
};

type SegmentedControlProps<Value extends string> = {
  items: readonly SegmentedControlItem<Value>[];
  value: Value | null;
  onValueChange: (value: Value) => void;
  /** Every segment is the same width, as in a native segmented control. */
  segmentWidth?: number;
  "aria-label": string;
  className?: string;
};

/**
 * Liquid Glass segmented control (glisse TabBar): a draggable lens slides
 * between equal-width segments. Pair it with a controlled Radix `Tabs` root when
 * it switches `TabsContent` panels.
 */
function SegmentedControl<Value extends string>({
  items,
  value,
  onValueChange,
  segmentWidth = 104,
  className,
  "aria-label": ariaLabel,
}: SegmentedControlProps<Value>) {
  return (
    <TabBar
      data-slot="segmented-control"
      aria-label={ariaLabel}
      items={[...items]}
      value={value}
      onValueChange={(next) => onValueChange(next as Value)}
      className={cn("app-glass-segmented", className)}
      style={{ "--lg-tab-width": `${segmentWidth}px` } as React.CSSProperties}
    />
  );
}

export type { SegmentedControlItem, SegmentedControlProps };
export { SegmentedControl };
