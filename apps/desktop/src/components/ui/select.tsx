import * as React from "react";
import { CheckIcon, ChevronDownIcon } from "lucide-react";

import { cn } from "@/lib/utils";

type SelectSize = "default" | "sm";
type SelectContextValue = {
  size: SelectSize;
  value?: string;
  defaultValue?: string;
  disabled?: boolean;
  onValueChange?: (value: string) => void;
  open: boolean;
  setOpen: (open: boolean) => void;
};

const SelectContext = React.createContext<SelectContextValue | null>(null);

function useSelectContext(): SelectContextValue {
  const context = React.useContext(SelectContext);
  if (!context) {
    throw new Error("Select components must be used within <Select>");
  }
  return context;
}

type SelectProps = {
  value?: string;
  defaultValue?: string;
  disabled?: boolean;
  children: React.ReactNode;
  onValueChange?: (value: string) => void;
};

function Select({ value, defaultValue, disabled, onValueChange, children }: SelectProps) {
  const [internalOpen, setInternalOpen] = React.useState(false);

  return (
    <SelectContext.Provider
      value={{
        value,
        defaultValue,
        disabled,
        onValueChange,
        size: "default",
        open: internalOpen,
        setOpen: setInternalOpen,
      }}
    >
      <div className="relative">{children}</div>
    </SelectContext.Provider>
  );
}

function SelectGroup({ className, children, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div data-slot="select-group" className={cn(className)} {...props}>
      {children}
    </div>
  );
}

function SelectValue({ placeholder, children, className, ...props }: React.HTMLAttributes<HTMLSpanElement> & { placeholder?: string }) {
  const { value } = useSelectContext();

  return (
    <span data-slot="select-value" className={cn("truncate", !value && "text-muted-foreground", className)} {...props}>
      {value ?? placeholder ?? children}
    </span>
  );
}

function SelectTrigger({
  className,
  children,
  size = "default",
  onClick,
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & {
  size?: SelectSize;
}) {
  const context = useSelectContext();

  return (
    <button
      type="button"
      data-size={size}
      data-slot="select-trigger"
      aria-expanded={context.open}
      className={cn(
        "flex w-fit min-w-40 items-center justify-between gap-2 rounded-md border border-border bg-background text-sm text-foreground shadow-sm outline-none transition-colors disabled:cursor-not-allowed disabled:opacity-50",
        size === "sm" ? "h-8 px-2.5 text-xs" : "h-9 px-3 py-2",
        className,
      )}
      disabled={context.disabled}
      onClick={(event) => {
        context.setOpen(!context.open);
        onClick?.(event);
      }}
      {...props}
    >
      {children}
      <ChevronDownIcon className="size-4 opacity-60" />
    </button>
  );
}

function SelectScrollUpButton({ className, ...props }: React.ComponentProps<"div">) {
  return <div data-slot="select-scroll-up-button" className={cn(className)} {...props} />;
}

function SelectScrollDownButton({ className, ...props }: React.ComponentProps<"div">) {
  return <div data-slot="select-scroll-down-button" className={cn(className)} {...props} />;
}

function SelectContent({ className, children, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  const context = useSelectContext();
  if (!context.open) {
    return null;
  }

  return (
    <div
      data-slot="select-content"
      className={cn(
        "absolute left-0 top-[calc(100%+0.25rem)] z-[120] min-w-full rounded-md border border-border bg-popover text-popover-foreground shadow-md",
        className,
      )}
      {...props}
    >
      <div data-slot="select-viewport" className="max-h-96 overflow-auto p-1">
        {children}
      </div>
    </div>
  );
}

function SelectLabel({ className, children, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      data-slot="select-label"
      className={cn("px-2 py-1.5 text-sm font-semibold", className)}
      {...props}
    >
      {children}
    </div>
  );
}

type SelectItemProps = React.ButtonHTMLAttributes<HTMLButtonElement> & {
  value: string;
};

function SelectItem({ className, children, value, onClick, ...props }: SelectItemProps) {
  const context = useSelectContext();
  const size = context.size;

  return (
    <button
      type="button"
      data-slot="select-item"
      className={cn(
        "relative flex w-full cursor-default select-none items-center rounded-sm py-1.5 pr-8 pl-2 text-sm outline-none transition-colors hover:bg-muted hover:text-foreground disabled:pointer-events-none disabled:opacity-50",
        size === "sm" ? "text-xs" : null,
        className,
      )}
      onClick={(event) => {
        context.onValueChange?.(value);
        context.setOpen(false);
        onClick?.(event);
      }}
      {...props}
    >
      {children}
      <span className="absolute right-2 flex size-3.5 items-center justify-center">
        <CheckIcon className="size-4" />
      </span>
    </button>
  );
}

function SelectSeparator({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="select-separator"
      className={cn("-mx-1 my-1 h-px bg-border", className)}
      {...props}
    />
  );
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
