import * as React from "react";
import { Header } from "react-aria-components";
import { ListBox, Select as HeroSelect, Separator as HeroSeparator } from "@heroui/react";

import { cn } from "@/lib/utils";

type SelectSize = "default" | "sm";
type HeroSelectProps = React.ComponentProps<typeof HeroSelect>;
type HeroSelectTriggerProps = React.ComponentProps<typeof HeroSelect.Trigger>;
type HeroSelectValueProps = React.ComponentProps<typeof HeroSelect.Value>;
type HeroSelectPopoverProps = React.ComponentProps<typeof HeroSelect.Popover>;
type HeroSelectPlacement = HeroSelectPopoverProps["placement"];

type SelectProps = Omit<
  HeroSelectProps,
  "children" | "defaultValue" | "isDisabled" | "onChange" | "value" | "variant"
> & {
  value?: string;
  defaultValue?: string;
  disabled?: boolean;
  children: React.ReactNode;
  onValueChange?: (value: string) => void;
};

function Select({
  value,
  defaultValue,
  disabled,
  children,
  onValueChange,
  ...props
}: SelectProps) {
  return (
    <HeroSelect
      data-slot="select"
      defaultValue={defaultValue}
      isDisabled={disabled}
      onChange={(nextValue) => {
        if (nextValue == null || Array.isArray(nextValue)) {
          return;
        }
        onValueChange?.(String(nextValue));
      }}
      value={value}
      variant="secondary"
      {...props}
    >
      {children}
    </HeroSelect>
  );
}

type SelectGroupProps = {
  children?: React.ReactNode;
  className?: string;
};

function SelectGroup({ className, children }: SelectGroupProps) {
  return (
    <ListBox.Section data-slot="select-group" className={cn(className)}>
      {children}
    </ListBox.Section>
  );
}

type SelectValueProps = Omit<HeroSelectValueProps, "children"> & {
  children?: React.ReactNode;
  placeholder?: React.ReactNode;
};

function SelectValue({
  className,
  children,
  placeholder,
  ...props
}: SelectValueProps) {
  return (
    <HeroSelect.Value
      data-slot="select-value"
      className={cn("truncate", className)}
      {...props}
    >
      {(values: { defaultChildren?: React.ReactNode; isPlaceholder?: boolean }) => {
        if (values.isPlaceholder && placeholder !== undefined) {
          return placeholder;
        }
        return children ?? values.defaultChildren;
      }}
    </HeroSelect.Value>
  );
}

type SelectTriggerProps = Omit<HeroSelectTriggerProps, "children"> & {
  children?: React.ReactNode;
  size?: SelectSize;
};

function SelectTrigger({
  className,
  children,
  size = "default",
  ...props
}: SelectTriggerProps) {
  return (
    <HeroSelect.Trigger
      data-size={size}
      data-slot="select-trigger"
      className={cn(
        "app-focus-ring app-surface-field app-border-subtle app-shadow-field flex w-fit min-w-40 items-center justify-between gap-2 rounded-[10px] border text-sm outline-none transition-colors disabled:cursor-not-allowed disabled:opacity-50",
        size === "sm" ? "h-8 px-2.5 text-xs" : "h-9 px-3 py-2",
        className,
      )}
      {...props}
    >
      {children}
      <HeroSelect.Indicator className="size-4 opacity-60" />
    </HeroSelect.Trigger>
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
  placement?: HeroSelectPlacement;
};

function SelectContent({
  className,
  children,
  placement = "bottom",
  ...props
}: SelectContentProps) {
  return (
    <HeroSelect.Popover
      data-slot="select-content"
      className={cn("min-w-full", className)}
      placement={placement}
      {...props}
    >
      <ListBox data-slot="select-viewport" className="max-h-96 overflow-auto p-1">
        {children}
      </ListBox>
    </HeroSelect.Popover>
  );
}

type SelectLabelProps = React.HTMLAttributes<HTMLDivElement>;

function SelectLabel({
  className,
  children,
  ...props
}: SelectLabelProps) {
  return (
    <Header
      data-slot="select-label"
      className={cn("px-2 py-1.5 text-sm font-semibold", className)}
      {...props}
    >
      {children}
    </Header>
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

function SelectItem({
  className,
  children,
  textValue,
  value,
}: SelectItemProps) {
  const resolvedTextValue = (textValue ?? flattenSelectItemText(children)) || value;

  return (
    <ListBox.Item
      data-slot="select-item"
      id={value}
      textValue={resolvedTextValue}
      className={cn("text-sm", className)}
    >
      {children}
      <ListBox.ItemIndicator />
    </ListBox.Item>
  );
}

function SelectSeparator({
  className,
  ...props
}: React.ComponentPropsWithoutRef<typeof HeroSeparator>) {
  return (
    <HeroSeparator
      data-slot="select-separator"
      className={cn("-mx-1 my-1", className)}
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
