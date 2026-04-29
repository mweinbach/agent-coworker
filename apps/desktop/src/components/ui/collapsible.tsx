import * as React from "react";

function setComposedRefs<T>(node: T | null, ...refs: Array<React.Ref<T> | undefined>) {
  for (const ref of refs) {
    if (!ref) {
      continue;
    }
    if (typeof ref === "function") {
      ref(node);
      continue;
    }
    (ref as React.MutableRefObject<T | null>).current = node;
  }
}

function getElementRef<T>(element: React.ReactElement): React.Ref<T> | undefined {
  const withPossibleRef = element as React.ReactElement & {
    ref?: React.Ref<T>;
    props: { ref?: React.Ref<T> };
  };
  return withPossibleRef.props.ref ?? withPossibleRef.ref;
}

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
        data-disabled={disabled ? "" : undefined}
        data-state={isOpen ? "open" : "closed"}
        data-expanded={isOpen ? "true" : "false"}
        {...props}
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
  function CollapsibleTrigger({ asChild = false, children, onClick, type, ...props }, ref) {
    const { disabled, open, setOpen } = useCollapsibleContext();

    const handleClick = (event: React.MouseEvent<HTMLElement>) => {
      onClick?.(event as React.MouseEvent<HTMLButtonElement>);
      if (!event.defaultPrevented && !disabled) {
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
        onClick?: React.MouseEventHandler<HTMLElement>;
        ref?: React.Ref<HTMLElement>;
      }>;

      return React.cloneElement(child, {
        ...sharedProps,
        onClick: (event: React.MouseEvent<HTMLElement>) => {
          child.props.onClick?.(event);
          handleClick(event);
        },
        ref: (node: HTMLElement | null) => {
          setComposedRefs(node, getElementRef<HTMLElement>(child), ref as React.Ref<HTMLElement>);
        },
      });
    }

    return (
      <button
        ref={ref}
        type={type ?? "button"}
        onClick={handleClick as React.MouseEventHandler<HTMLButtonElement>}
        disabled={disabled}
        {...sharedProps}
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
        data-state={open ? "open" : "closed"}
        data-expanded={open ? "true" : "false"}
        hidden={hidden ?? (!open && forceMount ? true : undefined)}
        {...props}
      />
    );
  },
);

CollapsibleContent.displayName = "CollapsibleContent";

export { Collapsible, CollapsibleContent, CollapsibleTrigger };
