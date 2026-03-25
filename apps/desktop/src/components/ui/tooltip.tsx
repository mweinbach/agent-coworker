import * as React from "react";
import { Tooltip as HeroTooltip } from "@heroui/react";

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

function TooltipProvider({ children }: TooltipProviderProps) {
  return <>{children}</>;
}

function Tooltip({
  children,
  defaultOpen,
  delayDuration = 200,
  onOpenChange,
  open,
}: TooltipRootProps) {
  return (
    <HeroTooltip
      defaultOpen={defaultOpen}
      delay={delayDuration}
      isOpen={open}
      onOpenChange={onOpenChange}
    >
      {children}
    </HeroTooltip>
  );
}

type TooltipTriggerProps = React.ComponentProps<typeof HeroTooltip.Trigger> & {
  asChild?: boolean;
};

function TooltipTrigger({ children, className, asChild, ...props }: TooltipTriggerProps) {
  return (
    <HeroTooltip.Trigger
      data-slot="tooltip-trigger"
      className={cn(!asChild && "inline-flex", className)}
      {...props}
    >
      {children}
    </HeroTooltip.Trigger>
  );
}

type TooltipContentProps = React.ComponentProps<typeof HeroTooltip.Content> & {
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
    <HeroTooltip.Content
      data-slot="tooltip-content"
      className={cn("app-surface-overlay app-border-subtle app-shadow-overlay rounded-[10px] border px-2 py-1 text-xs", className)}
      offset={sideOffset}
      placement={side}
      {...props}
    >
      {children}
    </HeroTooltip.Content>
  );
}

export { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger };
