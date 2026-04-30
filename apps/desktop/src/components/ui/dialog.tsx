import { XIcon } from "lucide-react";
import * as React from "react";
import { createPortal } from "react-dom";
import { Button } from "@/components/ui/button";
import { assignElementRef, getElementRef } from "@/lib/react-ref";
import { cn } from "@/lib/utils";

type DialogContextValue = {
  descriptionId: string;
  descriptionMounted: boolean;
  open: boolean;
  restoreFocusRef: React.MutableRefObject<HTMLElement | null>;
  setDescriptionId: (id: string) => void;
  setDescriptionMounted: (mounted: boolean) => void;
  setTitleId: (id: string) => void;
  setTitleMounted: (mounted: boolean) => void;
  setOpen: (open: boolean) => void;
  titleId: string;
  titleMounted: boolean;
  triggerRef: React.MutableRefObject<HTMLElement | null>;
};

const DialogContext = React.createContext<DialogContextValue | null>(null);
const openDialogStack: symbol[] = [];
let dialogBodyLockCount = 0;
let dialogBodyOverflow = "";

const DIALOG_FOCUSABLE_SELECTOR = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled]):not([type='hidden'])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "[tabindex]:not([tabindex='-1'])",
  "[contenteditable='true']",
].join(",");

function getFocusableElements(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(DIALOG_FOCUSABLE_SELECTOR)).filter(
    (element) =>
      !element.hasAttribute("disabled") && element.getAttribute("aria-hidden") !== "true",
  );
}

function focusFirstElement(container: HTMLElement) {
  const target = getFocusableElements(container)[0] ?? container;
  target.focus();
}

function isElementNode(value: unknown): value is HTMLElement {
  return Boolean(
    value &&
      typeof value === "object" &&
      "nodeType" in value &&
      (value as Node).nodeType === 1 &&
      "focus" in value &&
      typeof (value as { focus?: unknown }).focus === "function",
  );
}

function getActiveElement(doc: Document): HTMLElement | null {
  return isElementNode(doc.activeElement) ? doc.activeElement : null;
}

function registerDialogLayer(dialogId: symbol) {
  if (openDialogStack.includes(dialogId)) {
    return;
  }

  if (dialogBodyLockCount === 0 && typeof document !== "undefined") {
    dialogBodyOverflow = document.body.style.overflow;
  }

  openDialogStack.push(dialogId);
  dialogBodyLockCount += 1;

  if (typeof document !== "undefined") {
    document.body.style.overflow = "hidden";
  }
}

function unregisterDialogLayer(dialogId: symbol) {
  const index = openDialogStack.lastIndexOf(dialogId);
  if (index === -1) {
    return;
  }

  openDialogStack.splice(index, 1);
  if (dialogBodyLockCount > 0) {
    dialogBodyLockCount -= 1;
  }

  if (dialogBodyLockCount === 0 && typeof document !== "undefined") {
    document.body.style.overflow = dialogBodyOverflow;
  }
}

function isTopmostDialog(dialogId: symbol) {
  return openDialogStack[openDialogStack.length - 1] === dialogId;
}

function useDialogContext(): DialogContextValue {
  const context = React.useContext(DialogContext);
  if (!context) {
    throw new Error("Dialog components must be rendered within <Dialog>");
  }
  return context;
}

function useOptionalDialogContext(): DialogContextValue | null {
  return React.useContext(DialogContext);
}

type DialogProps = React.PropsWithChildren<{
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
}>;

function Dialog({ children, open, defaultOpen, onOpenChange }: DialogProps) {
  const [uncontrolledOpen, setUncontrolledOpen] = React.useState(defaultOpen ?? false);
  const [titleMounted, setTitleMounted] = React.useState(false);
  const [descriptionMounted, setDescriptionMounted] = React.useState(false);
  const restoreFocusRef = React.useRef<HTMLElement | null>(null);
  const defaultTitleId = React.useId();
  const defaultDescriptionId = React.useId();
  const [titleId, setTitleId] = React.useState(defaultTitleId);
  const [descriptionId, setDescriptionId] = React.useState(defaultDescriptionId);
  const triggerRef = React.useRef<HTMLElement | null>(null);
  const isOpen = open ?? uncontrolledOpen;
  const setOpen = React.useCallback(
    (nextOpen: boolean) => {
      if (nextOpen && typeof document !== "undefined") {
        const activeElement = getActiveElement(document);
        restoreFocusRef.current =
          activeElement && activeElement !== document.body ? activeElement : triggerRef.current;
      }
      if (open === undefined) {
        setUncontrolledOpen(nextOpen);
      }
      onOpenChange?.(nextOpen);
    },
    [onOpenChange, open],
  );

  React.useLayoutEffect(() => {
    if (!isOpen || typeof document === "undefined") {
      return;
    }

    if (restoreFocusRef.current === null) {
      const activeElement = getActiveElement(document);
      restoreFocusRef.current =
        activeElement && activeElement !== document.body ? activeElement : triggerRef.current;
    }
  }, [isOpen]);

  return (
    <DialogContext.Provider
      value={{
        descriptionId,
        descriptionMounted,
        open: isOpen,
        restoreFocusRef,
        setDescriptionId,
        setDescriptionMounted,
        setTitleId,
        setTitleMounted,
        setOpen,
        titleId,
        titleMounted,
        triggerRef,
      }}
    >
      {children}
    </DialogContext.Provider>
  );
}

type DialogTriggerProps = React.ButtonHTMLAttributes<HTMLButtonElement> & {
  asChild?: boolean;
};

const nativeDisabledElements = new Set([
  "button",
  "fieldset",
  "input",
  "optgroup",
  "option",
  "select",
  "textarea",
]);

