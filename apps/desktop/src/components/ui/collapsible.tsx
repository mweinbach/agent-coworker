import * as React from "react";
import { Disclosure as HeroDisclosure } from "@heroui/react";

import { cn } from "@/lib/utils";

type CollapsibleContextValue = {
  open: boolean;
};

const CollapsibleContext = React.createContext<CollapsibleContextValue | null>(null);

function useCollapsibleContext() {
  const context = React.useContext(CollapsibleContext);
  if (!context) {
    throw new Error("Collapsible components must be used within <Collapsible>");
  }
  return context;
}

type CollapsibleProps = Omit<
  React.ComponentProps<typeof HeroDisclosure>,
  "children" | "defaultExpanded" | "isDisabled" | "isExpanded" | "onExpandedChange"
> & {
  children?: React.ReactNode;
  defaultOpen?: boolean;
  disabled?: boolean;
  onOpenChange?: (open: boolean) => void;
  open?: boolean;
};

function Collapsible({
  children,
  className,
  defaultOpen,
  disabled,
  onOpenChange,
  open,
  ...props
}: CollapsibleProps) {
  const [uncontrolledOpen, setUncontrolledOpen] = React.useState(defaultOpen ?? false);
  const isOpen = open ?? uncontrolledOpen;

  const handleOpenChange = React.useCallback((nextOpen: boolean) => {
    if (open === undefined) {
      setUncontrolledOpen(nextOpen);
    }
    onOpenChange?.(nextOpen);
  }, [onOpenChange, open]);

  return (
    <CollapsibleContext.Provider value={{ open: isOpen }}>
      <HeroDisclosure
        className={className}
        data-expanded={isOpen ? "true" : "false"}
        data-state={isOpen ? "open" : "closed"}
        isDisabled={disabled}
        isExpanded={isOpen}
        onExpandedChange={handleOpenChange}
        {...props}
      >
        {children}
      </HeroDisclosure>
    </CollapsibleContext.Provider>
  );
}

type CollapsibleTriggerProps = Omit<React.ComponentProps<typeof HeroDisclosure.Trigger>, "children"> & {
  asChild?: boolean;
  children?: React.ReactNode;
};

function CollapsibleTrigger({
  asChild = false,
  children,
  className,
  ...props
}: CollapsibleTriggerProps) {
  const { open } = useCollapsibleContext();
  const sharedProps = {
    ...props,
    className,
    "data-expanded": open ? "true" : "false",
    "data-state": open ? "open" : "closed",
  } as const;

  if (asChild && React.isValidElement(children)) {
    const child = children as React.ReactElement<{
      className?: string;
      slot?: string;
      "data-expanded"?: string;
      "data-state"?: string;
    }>;

    return (
      <HeroDisclosure.Heading>
        {React.cloneElement(child, {
          ...sharedProps,
          className: cn(className, child.props.className),
          slot: "trigger",
        })}
      </HeroDisclosure.Heading>
    );
  }

  return (
    <HeroDisclosure.Heading>
      <HeroDisclosure.Trigger {...sharedProps}>
        {children}
      </HeroDisclosure.Trigger>
    </HeroDisclosure.Heading>
  );
}

type CollapsibleContentProps = React.ComponentProps<typeof HeroDisclosure.Content>;

function CollapsibleContent({ className, ...props }: CollapsibleContentProps) {
  const { open } = useCollapsibleContext();

  if (!open) {
    return null;
  }

  return (
    <HeroDisclosure.Content
      className={className}
      data-expanded={open ? "true" : "false"}
      data-state={open ? "open" : "closed"}
      {...props}
    />
  );
}

export { Collapsible, CollapsibleContent, CollapsibleTrigger };
