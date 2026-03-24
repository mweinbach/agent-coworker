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
};

const SelectContext = React.createContext<SelectContextValue>({ size: "default" });

type SelectProps = {
  value?: string;
  defaultValue?: string;
  disabled?: boolean;
  children: React.ReactNode;
  onValueChange?: (value: string) => void;
};

function Select({ value, defaultValue, disabled, onValueChange, children }: SelectProps) {
  return (
    <SelectContext.Provider value={{ value, defaultValue, disabled, onValueChange, size: "default" }}>
      {children}
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
  const { value } = React.useContext(SelectContext);

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
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & {
  size?: SelectSize;
}) {
  const { disabled } = React.useContext(SelectContext);

  return (
    <button
      type="button"
      data-size={size}
      data-slot="select-trigger"
      className={cn(
        "flex w-fit min-w-40 items-center justify-between gap-2 rounded-md border border-border bg-background text-sm text-foreground shadow-sm outline-none transition-colors disabled:cursor-not-allowed disabled:opacity-50",
        size === "sm" ? "h-8 px-2.5 text-xs" : "h-9 px-3 py-2",
        className,
      )}
      disabled={disabled}
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
  return (
    <div
      data-slot="select-content"
      className={cn(
        "relative z-50 min-w-[8rem] rounded-md border border-border bg-popover text-popover-foreground shadow-md",
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
  const { size, onValueChange } = React.useContext(SelectContext);

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
        onValueChange?.(value);
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
