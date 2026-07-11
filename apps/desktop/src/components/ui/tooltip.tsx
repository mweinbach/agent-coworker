import { Tooltip as TooltipPrimitive } from "radix-ui";
import type * as React from "react";
import { createContext, useContext } from "react";

import { cn } from "@/lib/utils";
import {
  type OverlayOwnership,
  type OverlayRootState,
  useOverlayOwner,
  useOverlayRootState,
} from "@/ui/OverlayStack";

type TooltipOverlayState = OverlayRootState & {
  ownership: OverlayOwnership | null;
};

const TooltipOverlayContext = createContext<TooltipOverlayState | null>(null);

function TooltipProvider({
  delayDuration = 300,
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Provider>) {
  return (
    <TooltipPrimitive.Provider
      data-slot="tooltip-provider"
      delayDuration={delayDuration}
      {...props}
    />
  );
}

function Tooltip({
  defaultOpen,
  onOpenChange,
  open,
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Root>) {
  const state = useOverlayRootState({ defaultOpen, onOpenChange, open });
  const ownership = useOverlayOwner({
    active: state.open,
    label: "Tooltip",
    onDismiss: () => state.setOpen(false),
    restoreFocus: () => state.restoreFocusRef.current,
  });
  return (
    <TooltipOverlayContext.Provider value={{ ...state, ownership }}>
      <TooltipPrimitive.Root
        data-slot="tooltip"
        open={state.open}
        onOpenChange={state.setOpen}
        {...props}
      />
    </TooltipOverlayContext.Provider>
  );
}

function TooltipTrigger({ ...props }: React.ComponentProps<typeof TooltipPrimitive.Trigger>) {
  return <TooltipPrimitive.Trigger data-slot="tooltip-trigger" {...props} />;
}

function TooltipContent({
  className,
  sideOffset = 0,
  children,
  onEscapeKeyDown,
  style,
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Content>) {
  const owner = useContext(TooltipOverlayContext);
  const ownership = owner?.ownership;

  return (
    <TooltipPrimitive.Portal
      container={typeof globalThis.document === "undefined" ? undefined : globalThis.document.body}
    >
      <TooltipPrimitive.Content
        data-slot="tooltip-content"
        sideOffset={sideOffset}
        className={cn(
          "z-50 w-fit origin-(--radix-tooltip-content-transform-origin) animate-in rounded-md bg-foreground px-3 py-1.5 text-xs text-balance text-background fade-in-0 zoom-in-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95",
          className,
        )}
        style={{ ...style, zIndex: ownership?.zIndex ?? style?.zIndex }}
        onEscapeKeyDown={(event) => {
          onEscapeKeyDown?.(event);
          ownership?.handleEscape(event);
        }}
        {...props}
      >
        {children}
        <TooltipPrimitive.Arrow className="z-50 size-2.5 translate-y-[calc(-50%_-_2px)] rotate-45 rounded-[2px] bg-foreground fill-foreground" />
      </TooltipPrimitive.Content>
    </TooltipPrimitive.Portal>
  );
}

export { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger };
