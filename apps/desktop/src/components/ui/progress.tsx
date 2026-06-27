"use client";

import { Progress as ProgressPrimitive } from "radix-ui";
import type * as React from "react";

import { cn } from "@/lib/utils";

type ProgressProps = React.ComponentProps<typeof ProgressPrimitive.Root> & {
  /**
   * Render an indeterminate bar instead of a determinate fill. Use this when
   * no real percentage is known — it is honest about the unknown total and
   * avoids faking progress. The element exposes `aria-busy="true"` and a
   * `progressbar` role with no `aria-valuenow`, matching the WAI-ARIA
   * indeterminate pattern.
   */
  indeterminate?: boolean;
};

function Progress({ className, value, indeterminate = false, ...props }: ProgressProps) {
  return (
    <ProgressPrimitive.Root
      data-slot="progress"
      className={cn("relative h-2 w-full overflow-hidden rounded-full bg-primary/20", className)}
      {...(indeterminate ? { "aria-busy": true, role: "progressbar" } : { value })}
      {...props}
    >
      {indeterminate ? (
        <div
          data-slot="progress-indeterminate"
          aria-hidden="true"
          className="absolute inset-y-0 left-0 w-1/3 bg-primary app-progress-indeterminate"
        />
      ) : (
        <ProgressPrimitive.Indicator
          data-slot="progress-indicator"
          className="h-full w-full flex-1 bg-primary transition-all"
          style={{ transform: `translateX(-${100 - (value || 0)}%)` }}
        />
      )}
    </ProgressPrimitive.Root>
  );
}

export { Progress };
