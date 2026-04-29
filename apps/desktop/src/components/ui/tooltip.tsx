import * as TooltipPrimitive from "@radix-ui/react-tooltip";
import type * as React from "react";

import { cn } from "@/lib/utils";

type TooltipProviderProps = React.PropsWithChildren<{
  delayDuration?: number;
}>;

type TooltipRootProps = {
  children: React.ReactNode;
  delayDuration?: number;
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
};

function TooltipProvider({ children, delayDuration }: TooltipProviderProps) {
  return (
    <TooltipPrimitive.Provider delayDuration={delayDuration}>
      {children}
    </TooltipPrimitive.Provider>
  );
}

function Tooltip({
  children,
  defaultOpen,
  delayDuration = 200,
  onOpenChange,
  open,
}: TooltipRootProps) {
  return (
    <TooltipPrimitive.Provider delayDuration={delayDuration}>
      <TooltipPrimitive.Root
        defaultOpen={defaultOpen}
        delayDuration={delayDuration}
        open={open}
        onOpenChange={onOpenChange}
      >
        {children}
      </TooltipPrimitive.Root>
    </TooltipPrimitive.Provider>
  );
}

type TooltipTriggerProps = React.ComponentProps<typeof TooltipPrimitive.Trigger> & {
  asChild?: boolean;
};

function TooltipTrigger({ children, className, asChild, ...props }: TooltipTriggerProps) {
  return (
    <TooltipPrimitive.Trigger
      data-slot="tooltip-trigger"
      className={cn(!asChild && "inline-flex", className)}
      asChild={asChild}
      {...props}
    >
      {children}
    </TooltipPrimitive.Trigger>
  );
}

type TooltipContentProps = React.ComponentProps<typeof TooltipPrimitive.Content> & {
  side?: "bottom" | "left" | "right" | "top";
  sideOffset?: number;
};

function TooltipContent({
  className,
  side = "top",
  sideOffset = 4,
  children,
  ...props
}: TooltipContentProps) {
  return (
    <TooltipPrimitive.Portal>
      <TooltipPrimitive.Content
        data-slot="tooltip-content"
        className={cn(
          "app-surface-overlay app-border-subtle app-shadow-overlay z-50 overflow-hidden rounded-[10px] border px-2 py-1 text-xs",
          className,
        )}
        side={side}
        sideOffset={sideOffset}
        {...props}
      >
        {children}
      </TooltipPrimitive.Content>
    </TooltipPrimitive.Portal>
  );
}

export { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger };
