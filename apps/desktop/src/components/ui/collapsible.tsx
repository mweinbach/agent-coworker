import * as React from "react";
import { supportsNativeDisabled } from "@/lib/nativeDisabled";
import { assignComposedRefs, getElementRef } from "@/lib/react-ref";
import { cn } from "@/lib/utils";

type CollapsibleContextValue = {
  disabled: boolean;
  open: boolean;
  setOpen: (open: boolean) => void;
};

const CollapsibleContext = React.createContext<CollapsibleContextValue | null>(null);

function useCollapsibleContext() {
  const context = React.useContext(CollapsibleContext);
  if (!context) {
    throw new Error("Collapsible components must be used within <Collapsible>");
  }
  return context;
}

type CollapsibleProps = React.HTMLAttributes<HTMLDivElement> & {
  defaultOpen?: boolean;
  disabled?: boolean;
  onOpenChange?: (open: boolean) => void;
  open?: boolean;
};

const Collapsible = React.forwardRef<HTMLDivElement, CollapsibleProps>(function Collapsible(
  { children, defaultOpen, disabled = false, onOpenChange, open, ...props },
  ref,
) {
  const [uncontrolledOpen, setUncontrolledOpen] = React.useState(defaultOpen ?? false);
  const isOpen = open ?? uncontrolledOpen;

  const handleOpenChange = React.useCallback(
    (nextOpen: boolean) => {
      if (open === undefined) {
        setUncontrolledOpen(nextOpen);
      }
      onOpenChange?.(nextOpen);
    },
    [onOpenChange, open],
  );

  return (
    <CollapsibleContext.Provider value={{ disabled, open: isOpen, setOpen: handleOpenChange }}>
      <div
        ref={ref}
        {...props}
        data-disabled={disabled ? "" : undefined}
        data-state={isOpen ? "open" : "closed"}
        data-expanded={isOpen ? "true" : "false"}
      >
        {children}
      </div>
    </CollapsibleContext.Provider>
  );
});

Collapsible.displayName = "Collapsible";

type CollapsibleTriggerProps = React.ButtonHTMLAttributes<HTMLButtonElement> & {
  asChild?: boolean;
};

const CollapsibleTrigger = React.forwardRef<HTMLButtonElement, CollapsibleTriggerProps>(
  function CollapsibleTrigger(
    {
      asChild = false,
      children,
      className,
      disabled: disabledProp,
      onClick,
      tabIndex,
      type,
      ...props
    },
    ref,
  ) {
    const { disabled: contextDisabled, open, setOpen } = useCollapsibleContext();
    const disabled = contextDisabled || Boolean(disabledProp);
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

    const handleClick = (event: React.MouseEvent<HTMLButtonElement>) => {
      if (disabled) {
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      onClick?.(event as React.MouseEvent<HTMLButtonElement>);
      if (!event.defaultPrevented) {
        setOpen(!open);
      }
    };

    const sharedProps = {
      ...props,
      "aria-disabled": disabled ? true : props["aria-disabled"],
      "aria-expanded": open,
      "data-state": open ? "open" : "closed",
      "data-expanded": open ? "true" : "false",
    } as const;

    if (asChild && React.isValidElement(children)) {
      const child = children as React.ReactElement<{
        className?: string;
        disabled?: boolean;
        onClick?: React.MouseEventHandler<HTMLElement>;
        ref?: React.Ref<HTMLElement>;
        tabIndex?: number;
      }>;
      const childSupportsNativeDisabled = supportsNativeDisabled(child.type);

      return React.cloneElement(child, {
        ...sharedProps,
        className: cn(child.props.className, className),
        disabled:
          child.props.disabled === true || (disabled && childSupportsNativeDisabled)
            ? true
            : undefined,
        tabIndex: disabled ? -1 : (child.props.tabIndex ?? tabIndex),
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
          onClick?.(event as React.MouseEvent<HTMLButtonElement>);
          if (event.defaultPrevented) {
            return;
          }
          setOpen(!open);
        },
        ref: (node: HTMLElement | null) => {
          setTriggerNode(node);
          assignComposedRefs(
            node,
            getElementRef<HTMLElement>(child),
            ref as React.Ref<HTMLElement>,
          );
        },
      });
    }

    return (
      <button
        {...sharedProps}
        ref={(node) => {
          setTriggerNode(node);
          assignComposedRefs(node, ref);
        }}
        type={type ?? "button"}
        onClick={handleClick}
        className={className}
        disabled={disabled}
        tabIndex={tabIndex}
      >
        {children}
      </button>
    );
  },
);

CollapsibleTrigger.displayName = "CollapsibleTrigger";

type CollapsibleContentProps = React.HTMLAttributes<HTMLDivElement> & {
  forceMount?: true;
};

const CollapsibleContent = React.forwardRef<HTMLDivElement, CollapsibleContentProps>(
  function CollapsibleContent({ forceMount, hidden, ...props }, ref) {
    const { open } = useCollapsibleContext();

    if (!forceMount && !open) {
      return null;
    }

    return (
      <div
        ref={ref}
        {...props}
        data-state={open ? "open" : "closed"}
        data-expanded={open ? "true" : "false"}
        hidden={hidden ?? (!open && forceMount ? true : undefined)}
      />
    );
  },
);

CollapsibleContent.displayName = "CollapsibleContent";

export { Collapsible, CollapsibleContent, CollapsibleTrigger };
