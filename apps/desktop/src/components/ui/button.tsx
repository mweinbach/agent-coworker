import * as React from "react";

import { assignComposedRefs, getElementRef } from "@/lib/react-ref";
import { cn } from "@/lib/utils";

type ButtonVariant = "default" | "secondary" | "destructive" | "outline" | "ghost" | "link";
type ButtonSize = "default" | "sm" | "lg" | "icon" | "icon-sm";

type ButtonProps = Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, "disabled"> & {
  variant?: ButtonVariant;
  size?: ButtonSize;
  asChild?: boolean;
  disabled?: boolean;
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

const buttonVariantStyles: Record<ButtonVariant, string> = {
  default:
    "border border-transparent bg-primary text-primary-foreground shadow-none hover:bg-primary/85",
  secondary: "border border-border/70 bg-muted/40 text-foreground shadow-none hover:bg-muted/60",
  destructive:
    "border border-transparent bg-destructive/10 text-destructive shadow-none hover:bg-destructive/20 hover:text-destructive",
  outline:
    "border border-border/70 bg-background/80 text-foreground shadow-none hover:bg-muted/30 hover:text-foreground",
  ghost:
    "border border-transparent bg-transparent text-foreground shadow-none hover:bg-muted/40 hover:text-foreground",
  link: "h-auto px-0 py-0 text-primary underline-offset-4 hover:underline",
};

function buttonVariants({
  variant = "default",
  size = "default",
  className,
}: {
  variant?: ButtonVariant;
  size?: ButtonSize;
  className?: string;
} = {}): string {
  return cn(
    "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-[calc(var(--radius)*0.95)] font-medium transition-colors disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50 aria-disabled:pointer-events-none aria-disabled:cursor-not-allowed aria-disabled:opacity-50 [&>[data-icon]]:pointer-events-none [&>[data-icon]]:shrink-0",
    size === "default" && "h-9 px-3.5 text-[13px] [&>[data-icon]]:size-4",
    size === "sm" && "h-8 px-3 text-[12px] [&>[data-icon]]:size-3.5",
    size === "lg" && "h-10 px-4 text-[13px] [&>[data-icon]]:size-4",
    size === "icon" && "size-8 min-w-8 px-0 [&>[data-icon]]:size-4",
    size === "icon-sm" && "size-7 min-w-7 px-0 [&>[data-icon]]:size-3.5",
    buttonVariantStyles[variant],
    className,
  );
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  {
    className,
    variant = "default",
    size = "default",
    asChild = false,
    disabled,
    children,
    onClick,
    tabIndex,
    type,
    ...props
  },
  ref,
) {
  const handleClick = React.useCallback(
    (event: React.MouseEvent<HTMLButtonElement>) => {
      if (disabled) {
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      onClick?.(event);
    },
    [disabled, onClick],
  );

  const commonProps = {
    ...props,
    className: buttonVariants({
      variant,
      size,
      className,
    }),
    "data-size": size,
    "data-slot": "button",
    "data-variant": variant,
  } as const;

  if (asChild && React.isValidElement(children)) {
    const child = children as React.ReactElement<{
      "aria-disabled"?: boolean | "false" | "true";
      className?: string;
      disabled?: boolean;
      onClick?: React.MouseEventHandler<HTMLButtonElement>;
      ref?: React.Ref<HTMLElement>;
      tabIndex?: number;
      type?: React.ButtonHTMLAttributes<HTMLButtonElement>["type"];
    }>;
    const childAriaDisabled = child.props["aria-disabled"];
    const childDisabled =
      child.props.disabled === true || childAriaDisabled === true || childAriaDisabled === "true";
    const asChildDisabled = disabled === true || childDisabled;
    const childSupportsNativeDisabled =
      typeof child.type === "string" && nativeDisabledElements.has(child.type);

    return React.cloneElement(child, {
      ...commonProps,
      "aria-disabled": asChildDisabled
        ? true
        : (child.props["aria-disabled"] ?? props["aria-disabled"]),
      className: cn(commonProps.className, child.props.className),
      disabled:
        child.props.disabled === true || (disabled === true && childSupportsNativeDisabled)
          ? true
          : undefined,
      tabIndex: asChildDisabled ? -1 : (child.props.tabIndex ?? tabIndex),
      type: child.props.type ?? type,
      onClick: (event: React.MouseEvent<HTMLButtonElement>) => {
        if (asChildDisabled) {
          event.preventDefault();
          event.stopPropagation();
          return;
        }
        child.props.onClick?.(event);
        if (event.defaultPrevented) {
          return;
        }
        onClick?.(event);
      },
      ref: (node: HTMLElement | null) => {
        assignComposedRefs(node, getElementRef<HTMLElement>(child), ref as React.Ref<HTMLElement>);
      },
    });
  }

  if (asChild) {
    if (process.env.NODE_ENV !== "production") {
      console.warn("Button with asChild expects exactly one valid React element child.");
    }
    return null;
  }

  return (
    <button
      {...commonProps}
      ref={ref}
      type={type ?? "button"}
      onClick={handleClick}
      tabIndex={tabIndex}
      aria-disabled={props["aria-disabled"]}
      disabled={disabled}
    >
      {children}
    </button>
  );
});

Button.displayName = "Button";

export { Button, buttonVariants };