function DialogTrigger({
  children,
  asChild = false,
  disabled,
  onClick,
  type,
  ...props
}: React.PropsWithChildren<DialogTriggerProps>) {
  const { setOpen, triggerRef } = useDialogContext();
  const [triggerNode, setTriggerNode] = React.useState<HTMLElement | null>(null);

  React.useEffect(() => {
    if (!disabled || !triggerNode) {
      return;
    }

    const stopDisabledClick = (event: MouseEvent) => {
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
    };

    triggerNode.addEventListener("click", stopDisabledClick, true);
    return () => triggerNode.removeEventListener("click", stopDisabledClick, true);
  }, [disabled, triggerNode]);

  const openFromClick = (event: React.MouseEvent<HTMLElement>) => {
    if (!event.defaultPrevented) {
      setOpen(true);
    }
  };

  const handleClick = (event: React.MouseEvent<HTMLElement>) => {
    if (disabled) {
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    onClick?.(event as unknown as React.MouseEvent<HTMLButtonElement>);
    openFromClick(event);
  };

  if (asChild && React.isValidElement(children)) {
    const child = children as React.ReactElement<{
      className?: string;
      disabled?: boolean;
      onClick?: (event: React.MouseEvent<HTMLElement>) => void;
      ref?: React.Ref<HTMLElement>;
      tabIndex?: number;
    }>;
    const childSupportsNativeDisabled =
      typeof child.type === "string" && nativeDisabledElements.has(child.type);

    const childProps: React.HTMLAttributes<HTMLElement> &
      React.RefAttributes<HTMLElement> & {
        disabled?: boolean;
      } = {
      ...props,
      disabled:
        child.props.disabled === true || (disabled && childSupportsNativeDisabled)
          ? true
          : undefined,
      "aria-disabled": disabled ? true : props["aria-disabled"],
      className: cn(child.props.className, props.className),
      tabIndex: disabled ? -1 : child.props.tabIndex,
      onClick: (event: React.MouseEvent<HTMLElement>) => {
        if (disabled) {
          event.preventDefault();
          event.stopPropagation();
          return;
        }
        child.props.onClick?.(event);
        if (event.defaultPrevented) {
          return;
        }
        onClick?.(event as unknown as React.MouseEvent<HTMLButtonElement>);
        openFromClick(event);
      },
      ref: (node: HTMLElement | null) => {
        setTriggerNode(node);
        triggerRef.current = node;
        assignElementRef(getElementRef<HTMLElement>(child), node);
      },
    };

    return React.cloneElement(child, childProps);
  }

  return (
    <button
      ref={(node) => {
        setTriggerNode(node);
        triggerRef.current = node;
      }}
      type={type ?? "button"}
      onClick={handleClick as React.MouseEventHandler<HTMLButtonElement>}
      {...props}
      disabled={disabled}
    >
      {children}
    </button>
  );
}

const DialogPortal = ({ children }: { children: React.ReactNode }) => {
  if (typeof document === "undefined") {
    return null;
  }

  return createPortal(children, document.body);
};

const DialogOverlay = React.forwardRef<HTMLDivElement, React.ComponentProps<"div">>(
  function DialogOverlay({ className, ...props }, ref) {
    return (
      <div
        ref={ref}
        data-slot="dialog-overlay"
        className={cn("fixed inset-0 z-0 bg-foreground/40", className)}
        {...props}
      />
    );
  },
);

type DialogContentProps = React.HTMLAttributes<HTMLDivElement> & {
  showClose?: boolean;
  onEscapeKeyDown?: (event: KeyboardEvent) => void;
  onInteractOutside?: (event: Event & { preventDefault: () => void }) => void;
};

function DialogContent({
  "aria-describedby": ariaDescribedBy,
  "aria-labelledby": ariaLabelledBy,
  className,
  children,
  showClose = false,
  onEscapeKeyDown,
  onInteractOutside,
  onKeyDown,
  ...props
}: DialogContentProps) {
  const {
    descriptionId,
    descriptionMounted,
    open,
    restoreFocusRef,
    setOpen,
    titleId,
    titleMounted,
    triggerRef,
  } = useDialogContext();
  const allowDismissRef = React.useRef(true);
  const contentRef = React.useRef<HTMLDivElement | null>(null);
  const dialogIdRef = React.useRef<symbol>(Symbol("dialog"));
  const restoreFocusOnCloseRef = React.useRef(false);

  React.useEffect(() => {
    if (!open || typeof document === "undefined") {
      return;
    }

    registerDialogLayer(dialogIdRef.current);
    return () => unregisterDialogLayer(dialogIdRef.current);
  }, [open]);

  const handleEscapeDismiss = React.useCallback(
    (event: KeyboardEvent) => {
      allowDismissRef.current = true;
      onEscapeKeyDown?.(event);
      if (!event.defaultPrevented && allowDismissRef.current) {
        setOpen(false);
      }
    },
    [onEscapeKeyDown, setOpen],
  );

  const restoreFocusToTrigger = React.useCallback(() => {
    const restoreTarget = restoreFocusRef.current;
    const fallbackTrigger = triggerRef.current;
    const restoreFocus = () => {
      if (restoreTarget?.isConnected) {
        restoreTarget.focus();
        return;
      }
      if (fallbackTrigger?.isConnected) {
        fallbackTrigger.focus();
      }
    };

    restoreFocus();
    const timer = setTimeout(() => {
      restoreFocus();
      restoreFocusRef.current = null;
    }, 0);

    return () => clearTimeout(timer);
  }, [restoreFocusRef, triggerRef]);

  React.useEffect(() => {
    if (open) {
      restoreFocusOnCloseRef.current = true;
      return;
    }

    if (!restoreFocusOnCloseRef.current) {
      return;
    }

    restoreFocusOnCloseRef.current = false;
    return restoreFocusToTrigger();
  }, [open, restoreFocusToTrigger]);

  React.useEffect(
    () => () => {
      if (!restoreFocusOnCloseRef.current) {
        return;
      }
      restoreFocusOnCloseRef.current = false;
      restoreFocusToTrigger();
    },
    [restoreFocusToTrigger],
  );

  React.useEffect(() => {
    if (!open || typeof document === "undefined") {
      return;
    }

    const content = contentRef.current;
    if (!content) {
      return;
    }

    focusFirstElement(content);
  }, [open]);

  React.useEffect(() => {
    if (!open || typeof document === "undefined") {
      return;
    }

    const content = contentRef.current;
    if (!content) {
      return;
    }

    const handleDocumentKeyDown = (event: KeyboardEvent) => {
      if (!contentRef.current || event.defaultPrevented) {
        return;
      }

      if (event.key === "Escape") {
        if (!isTopmostDialog(dialogIdRef.current)) {
          return;
        }
        event.stopImmediatePropagation();
        handleEscapeDismiss(event);
        return;
      }

      if (event.key !== "Tab") {
        return;
      }

      if (!isTopmostDialog(dialogIdRef.current)) {
        return;
      }

      const focusable = getFocusableElements(contentRef.current);
      if (focusable.length === 0) {
        event.preventDefault();
        contentRef.current.focus();
        return;
      }

      const activeElement = getActiveElement(document);
      const first = focusable[0];
      const last = focusable[focusable.length - 1];

      if (!activeElement || !contentRef.current.contains(activeElement)) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
        return;
      }

      if (!event.shiftKey && activeElement === last) {
        event.preventDefault();
        first.focus();
        return;
      }

      if (event.shiftKey && (activeElement === first || activeElement === contentRef.current)) {
        event.preventDefault();
        last.focus();
      }
    };

    document.addEventListener("keydown", handleDocumentKeyDown);

    return () => {
      document.removeEventListener("keydown", handleDocumentKeyDown);
    };
  }, [handleEscapeDismiss, open]);

  const handleBackdropClick = React.useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      const syntheticEvent = Object.create(event.nativeEvent) as Event & {
        preventDefault: () => void;
      };
      syntheticEvent.preventDefault = () => {
        allowDismissRef.current = false;
        event.preventDefault();
      };
      onInteractOutside?.(syntheticEvent);
    },
    [onInteractOutside],
  );

  const handleKeyDown = React.useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      onKeyDown?.(event);
    },
    [onKeyDown],
  );

  if (!open) {
    return null;
  }

  return (
    <DialogPortal>
      <div className="fixed inset-0 z-50 flex items-center justify-center p-4 sm:p-6">
        <DialogOverlay
          onClick={(event) => {
            allowDismissRef.current = true;
            handleBackdropClick(event);
            if (!event.defaultPrevented && allowDismissRef.current) {
              setOpen(false);
            }
          }}
        />
        <div className="relative z-10 flex justify-center">
          <div
            ref={contentRef}
            data-slot="dialog-content"
            role="dialog"
            aria-modal="true"
            {...props}
            aria-describedby={ariaDescribedBy ?? (descriptionMounted ? descriptionId : undefined)}
            aria-labelledby={ariaLabelledBy ?? (titleMounted ? titleId : undefined)}
            tabIndex={-1}
            className={cn(
              "app-surface-overlay app-border-strong app-shadow-overlay relative grid w-[min(96vw,42rem)] gap-4 rounded-xl border p-5 text-card-foreground",
              className,
            )}
            onKeyDown={handleKeyDown}
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
          </div>
        </div>
      </div>
    </DialogPortal>
  );
}

function DialogHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="dialog-header"
      className={cn("flex flex-col gap-1.5 text-left", className)}
      {...props}
    />
  );
}

function DialogFooter({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="dialog-footer"
      className={cn("flex flex-col-reverse gap-2 sm:flex-row sm:justify-end", className)}
      {...props}
    />
  );
}

function DialogTitle({ className, id, ...props }: React.ComponentProps<"h2">) {
  const context = useOptionalDialogContext();
  const titleId = id ?? context?.titleId;
  const setTitleId = context?.setTitleId;
  const setTitleMounted = context?.setTitleMounted;

  React.useEffect(() => {
    if (!titleId || !setTitleId || !setTitleMounted) {
      return;
    }
    setTitleId(titleId);
    setTitleMounted(true);
    return () => setTitleMounted(false);
  }, [setTitleId, setTitleMounted, titleId]);

  return (
    <h2
      id={titleId}
      data-slot="dialog-title"
      className={cn("text-lg font-semibold leading-none tracking-tight", className)}
      {...props}
    />
  );
}

const DialogDescription = React.forwardRef<HTMLParagraphElement, React.ComponentProps<"p">>(
  function DialogDescription({ className, id, ...props }, ref) {
    const context = useOptionalDialogContext();
    const descriptionId = id ?? context?.descriptionId;
    const setDescriptionId = context?.setDescriptionId;
    const setDescriptionMounted = context?.setDescriptionMounted;

    React.useEffect(() => {
      if (!descriptionId || !setDescriptionId || !setDescriptionMounted) {
        return;
      }
      setDescriptionId(descriptionId);
      setDescriptionMounted(true);
      return () => setDescriptionMounted(false);
    }, [descriptionId, setDescriptionId, setDescriptionMounted]);

    return (
      <p
        ref={ref}
        id={descriptionId}
        data-slot="dialog-description"
        className={cn("app-text-muted text-sm", className)}
        {...props}
      />
    );
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

export type { DialogContentProps };
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
