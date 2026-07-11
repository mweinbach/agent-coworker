import { Popover as PopoverPrimitive } from "radix-ui";
import type * as React from "react";
import { createContext, useContext } from "react";

import { cn } from "@/lib/utils";
import {
  OverlayLayerBoundary,
  type OverlayRootState,
  useOverlayOwner,
  useOverlayRootState,
} from "@/ui/OverlayStack";

const PopoverOverlayContext = createContext<OverlayRootState | null>(null);

function Popover({
  defaultOpen,
  onOpenChange,
  open,
  ...props
}: React.ComponentProps<typeof PopoverPrimitive.Root>) {
  const state = useOverlayRootState({ defaultOpen, onOpenChange, open });
  return (
    <PopoverOverlayContext.Provider value={state}>
      <OverlayLayerBoundary>
        <PopoverPrimitive.Root
          data-slot="popover"
          open={state.open}
          onOpenChange={state.setOpen}
          {...props}
        />
      </OverlayLayerBoundary>
    </PopoverOverlayContext.Provider>
  );
}

function PopoverTrigger({ ...props }: React.ComponentProps<typeof PopoverPrimitive.Trigger>) {
  return <PopoverPrimitive.Trigger data-slot="popover-trigger" {...props} />;
}

function getPortalContainer() {
  return typeof globalThis.document === "undefined" ? undefined : globalThis.document.body;
}

function PopoverContent({
  className,
  align = "center",
  sideOffset = 4,
  onEscapeKeyDown,
  ...props
}: React.ComponentProps<typeof PopoverPrimitive.Content>) {
  const owner = useContext(PopoverOverlayContext);
  const ownership = useOverlayOwner({
    active: owner?.open ?? false,
    label: "Popover",
    onDismiss: () => owner?.setOpen(false),
    restoreFocus: () => owner?.restoreFocusRef.current ?? null,
  });

  return (
    <PopoverPrimitive.Portal container={getPortalContainer()}>
      <PopoverPrimitive.Content
        data-slot="popover-content"
        align={align}
        sideOffset={sideOffset}
        className={cn(
          "app-surface-opaque z-50 w-72 origin-(--radix-popover-content-transform-origin) rounded-md border bg-popover p-4 text-popover-foreground shadow-md outline-hidden data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95 data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95",
          className,
        )}
        onEscapeKeyDown={(event) => {
          onEscapeKeyDown?.(event);
          ownership?.handleEscape(event);
        }}
        {...props}
      />
    </PopoverPrimitive.Portal>
  );
}

export { Popover, PopoverContent, PopoverTrigger };
