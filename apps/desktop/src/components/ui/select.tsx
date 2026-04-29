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
  setValue: (value: string) => void;
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
        setValue,
        value: selectedValue,
      }}
    >
      {props.name ? <input name={props.name} type="hidden" value={selectedValue ?? ""} /> : null}
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
  const { disabled, open, setOpen } = useSelectContext();
  return (
    <button
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
      {...props}
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

function SelectContent({
  className,
  children,
  placement = "bottom",
  ...props
}: SelectContentProps) {
  const { open } = useSelectContext();
  if (!open || typeof document === "undefined") {
    return null;
  }

  return createPortal(
    <div
      data-slot="select-content"
      data-placement={placement}
      className={cn(
        "app-surface-overlay app-border-subtle app-shadow-overlay fixed left-4 top-4 z-50 w-max max-w-[min(24rem,calc(100vw-2rem))] min-w-[10rem] overflow-hidden rounded-[12px] border text-popover-foreground",
        className,
      )}
      {...props}
    >
      <div data-slot="select-viewport" className="max-h-96 w-full overflow-auto p-1.5">
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

function isSelectItemElement(
  child: React.ReactNode,
): child is React.ReactElement<SelectItemProps> {
  return React.isValidElement<SelectItemProps>(child) && child.type === SelectItem;
}

function findSelectItemLabel(children: React.ReactNode, value: string | undefined): React.ReactNode {
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
