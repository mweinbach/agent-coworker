import * as React from "react";
import { createPortal } from "react-dom";

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
  delayDuration: number;
  open: boolean;
  setOpen: (open: boolean) => void;
  setTriggerNode: (node: HTMLElement | null) => void;
  triggerNode: HTMLElement | null;
};

const TooltipContext = React.createContext<TooltipContextValue | null>(null);

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
  const [uncontrolledOpen, setUncontrolledOpen] = React.useState(defaultOpen ?? false);
  const [triggerNode, setTriggerNode] = React.useState<HTMLElement | null>(null);
  const isOpen = open ?? uncontrolledOpen;
  const setOpen = React.useCallback(
    (nextOpen: boolean) => {
      if (open === undefined) {
        setUncontrolledOpen(nextOpen);
      }
      onOpenChange?.(nextOpen);
    },
    [onOpenChange, open],
  );

  return (
    <TooltipContext.Provider
      value={{ delayDuration, open: isOpen, setOpen, setTriggerNode, triggerNode }}
    >
      {children}
    </TooltipContext.Provider>
  );
}

function useTooltipContext(): TooltipContextValue {
  const context = React.useContext(TooltipContext);
  if (!context) {
    throw new Error("Tooltip components must be rendered within <Tooltip>");
  }
  return context;
}

type TooltipTriggerProps = React.ComponentProps<"button"> & {
  asChild?: boolean;
};

function TooltipTrigger({
  children,
  className,
  asChild,
  onBlur,
  onFocus,
  onMouseEnter,
  onMouseLeave,
  ...props
}: TooltipTriggerProps) {
  const { delayDuration, open, setOpen, setTriggerNode } = useTooltipContext();
  const timeoutRef = React.useRef<number | null>(null);
  const setNodeRef = React.useCallback(
    (node: HTMLElement | null) => {
      setTriggerNode(node);
    },
    [setTriggerNode],
  );
  const clearOpenTimer = React.useCallback(() => {
    if (timeoutRef.current !== null) {
      window.clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    }
  }, []);
  const openWithDelay = React.useCallback(() => {
    clearOpenTimer();
    if (delayDuration <= 0) {
      setOpen(true);
      return;
    }
    timeoutRef.current = window.setTimeout(() => setOpen(true), delayDuration);
  }, [clearOpenTimer, delayDuration, setOpen]);
  const close = React.useCallback(() => {
    clearOpenTimer();
    setOpen(false);
  }, [clearOpenTimer, setOpen]);

  React.useEffect(() => clearOpenTimer, [clearOpenTimer]);

  const triggerProps = {
    ...props,
    "aria-expanded": open,
    "data-slot": "tooltip-trigger",
    className: cn(!asChild && "inline-flex", className),
    onBlur: (event: React.FocusEvent<HTMLButtonElement>) => {
      onBlur?.(event);
      close();
    },
    onFocus: (event: React.FocusEvent<HTMLButtonElement>) => {
      onFocus?.(event);
      openWithDelay();
    },
    onMouseEnter: (event: React.MouseEvent<HTMLButtonElement>) => {
      onMouseEnter?.(event);
      openWithDelay();
    },
    onMouseLeave: (event: React.MouseEvent<HTMLButtonElement>) => {
      onMouseLeave?.(event);
      close();
    },
  } as const;

  if (asChild && React.isValidElement(children)) {
    const child = children as React.ReactElement<React.HTMLAttributes<HTMLElement>>;
    const childRef = (child as React.ReactElement & { ref?: React.Ref<HTMLElement> }).ref;

    return React.cloneElement(child, {
      ...triggerProps,
      className: cn(child.props.className, className),
      onBlur: (event: React.FocusEvent<HTMLElement>) => {
        child.props.onBlur?.(event);
        onBlur?.(event as React.FocusEvent<HTMLButtonElement>);
        close();
      },
      onFocus: (event: React.FocusEvent<HTMLElement>) => {
        child.props.onFocus?.(event);
        onFocus?.(event as React.FocusEvent<HTMLButtonElement>);
        openWithDelay();
      },
      onMouseEnter: (event: React.MouseEvent<HTMLElement>) => {
        child.props.onMouseEnter?.(event);
        onMouseEnter?.(event as React.MouseEvent<HTMLButtonElement>);
        openWithDelay();
      },
      onMouseLeave: (event: React.MouseEvent<HTMLElement>) => {
        child.props.onMouseLeave?.(event);
        onMouseLeave?.(event as React.MouseEvent<HTMLButtonElement>);
        close();
      },
      ref: (node: HTMLElement | null) => {
        setNodeRef(node);
        if (typeof childRef === "function") {
          childRef(node);
        } else if (childRef && "current" in childRef) {
          (childRef as React.MutableRefObject<HTMLElement | null>).current = node;
        }
      },
    } as React.HTMLAttributes<HTMLElement>);
  }

  return (
    <button ref={setNodeRef} type="button" {...triggerProps}>
      {children}
    </button>
  );
}

type TooltipContentProps = React.ComponentProps<"div"> & {
  align?: "center" | "end" | "start";
  side?: "bottom" | "left" | "right" | "top";
  sideOffset?: number;
};

function TooltipContent({
  className,
  align: _align = "center",
  side = "top",
  sideOffset = 4,
  children,
  ...props
}: TooltipContentProps) {
  const { open, triggerNode } = useTooltipContext();
  const [position, setPosition] = React.useState({ left: 16, top: 16 });

  React.useLayoutEffect(() => {
    if (!open || !triggerNode || typeof window === "undefined") {
      return;
    }

    const rect = triggerNode.getBoundingClientRect();
    const centerX = rect.left + rect.width / 2;
    const centerY = rect.top + rect.height / 2;
    const viewportPadding = 8;
    const nextPosition =
      side === "bottom"
        ? { left: centerX, top: rect.bottom + sideOffset }
        : side === "left"
          ? { left: rect.left - sideOffset, top: centerY }
          : side === "right"
            ? { left: rect.right + sideOffset, top: centerY }
            : { left: centerX, top: rect.top - sideOffset };

    setPosition({
      left: Math.max(
        viewportPadding,
        Math.min(window.innerWidth - viewportPadding, nextPosition.left),
      ),
      top: Math.max(
        viewportPadding,
        Math.min(window.innerHeight - viewportPadding, nextPosition.top),
      ),
    });
  }, [open, side, sideOffset, triggerNode]);

  if (!open || typeof document === "undefined") {
    return null;
  }

  return createPortal(
    <div
      data-slot="tooltip-content"
      data-side={side}
      className={cn(
        "app-surface-overlay app-border-subtle app-shadow-overlay pointer-events-none fixed z-50 max-w-xs overflow-hidden rounded-[10px] border px-2 py-1 text-xs",
        className,
      )}
      {...props}
      style={{
        left: position.left,
        top: position.top,
        transform:
          side === "bottom"
            ? "translate(-50%, 0)"
            : side === "left"
              ? "translate(-100%, -50%)"
              : side === "right"
                ? "translate(0, -50%)"
                : "translate(-50%, -100%)",
        ...props.style,
      }}
    >
      {children}
    </div>,
    document.body,
  );
}

export { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger };
