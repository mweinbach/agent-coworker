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
  contentId: string;
  delayDuration: number;
  open: boolean;
  setContentId: (id: string) => void;
  setOpen: (open: boolean) => void;
  setTriggerNode: (node: HTMLElement | null) => void;
  triggerNode: HTMLElement | null;
};

const TooltipContext = React.createContext<TooltipContextValue | null>(null);
const TooltipProviderContext = React.createContext<TooltipProviderProps | null>(null);

function TooltipProvider({ children, delayDuration }: TooltipProviderProps) {
  const value = React.useMemo(() => ({ delayDuration }), [delayDuration]);
  return (
    <TooltipProviderContext.Provider value={value}>{children}</TooltipProviderContext.Provider>
  );
}

function Tooltip({ children, defaultOpen, delayDuration, onOpenChange, open }: TooltipRootProps) {
  const provider = React.useContext(TooltipProviderContext);
  const generatedContentId = React.useId();
  const [contentId, setContentId] = React.useState(generatedContentId);
  const [uncontrolledOpen, setUncontrolledOpen] = React.useState(defaultOpen ?? false);
  const [triggerNode, setTriggerNode] = React.useState<HTMLElement | null>(null);
  const resolvedDelayDuration = delayDuration ?? provider?.delayDuration ?? 200;
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
      value={{
        contentId,
        delayDuration: resolvedDelayDuration,
        open: isOpen,
        setContentId,
        setOpen,
        setTriggerNode,
        triggerNode,
      }}
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
  onKeyDown,
  onMouseEnter,
  onMouseLeave,
  ...props
}: TooltipTriggerProps) {
  const { contentId, delayDuration, open, setOpen, setTriggerNode } = useTooltipContext();
  const timeoutRef = React.useRef<number | null>(null);
  const describedBy = props["aria-describedby"];
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
    "aria-describedby": open ? cn(describedBy, contentId) : describedBy,
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
    onKeyDown: (event: React.KeyboardEvent<HTMLButtonElement>) => {
      onKeyDown?.(event);
      if (!event.defaultPrevented && event.key === "Escape" && open) {
        event.preventDefault();
        event.stopPropagation();
        close();
      }
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
      onKeyDown: (event: React.KeyboardEvent<HTMLElement>) => {
        child.props.onKeyDown?.(event);
        onKeyDown?.(event as React.KeyboardEvent<HTMLButtonElement>);
        if (!event.defaultPrevented && event.key === "Escape" && open) {
          event.preventDefault();
          event.stopPropagation();
          close();
        }
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
  const { contentId, open, setContentId, triggerNode } = useTooltipContext();
  const contentRef = React.useRef<HTMLDivElement | null>(null);
  const [position, setPosition] = React.useState({ left: 16, top: 16 });
  const id = props.id ?? contentId;

  React.useEffect(() => {
    setContentId(id);
  }, [id, setContentId]);

  const updatePosition = React.useCallback(() => {
    if (!triggerNode || typeof window === "undefined") {
      return;
    }

    const rect = triggerNode.getBoundingClientRect();
    const centerX = rect.left + rect.width / 2;
    const centerY = rect.top + rect.height / 2;
    const viewportPadding = 8;
    const contentRect = contentRef.current?.getBoundingClientRect();
    const contentWidth = contentRect?.width ?? 0;
    const contentHeight = contentRect?.height ?? 0;
    const nextPosition =
      side === "bottom"
        ? { left: centerX - contentWidth / 2, top: rect.bottom + sideOffset }
        : side === "left"
          ? { left: rect.left - sideOffset - contentWidth, top: centerY - contentHeight / 2 }
          : side === "right"
            ? { left: rect.right + sideOffset, top: centerY - contentHeight / 2 }
            : { left: centerX - contentWidth / 2, top: rect.top - sideOffset - contentHeight };

    setPosition({
      left: Math.max(
        viewportPadding,
        Math.min(window.innerWidth - viewportPadding - contentWidth, nextPosition.left),
      ),
      top: Math.max(
        viewportPadding,
        Math.min(window.innerHeight - viewportPadding - contentHeight, nextPosition.top),
      ),
    });
  }, [side, sideOffset, triggerNode]);

  React.useLayoutEffect(() => {
    if (!open) {
      return;
    }
    updatePosition();
  }, [open, updatePosition]);

  React.useEffect(() => {
    if (!open || typeof window === "undefined") {
      return;
    }

    window.addEventListener("resize", updatePosition);
    window.addEventListener("scroll", updatePosition, true);
    return () => {
      window.removeEventListener("resize", updatePosition);
      window.removeEventListener("scroll", updatePosition, true);
    };
  }, [open, updatePosition]);

  if (!open || typeof document === "undefined") {
    return null;
  }

  return createPortal(
    <div
      ref={contentRef}
      id={id}
      data-slot="tooltip-content"
      data-side={side}
      role="tooltip"
      className={cn(
        "app-surface-overlay app-border-subtle app-shadow-overlay pointer-events-none fixed z-50 max-w-xs overflow-hidden rounded-[10px] border px-2 py-1 text-xs",
        className,
      )}
      {...props}
      style={{
        left: position.left,
        top: position.top,
        ...props.style,
      }}
    >
      {children}
    </div>,
    document.body,
  );
}

export { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger };
