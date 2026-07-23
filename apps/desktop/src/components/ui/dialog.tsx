import { XIcon } from "lucide-react";
import { Dialog as DialogPrimitive } from "radix-ui";
import type * as React from "react";
import { createContext, useContext } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  isReservedEditableEscape,
  type OverlayOwnership,
  type OverlayRootState,
  useOverlayOwner,
  useOverlayRootState,
} from "@/ui/OverlayStack";

type DialogOverlayState = OverlayRootState & {
  ownership: OverlayOwnership | null;
};

const DialogOverlayContext = createContext<DialogOverlayState | null>(null);

function Dialog({
  defaultOpen,
  onOpenChange,
  open,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Root>) {
  const state = useOverlayRootState({ defaultOpen, onOpenChange, open });
  const ownership = useOverlayOwner({
    active: state.open,
    label: "Dialog",
    onDismiss: () => state.setOpen(false),
    restoreFocus: () => state.restoreFocusRef.current,
  });
  return (
    <DialogOverlayContext.Provider value={{ ...state, ownership }}>
      <DialogPrimitive.Root
        data-slot="dialog"
        open={state.open}
        onOpenChange={state.setOpen}
        {...props}
      />
    </DialogOverlayContext.Provider>
  );
}

function DialogTrigger({ ...props }: React.ComponentProps<typeof DialogPrimitive.Trigger>) {
  return <DialogPrimitive.Trigger data-slot="dialog-trigger" {...props} />;
}

function getPortalContainer() {
  return typeof globalThis.document === "undefined" ? undefined : globalThis.document.body;
}

function DialogPortal({
  container = getPortalContainer(),
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Portal>) {
  return <DialogPrimitive.Portal data-slot="dialog-portal" container={container} {...props} />;
}

function DialogClose({ ...props }: React.ComponentProps<typeof DialogPrimitive.Close>) {
  return <DialogPrimitive.Close data-slot="dialog-close" {...props} />;
}

function DialogOverlay({
  className,
  style,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Overlay>) {
  const owner = useContext(DialogOverlayContext);
  return (
    <DialogPrimitive.Overlay
      data-slot="dialog-overlay"
      className={cn(
        "fixed inset-0 z-50 bg-black/50 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:animate-in data-[state=open]:fade-in-0",
        className,
      )}
      style={{ ...style, zIndex: owner?.ownership?.zIndex ?? style?.zIndex }}
      {...props}
    />
  );
}

function DialogContent({
  className,
  children,
  showCloseButton = true,
  preventEditableEscapeDismissal = false,
  overlayClassName,
  forceMount,
  onEscapeKeyDown,
  style,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Content> & {
  overlayClassName?: string;
  preventEditableEscapeDismissal?: boolean;
  showCloseButton?: boolean;
}) {
  const owner = useContext(DialogOverlayContext);
  const ownership = owner?.ownership;

  return (
    <DialogPortal data-slot="dialog-portal" forceMount={forceMount}>
      <DialogOverlay className={overlayClassName} />
      <DialogPrimitive.Content
        data-slot="dialog-content"
        data-overlay-layer-sequence={ownership?.sequence}
        className={cn(
          "fixed top-[50%] left-[50%] z-50 grid w-full max-w-[calc(100%-2rem)] translate-x-[-50%] translate-y-[-50%] gap-4 rounded-lg border bg-popover p-6 text-popover-foreground shadow-lg duration-200 outline-none data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95 data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95 sm:max-w-lg",
          className,
        )}
        style={{ ...style, zIndex: ownership?.zIndex ?? style?.zIndex }}
        onEscapeKeyDown={(event) => {
          onEscapeKeyDown?.(event);
          if (preventEditableEscapeDismissal && isReservedEditableEscape(event)) return;
          ownership?.handleEscape(event);
        }}
        {...props}
      >
        {children}
        {showCloseButton && (
          <DialogPrimitive.Close
            data-slot="dialog-close"
            className="absolute top-4 right-4 rounded-xs opacity-70 ring-offset-background transition-opacity hover:opacity-100 focus:ring-2 focus:ring-ring focus:ring-offset-2 focus:outline-hidden disabled:pointer-events-none data-[state=open]:bg-accent data-[state=open]:text-accent-foreground [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4"
          >
            <XIcon />
            <span className="sr-only">Close</span>
          </DialogPrimitive.Close>
        )}
      </DialogPrimitive.Content>
    </DialogPortal>
  );
}

function DialogHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="dialog-header"
      className={cn("flex flex-col gap-2 text-center sm:text-left", className)}
      {...props}
    />
  );
}

function DialogFooter({
  className,
  showCloseButton = false,
  children,
  ...props
}: React.ComponentProps<"div"> & {
  showCloseButton?: boolean;
}) {
  return (
    <div
      data-slot="dialog-footer"
      className={cn("flex flex-col-reverse gap-2 sm:flex-row sm:justify-end", className)}
      {...props}
    >
      {children}
      {showCloseButton && (
        <DialogPrimitive.Close asChild>
          <Button variant="outline">Close</Button>
        </DialogPrimitive.Close>
      )}
    </div>
  );
}

function DialogTitle({ className, ...props }: React.ComponentProps<typeof DialogPrimitive.Title>) {
  return (
    <DialogPrimitive.Title
      data-slot="dialog-title"
      className={cn("text-lg leading-none font-semibold", className)}
      {...props}
    />
  );
}

function DialogDescription({
  className,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Description>) {
  return (
    <DialogPrimitive.Description
      data-slot="dialog-description"
      className={cn("text-sm text-muted-foreground", className)}
      {...props}
    />
  );
}

export {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogOverlay,
  DialogPortal,
  DialogTitle,
  DialogTrigger,
};
