import * as React from "react";

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

type TooltipContextValue = {
  trigger: React.ReactNode | null;
  delay?: number;
};

const TooltipContext = React.createContext<TooltipContextValue | null>(null);

function TooltipProvider({ children }: TooltipProviderProps) {
  return <>{children}</>;
}

function Tooltip({ children, delayDuration = 200 }: TooltipRootProps) {
  const childArray = React.Children.toArray(children);
  const trigger = childArray[0] ?? null;
  const content = childArray.slice(1);

  return (
    <TooltipContext.Provider value={{ trigger, delay: delayDuration }}>
      {content}
    </TooltipContext.Provider>
  );
}

type TooltipTriggerProps = React.HTMLAttributes<HTMLDivElement> & {
  asChild?: boolean;
};

function TooltipTrigger({ children, className, asChild, ...props }: TooltipTriggerProps) {
  const content = React.Children.only(children) as React.ReactElement<React.HTMLAttributes<HTMLElement>>;
  if (asChild) {
    return React.cloneElement(content, {
      ...content.props,
      ...props,
      className: cn(content.props.className, className),
    });
  }

  return (
    <div data-slot="tooltip-trigger" className={cn("inline-flex", className)} {...props}>
      {children}
    </div>
  );
}

type TooltipContentProps = React.HTMLAttributes<HTMLDivElement> & {
  sideOffset?: number;
};

function TooltipContent({ className, sideOffset = 4, children, ...props }: TooltipContentProps) {
  const tooltipState = React.useContext(TooltipContext);

  if (!tooltipState) {
    throw new Error("TooltipContent must be rendered within Tooltip.");
  }

  return (
    <div className="relative inline-flex">
      {tooltipState.trigger}
      <div
        data-slot="tooltip-content"
        className={cn(
          "absolute bottom-full left-1/2 z-50 mb-1.5 max-w-60 -translate-x-1/2 rounded-md border border-border bg-popover px-3 py-2 text-xs text-popover-foreground shadow-md",
          className,
        )}
        style={{ marginBottom: sideOffset }}
        {...props}
      >
        {children}
      </div>
    </div>
  );
}

export { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger };
