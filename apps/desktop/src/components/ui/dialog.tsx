import * as React from "react";
import { Modal, useOverlayState } from "@heroui/react";
import { XIcon } from "lucide-react";

import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";

type DialogContextValue = {
  state: ReturnType<typeof useOverlayState>;
};

const DialogContext = React.createContext<DialogContextValue | null>(null);

function useDialogContext(): DialogContextValue {
  const context = React.useContext(DialogContext);
  if (!context) {
    throw new Error("Dialog components must be rendered within <Dialog>");
  }
  return context;
}

type DialogProps = React.PropsWithChildren<{
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
}>;

function Dialog({ children, open, defaultOpen, onOpenChange }: DialogProps) {
  const state = useOverlayState({
    isOpen: open,
    defaultOpen,
    onOpenChange,
  });

  return (
    <DialogContext.Provider value={{ state }}>
      <Modal state={state}>
        {children}
      </Modal>
    </DialogContext.Provider>
  );
}

type DialogTriggerProps = React.ComponentProps<typeof Modal.Trigger>;

function DialogTrigger({ children, ...props }: DialogTriggerProps) {
  return <Modal.Trigger {...props}>{children}</Modal.Trigger>;
}

const DialogPortal = ({ children }: { children: React.ReactNode }) => <>{children}</>;

const DialogOverlay = React.forwardRef<HTMLDivElement, React.ComponentProps<"div">>(function DialogOverlay(
  { className, ...props },
  ref,
) {
  return (
    <div
      ref={ref}
      data-slot="dialog-overlay"
      className={cn("fixed inset-0 z-50 bg-black/45 backdrop-blur-[1px]", className)}
      {...props}
    />
  );
});

type DialogContentProps = React.HTMLAttributes<HTMLDivElement> & {
  showClose?: boolean;
  onEscapeKeyDown?: (event: KeyboardEvent) => void;
  onInteractOutside?: (event: Event & { preventDefault: () => void }) => void;
};

function DialogContent({
  className,
  children,
  showClose = false,
  onEscapeKeyDown,
  onInteractOutside,
  onKeyDown,
  ...props
}: DialogContentProps) {
  const { state } = useDialogContext();
  const allowDismissRef = React.useRef(true);

  const handleBackdropClick = React.useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      const syntheticEvent = Object.assign(event.nativeEvent, {
        preventDefault: () => {
          allowDismissRef.current = false;
          event.preventDefault();
        },
      });
      onInteractOutside?.(syntheticEvent);
    },
    [onInteractOutside],
  );

  const handleKeyDown = React.useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      if (event.key === "Escape") {
        const nativeEvent = Object.assign(event.nativeEvent, {
          preventDefault: () => {
            allowDismissRef.current = false;
            event.preventDefault();
          },
        });
        onEscapeKeyDown?.(nativeEvent as KeyboardEvent);
        if (!event.defaultPrevented && allowDismissRef.current) {
          state.close();
        }
      }
      onKeyDown?.(event);
    },
    [onEscapeKeyDown, onKeyDown, state],
  );

  return (
    <DialogPortal>
      <Modal.Backdrop
        data-slot="dialog-overlay"
        className="fixed inset-0 z-50 bg-black/45 backdrop-blur-[1px]"
        isDismissable={false}
        onClick={(event) => {
          allowDismissRef.current = true;
          handleBackdropClick(event);
          if (!event.isDefaultPrevented() && allowDismissRef.current) {
            state.close();
          }
        }}
      >
        <Modal.Container
          className="fixed inset-0 z-50 flex items-center justify-center p-4"
          placement="center"
        >
          <div
            data-slot="dialog-content"
            className={cn(
              "relative grid w-[min(96vw,42rem)] gap-4 rounded-xl border border-border/80 bg-card p-5 text-card-foreground shadow-xl",
              className,
            )}
            onKeyDown={handleKeyDown}
            {...props}
          >
            {children}
            {showClose ? (
              <Button
                className="absolute right-4 top-4 opacity-70 hover:opacity-100"
                size="icon-sm"
                variant="ghost"
                onClick={() => state.close()}
              >
                <XIcon data-icon="close" />
                <span className="sr-only">Close</span>
              </Button>
            ) : null}
          </div>
        </Modal.Container>
      </Modal.Backdrop>
    </DialogPortal>
  );
}

function DialogHeader({ className, ...props }: React.ComponentProps<"div">) {
  return <div data-slot="dialog-header" className={cn("flex flex-col gap-1.5 text-left", className)} {...props} />;
}

function DialogFooter({ className, ...props }: React.ComponentProps<"div">) {
  return <div data-slot="dialog-footer" className={cn("flex flex-col-reverse gap-2 sm:flex-row sm:justify-end", className)} {...props} />;
}

function DialogTitle({ className, ...props }: React.ComponentProps<typeof Modal.Heading>) {
  return <Modal.Heading data-slot="dialog-title" className={cn("text-lg font-semibold leading-none tracking-tight", className)} {...props} />;
}

const DialogDescription = React.forwardRef<HTMLParagraphElement, React.ComponentProps<"p">>(
  function DialogDescription({ className, ...props }, ref) {
    return <p ref={ref} data-slot="dialog-description" className={cn("text-sm text-muted-foreground", className)} {...props} />;
  },
);

function DialogClose({ children, ...props }: React.ComponentProps<typeof Button>) {
  const { state } = useDialogContext();

  return (
    <Button
      {...props}
      onClick={(event) => {
        props.onClick?.(event);
        if (!event.defaultPrevented) {
          state.close();
        }
      }}
    >
      {children}
    </Button>
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

export type { DialogContentProps };
