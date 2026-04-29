import { CheckIcon, ChevronDownIcon } from "lucide-react";
import * as React from "react";
import { createPortal } from "react-dom";

import { cn } from "@/lib/utils";

type SelectSize = "default" | "sm";
type SelectPlacement = "bottom" | "top" | "left" | "right";

type SelectContextValue = {
  disabled: boolean;
  open: boolean;
  selectedLabel: React.ReactNode;
  setOpen: (open: boolean) => void;
  setTriggerNode: (node: HTMLButtonElement | null) => void;
  setValue: (value: string) => void;
  triggerNode: HTMLButtonElement | null;
  value: string | undefined;
};

const SelectContext = React.createContext<SelectContextValue | null>(null);

type SelectProps = {
  value?: string;
  defaultValue?: string;
  disabled?: boolean;
  children: React.ReactNode;
  onValueChange?: (value: string) => void;
  name?: string;
};

function Select({ value, defaultValue, disabled, children, onValueChange, ...props }: SelectProps) {
  const [uncontrolledValue, setUncontrolledValue] = React.useState(defaultValue);
  const [open, setOpen] = React.useState(false);
  const [triggerNode, setTriggerNode] = React.useState<HTMLButtonElement | null>(null);
  const selectedValue = value ?? uncontrolledValue;
  const selectedLabel = React.useMemo(
    () => findSelectItemLabel(children, selectedValue),
    [children, selectedValue],
  );
  const setValue = React.useCallback(
    (nextValue: string) => {
      if (value === undefined) {
        setUncontrolledValue(nextValue);
      }
      onValueChange?.(nextValue);
      setOpen(false);
    },
    [onValueChange, value],
  );

  return (
    <SelectContext.Provider
      value={{
        disabled: disabled ?? false,
        open,
        selectedLabel,
        setOpen,
        setTriggerNode,
        setValue,
        triggerNode,
        value: selectedValue,
      }}
    >
      {props.name ? (
        <input disabled={disabled} name={props.name} type="hidden" value={selectedValue ?? ""} />
      ) : null}
      {children}
    </SelectContext.Provider>
  );
}

function useSelectContext(): SelectContextValue {
  const context = React.useContext(SelectContext);
  if (!context) {
    throw new Error("Select components must be rendered within <Select>");
  }
  return context;
}

type SelectGroupProps = React.HTMLAttributes<HTMLDivElement>;

function SelectGroup({ className, ...props }: SelectGroupProps) {
  return <div data-slot="select-group" className={cn(className)} {...props} />;
}

type SelectValueProps = React.HTMLAttributes<HTMLSpanElement> & {
  children?: React.ReactNode;
  placeholder?: React.ReactNode;
};

function SelectValue({ children, placeholder, className, ...props }: SelectValueProps) {
  const { selectedLabel, value } = useSelectContext();
  return (
    <span data-slot="select-value" className={cn("truncate", className)} {...props}>
      {children ?? selectedLabel ?? (value === undefined ? placeholder : null)}
    </span>
  );
}

type SelectTriggerProps = React.ButtonHTMLAttributes<HTMLButtonElement> & {
  children?: React.ReactNode;
  size?: SelectSize;
  /** When true, the label stays next to the chevron (width follows content). When false, the label grows to fill the trigger (full-width fields). */
  compact?: boolean;
};

function SelectTrigger({
  className,
  children,
  size = "default",
  compact = false,
  ...props
}: SelectTriggerProps) {
  const { disabled, open, setOpen, setTriggerNode } = useSelectContext();
  return (
    <button
      {...props}
      ref={setTriggerNode}
      type="button"
      data-size={size}
      data-slot="select-trigger"
      data-compact={compact ? "true" : undefined}
      aria-expanded={open}
      aria-haspopup="listbox"
      className={cn(
        "app-focus-ring app-surface-field app-border-subtle app-shadow-field min-w-0 rounded-[10px] border text-sm outline-none transition-colors disabled:cursor-not-allowed disabled:opacity-50",
        compact
          ? "!grid w-max max-w-full grid-cols-[minmax(0,1fr)_auto] items-center gap-1.5"
          : "flex w-fit max-w-full min-w-0 items-center gap-1.5",
        size === "sm" ? "h-8 px-2.5 text-xs" : "h-9 px-3 py-2",
        className,
      )}
      disabled={disabled || props.disabled}
      onClick={(event) => {
        props.onClick?.(event);
        if (!event.defaultPrevented && !disabled && !props.disabled) {
          setOpen(!open);
        }
      }}
    >
      <span className={cn("min-w-0 overflow-hidden text-left", compact ? "pr-0.5" : "flex-1")}>
        {children}
      </span>
      <ChevronDownIcon
        data-icon="inline-end"
        className="size-4 shrink-0 justify-self-end opacity-60"
      />
    </button>
  );
}

function SelectScrollUpButton() {
  return null;
}

function SelectScrollDownButton() {
  return null;
}

type SelectContentProps = {
  children?: React.ReactNode;
  className?: string;
  placement?: SelectPlacement;
};

type SelectContentPosition = {
  left: number;
  maxHeight: number;
  minWidth: number;
  placement: SelectPlacement;
  top: number;
  width: number | undefined;
};

const SELECT_VIEWPORT_PADDING = 8;
const SELECT_TRIGGER_GAP = 6;

function SelectContent({
  className,
  children,
  placement = "bottom",
  ...props
}: SelectContentProps) {
  const { open, setOpen, triggerNode, value } = useSelectContext();
  const contentRef = React.useRef<HTMLDivElement | null>(null);
  const [position, setPosition] = React.useState<SelectContentPosition>({
    left: SELECT_VIEWPORT_PADDING,
    maxHeight: 384,
    minWidth: 160,
    placement,
    top: SELECT_VIEWPORT_PADDING,
    width: undefined,
  });

  const updatePosition = React.useCallback(() => {
    if (!triggerNode || typeof window === "undefined") {
      return;
    }

    const rect = triggerNode.getBoundingClientRect();
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;
    const contentWidth = Math.min(
      Math.max(rect.width, 160),
      viewportWidth - SELECT_VIEWPORT_PADDING * 2,
    );
    const spaceBelow = viewportHeight - rect.bottom - SELECT_TRIGGER_GAP - SELECT_VIEWPORT_PADDING;
    const spaceAbove = rect.top - SELECT_TRIGGER_GAP - SELECT_VIEWPORT_PADDING;
    const resolvedPlacement =
      placement === "bottom" && spaceBelow < 180 && spaceAbove > spaceBelow
        ? "top"
        : placement === "top" && spaceAbove < 180 && spaceBelow > spaceAbove
          ? "bottom"
          : placement;

    const maxHeight =
      resolvedPlacement === "top" ? Math.max(120, spaceAbove) : Math.max(120, spaceBelow);
    const contentHeight = Math.min(contentRef.current?.scrollHeight ?? maxHeight, maxHeight);
    const top =
      resolvedPlacement === "top"
        ? Math.max(SELECT_VIEWPORT_PADDING, rect.top - SELECT_TRIGGER_GAP - contentHeight)
        : Math.min(rect.bottom + SELECT_TRIGGER_GAP, viewportHeight - SELECT_VIEWPORT_PADDING);
    const left = Math.max(
      SELECT_VIEWPORT_PADDING,
      Math.min(rect.left, viewportWidth - contentWidth - SELECT_VIEWPORT_PADDING),
    );

    setPosition({
      left,
      maxHeight,
      minWidth: Math.max(160, rect.width),
      placement: resolvedPlacement,
      top,
      width: rect.width,
    });
  }, [placement, triggerNode]);

  React.useLayoutEffect(() => {
    if (!open) {
      return;
    }
    updatePosition();
  }, [open, updatePosition]);

  React.useEffect(() => {
    if (!open || typeof window === "undefined" || typeof document === "undefined") {
      return;
    }

    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) {
        return;
      }
      if (triggerNode?.contains(target) || contentRef.current?.contains(target)) {
        return;
      }
      setOpen(false);
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      const target = event.target;
      const content = contentRef.current;
      const eventFromSelect =
        target instanceof Node && (triggerNode?.contains(target) || content?.contains(target));

      if (!eventFromSelect) {
        return;
      }

      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();
        setOpen(false);
        triggerNode?.focus();
        return;
      }

      if (
        event.key !== "ArrowDown" &&
        event.key !== "ArrowUp" &&
        event.key !== "Home" &&
        event.key !== "End"
      ) {
        return;
      }

      if (!content) {
        return;
      }

      const items = Array.from(content.querySelectorAll<HTMLElement>('[data-slot="select-item"]'));
      if (items.length === 0) {
        return;
      }

      event.preventDefault();
      const activeIndex =
        document.activeElement instanceof HTMLElement ? items.indexOf(document.activeElement) : -1;
      const selectedIndex = items.findIndex((item) => item.dataset.value === value);
      const fallbackIndex = selectedIndex >= 0 ? selectedIndex : 0;
      const currentIndex = activeIndex >= 0 ? activeIndex : fallbackIndex;
      const nextIndex =
        event.key === "Home"
          ? 0
          : event.key === "End"
            ? items.length - 1
            : event.key === "ArrowUp"
              ? (currentIndex - 1 + items.length) % items.length
              : (currentIndex + 1) % items.length;

      items[nextIndex]?.focus();
      items[nextIndex]?.scrollIntoView({ block: "nearest" });
    };

    window.addEventListener("resize", updatePosition);
    window.addEventListener("scroll", updatePosition, true);
    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown, true);
    return () => {
      window.removeEventListener("resize", updatePosition);
      window.removeEventListener("scroll", updatePosition, true);
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown, true);
    };
  }, [open, setOpen, triggerNode, updatePosition, value]);

  if (!open || typeof document === "undefined") {
    return null;
  }

  return createPortal(
    <div
      ref={contentRef}
      data-slot="select-content"
      data-placement={position.placement}
      className={cn(
        "app-surface-overlay app-border-subtle app-shadow-overlay fixed z-[1000] max-w-[min(24rem,calc(100vw-2rem))] overflow-hidden rounded-[12px] border text-popover-foreground",
        className,
      )}
      style={{
        left: position.left,
        minWidth: position.minWidth,
        top: position.top,
        width: position.width,
      }}
      {...props}
    >
      <div
        data-slot="select-viewport"
        role="listbox"
        aria-orientation="vertical"
        className="w-full overflow-auto p-1.5"
        style={{ maxHeight: position.maxHeight }}
      >
        {children}
      </div>
    </div>,
    document.body,
  );
}

function SelectLabel({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      data-slot="select-label"
      className={cn("px-2 py-1.5 text-sm font-semibold", className)}
      {...props}
    />
  );
}

type SelectItemProps = {
  children?: React.ReactNode;
  className?: string;
  textValue?: string;
  value: string;
};

function flattenSelectItemText(children: React.ReactNode): string {
  return React.Children.toArray(children)
    .flatMap((child) => {
      if (typeof child === "string" || typeof child === "number") {
        return [String(child)];
      }
      if (React.isValidElement<{ children?: React.ReactNode }>(child) && child.props.children) {
        return [flattenSelectItemText(child.props.children)];
      }
      return [];
    })
    .join(" ")
    .trim();
}

function SelectItem({ className, children, textValue, value }: SelectItemProps) {
  const { setValue, value: selectedValue } = useSelectContext();
  const resolvedTextValue = (textValue ?? flattenSelectItemText(children)) || value;
  const selected = selectedValue === value;

  return (
    <div
      data-slot="select-item"
      data-value={value}
      data-text-value={resolvedTextValue}
      data-state={selected ? "checked" : "unchecked"}
      role="option"
      aria-selected={selected}
      tabIndex={0}
      className={cn(
        "relative",
        "flex w-full min-w-0 cursor-pointer items-center justify-between gap-2 rounded-[8px] px-2 py-1.5 text-sm outline-none transition-colors",
        // Hover - subtle
        "hover:bg-accent/40 focus-visible:bg-accent/40",
        // Selected - more prominent
        "data-[state=checked]:bg-accent/90 data-[state=checked]:font-medium",
        className,
      )}
      onClick={() => setValue(value)}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          setValue(value);
        }
      }}
    >
      <span className="min-w-0 flex-1 truncate">{children}</span>
      {selected ? <CheckIcon className="size-4 shrink-0" /> : null}
    </div>
  );
}

function SelectSeparator({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      data-slot="select-separator"
      className={cn("-mx-1 my-1 h-px bg-border/70", className)}
      {...props}
    />
  );
}

function isSelectItemElement(child: React.ReactNode): child is React.ReactElement<SelectItemProps> {
  return React.isValidElement<SelectItemProps>(child) && child.type === SelectItem;
}

function findSelectItemLabel(
  children: React.ReactNode,
  value: string | undefined,
): React.ReactNode {
  if (value === undefined) {
    return null;
  }
  for (const child of React.Children.toArray(children)) {
    if (isSelectItemElement(child) && child.props.value === value) {
      return child.props.children;
    }
    if (React.isValidElement<{ children?: React.ReactNode }>(child)) {
      const nested = findSelectItemLabel(child.props.children, value);
      if (nested) {
        return nested;
      }
    }
  }
  return null;
}

export {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectScrollDownButton,
  SelectScrollUpButton,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
};
