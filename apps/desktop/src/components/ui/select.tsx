import { CheckIcon, ChevronDownIcon, ChevronUpIcon } from "lucide-react";
import * as SelectPrimitive from "@radix-ui/react-select";
import * as React from "react";

import { cn } from "@/lib/utils";

type SelectSize = "default" | "sm";
type SelectPlacement = "bottom" | "top" | "left" | "right";

type SelectProps = Omit<
  React.ComponentPropsWithoutRef<typeof SelectPrimitive.Root>,
  "defaultValue" | "disabled" | "onValueChange" | "value"
> & {
  value?: string;
  defaultValue?: string;
  disabled?: boolean;
  children: React.ReactNode;
  onValueChange?: (value: string) => void;
};

function Select({ value, defaultValue, disabled, children, onValueChange, ...props }: SelectProps) {
  return (
    <SelectPrimitive.Root
      defaultValue={defaultValue}
      disabled={disabled}
      onValueChange={onValueChange}
      value={value}
      {...props}
    >
      {children}
    </SelectPrimitive.Root>
  );
}

const SelectGroup = SelectPrimitive.Group;

type SelectValueProps = React.ComponentPropsWithoutRef<typeof SelectPrimitive.Value> & {
  children?: React.ReactNode;
  placeholder?: React.ReactNode;
};

function SelectValue({ children, placeholder, ...props }: SelectValueProps) {
  return (
    <SelectPrimitive.Value placeholder={placeholder} {...props}>
      {children}
    </SelectPrimitive.Value>
  );
}

type SelectTriggerProps = React.ComponentPropsWithoutRef<typeof SelectPrimitive.Trigger> & {
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
  return (
    <SelectPrimitive.Trigger
      data-size={size}
      data-slot="select-trigger"
      data-compact={compact ? "true" : undefined}
      className={cn(
        "app-focus-ring app-surface-field app-border-subtle app-shadow-field min-w-0 rounded-[10px] border text-sm outline-none transition-colors disabled:cursor-not-allowed disabled:opacity-50",
        compact
          ? "!grid w-max max-w-full grid-cols-[minmax(0,1fr)_auto] items-center gap-1.5"
          : "flex w-fit max-w-full min-w-0 items-center gap-1.5",
        size === "sm" ? "h-8 px-2.5 text-xs" : "h-9 px-3 py-2",
        className,
      )}
      {...props}
    >
      <span className={cn("min-w-0 overflow-hidden text-left", compact ? "pr-0.5" : "flex-1")}>
        {children}
      </span>
      <SelectPrimitive.Icon asChild>
        <ChevronDownIcon
          data-icon="inline-end"
          className="size-4 shrink-0 justify-self-end opacity-60"
        />
      </SelectPrimitive.Icon>
    </SelectPrimitive.Trigger>
  );
}

function SelectScrollUpButton({
  className,
  ...props
}: React.ComponentPropsWithoutRef<typeof SelectPrimitive.ScrollUpButton>) {
  return (
    <SelectPrimitive.ScrollUpButton
      data-slot="select-scroll-up-button"
      className={cn("flex cursor-default items-center justify-center py-1", className)}
      {...props}
    >
      <ChevronUpIcon className="size-4" />
    </SelectPrimitive.ScrollUpButton>
  );
}

function SelectScrollDownButton({
  className,
  ...props
}: React.ComponentPropsWithoutRef<typeof SelectPrimitive.ScrollDownButton>) {
  return (
    <SelectPrimitive.ScrollDownButton
      data-slot="select-scroll-down-button"
      className={cn("flex cursor-default items-center justify-center py-1", className)}
      {...props}
    >
      <ChevronDownIcon className="size-4" />
    </SelectPrimitive.ScrollDownButton>
  );
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
  return (
    <SelectPrimitive.Portal>
      <SelectPrimitive.Content
        data-slot="select-content"
        className={cn(
          "app-surface-overlay app-border-subtle app-shadow-overlay relative z-50 w-max max-w-[min(24rem,calc(100vw-2rem))] min-w-[10rem] overflow-hidden rounded-[12px] border text-popover-foreground",
          className,
        )}
        position="popper"
        side={placement}
        sideOffset={4}
        {...props}
      >
        <SelectScrollUpButton />
        <SelectPrimitive.Viewport
          data-slot="select-viewport"
          className="max-h-96 w-full overflow-auto p-1.5"
        >
          {children}
        </SelectPrimitive.Viewport>
        <SelectScrollDownButton />
      </SelectPrimitive.Content>
    </SelectPrimitive.Portal>
  );
}

function SelectLabel({
  className,
  ...props
}: React.ComponentPropsWithoutRef<typeof SelectPrimitive.Label>) {
  return (
    <SelectPrimitive.Label
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
  const resolvedTextValue = (textValue ?? flattenSelectItemText(children)) || value;

  return (
    <SelectPrimitive.Item
      data-slot="select-item"
      value={value}
      textValue={resolvedTextValue}
      className={cn(
        "relative",
        "flex w-full min-w-0 cursor-pointer items-center justify-between gap-2 rounded-[8px] px-2 py-1.5 text-sm outline-none transition-colors",
        // Hover - subtle
        "hover:bg-accent/40 data-[highlighted]:bg-accent/40",
        // Selected - more prominent
        "data-[state=checked]:bg-accent/90 data-[state=checked]:font-medium",
        "data-[disabled]:pointer-events-none data-[disabled]:opacity-50",
        className,
      )}
    >
      <SelectPrimitive.ItemText asChild>
        <span className="min-w-0 flex-1 truncate">{children}</span>
      </SelectPrimitive.ItemText>
      <SelectPrimitive.ItemIndicator className="shrink-0">
        <CheckIcon className="size-4" />
      </SelectPrimitive.ItemIndicator>
    </SelectPrimitive.Item>
  );
}

function SelectSeparator({
  className,
  ...props
}: React.ComponentPropsWithoutRef<typeof SelectPrimitive.Separator>) {
  return (
    <SelectPrimitive.Separator
      data-slot="select-separator"
      className={cn("-mx-1 my-1 h-px bg-border/70", className)}
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
