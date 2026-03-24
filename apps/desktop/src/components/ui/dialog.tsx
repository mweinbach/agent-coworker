import * as React from "react";
import { Modal } from "@heroui/react";
import { XIcon } from "lucide-react";

import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";

const ModalDialogPrimitive = Modal.Dialog as unknown as React.ComponentType<Record<string, unknown>>;

type DialogContextValue = {
  open: boolean;
  setOpen: (open: boolean) => void;
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
  const [uncontrolledOpen, setUncontrolledOpen] = React.useState(defaultOpen ?? false);
  const isOpen = open ?? uncontrolledOpen;
  const setOpen = React.useCallback((nextOpen: boolean) => {
    if (open === undefined) {
      setUncontrolledOpen(nextOpen);
    }
    onOpenChange?.(nextOpen);
  }, [onOpenChange, open]);

  return (
    <DialogContext.Provider value={{ open: isOpen, setOpen }}>{children}</DialogContext.Provider>
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
  const { open, setOpen } = useDialogContext();
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
          setOpen(false);
        }
      }
      onKeyDown?.(event);
    },
    [onEscapeKeyDown, onKeyDown, setOpen],
  );

  return (
    <DialogPortal>
      <Modal.Backdrop
        data-slot="dialog-overlay"
        className="fixed inset-0 z-50 bg-black/45 backdrop-blur-[1px]"
        isDismissable={false}
        isKeyboardDismissDisabled
        isOpen={open}
        onClick={(event) => {
          allowDismissRef.current = true;
          handleBackdropClick(event);
          if (!event.isDefaultPrevented() && allowDismissRef.current) {
            setOpen(false);
          }
        }}
        onOpenChange={setOpen}
      >
        <Modal.Container
          className="fixed inset-0 z-50 flex items-center justify-center p-4"
          placement="center"
        >
          <ModalDialogPrimitive
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
                onClick={() => setOpen(false)}
              >
                <XIcon data-icon="close" />
                <span className="sr-only">Close</span>
              </Button>
            ) : null}
          </ModalDialogPrimitive>
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
  const { setOpen } = useDialogContext();

  return (
    <Button
      {...props}
      onClick={(event) => {
        props.onClick?.(event);
        if (!event.defaultPrevented) {
          setOpen(false);
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
