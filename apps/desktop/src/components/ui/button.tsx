import * as React from "react";
import { Button as HeroButton } from "@heroui/react";

import { cn } from "@/lib/utils";

type ButtonVariant = "default" | "secondary" | "destructive" | "outline" | "ghost" | "link";
type ButtonSize = "default" | "sm" | "lg" | "icon" | "icon-sm";

type HeroButtonPressEvent = Parameters<NonNullable<React.ComponentProps<typeof HeroButton>["onPress"]>>[0];

function assignRef<T>(ref: React.Ref<T> | undefined, value: T | null) {
  if (!ref) {
    return;
  }
  if (typeof ref === "function") {
    ref(value);
    return;
  }
  (ref as React.MutableRefObject<T | null>).current = value;
}

function composeRefs<T>(...refs: Array<React.Ref<T> | undefined>): React.RefCallback<T> {
  return (value) => {
    for (const ref of refs) {
      assignRef(ref, value);
    }
  };
}

function getElementRef<T>(element: React.ReactElement): React.Ref<T> | undefined {
  const withPossibleRef = element as React.ReactElement & {
    ref?: React.Ref<T>;
    props: { ref?: React.Ref<T> };
  };
  return withPossibleRef.props.ref ?? withPossibleRef.ref;
}

type ButtonProps = Omit<React.ComponentProps<typeof HeroButton>, "variant" | "size" | "onPress" | "isDisabled"> & {
  variant?: ButtonVariant;
  size?: ButtonSize;
  asChild?: boolean;
  onClick?: React.MouseEventHandler<HTMLButtonElement>;
  onPress?: React.ComponentProps<typeof HeroButton>["onPress"];
  disabled?: boolean;
  title?: string;
};

function mapVariant(variant: ButtonVariant | undefined): NonNullable<React.ComponentProps<typeof HeroButton>["variant"]> {
  switch (variant) {
    case "secondary":
      return "secondary";
    case "destructive":
      return "danger";
    case "outline":
      return "outline";
    case "ghost":
      return "ghost";
    case "link":
      return "ghost";
    case "default":
    default:
      return "primary";
  }
}

function mapSize(size: ButtonSize | undefined): NonNullable<React.ComponentProps<typeof HeroButton>["size"]> {
  switch (size) {
    case "sm":
    case "icon-sm":
      return "sm";
    case "lg":
      return "lg";
    case "default":
    case "icon":
    default:
      return "md";
  }
}

const buttonVariantStyles: Record<ButtonVariant, string> = {
  default: "border border-transparent bg-primary text-primary-foreground shadow-none hover:bg-primary/85",
  secondary: "border border-border/70 bg-muted/40 text-foreground shadow-none hover:bg-muted/60",
  destructive: "border border-transparent bg-destructive/10 text-destructive shadow-none hover:bg-destructive/20 hover:text-destructive",
  outline: "border border-border/70 bg-background/80 text-foreground shadow-none hover:bg-muted/30 hover:text-foreground",
  ghost: "border border-transparent bg-transparent text-foreground shadow-none hover:bg-muted/40 hover:text-foreground",
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
    "rounded-[calc(var(--radius)*0.95)] font-medium transition-colors [&>[data-icon]]:pointer-events-none [&>[data-icon]]:shrink-0",
    size === "default" && "h-9 px-3.5 text-[13px] [&>[data-icon]]:size-4",
    size === "sm" && "h-8 px-3 text-[12px] [&>[data-icon]]:size-3.5",
    size === "lg" && "h-10 px-4 text-[13px] [&>[data-icon]]:size-4",
    size === "icon" && "size-8 min-w-8 px-0 [&>[data-icon]]:size-4",
    size === "icon-sm" && "size-7 min-w-7 px-0 [&>[data-icon]]:size-3.5",
    buttonVariantStyles[variant],
    className,
  );
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(function Button({
  className,
  variant = "default",
  size = "default",
  asChild = false,
  onClick,
  onPress,
  disabled,
  children,
  ...props
}, ref) {
  if (asChild && React.isValidElement(children)) {
    const child = children as React.ReactElement<React.HTMLAttributes<HTMLElement>>;
    const childProps = {
      ...child.props,
      ...props,
      className: buttonVariants({
        variant,
        size,
        className: cn(className, child.props.className),
      }),
      onClick: (event: React.MouseEvent<HTMLElement>) => {
        child.props.onClick?.(event);
        onClick?.(event as React.MouseEvent<HTMLButtonElement>);
      },
      ref: composeRefs(
        getElementRef<HTMLElement>(child),
        ref as React.Ref<HTMLElement>,
      ),
    } as React.HTMLAttributes<HTMLElement>;

    return React.cloneElement(child, childProps);
  }

  return (
    <HeroButton
      {...props}
      ref={ref}
      className={buttonVariants({
        variant,
        size,
        className: typeof className === "string" ? className : undefined,
      })}
      data-size={size}
      data-slot="button"
      data-variant={variant}
      isDisabled={disabled}
      isIconOnly={size === "icon" || size === "icon-sm"}
      onClick={onClick as React.ComponentProps<typeof HeroButton>["onClick"]}
      onPress={onPress as ((event: HeroButtonPressEvent) => void) | undefined}
      size={mapSize(size)}
      variant={mapVariant(variant)}
    >
      {children}
    </HeroButton>
  );
});

Button.displayName = "Button";

export { Button, buttonVariants };
