import * as React from "react";
import { Button as HeroButton } from "@heroui/react";

import { cn } from "@/lib/utils";

type ButtonVariant = "default" | "secondary" | "destructive" | "outline" | "ghost" | "link";
type ButtonSize = "default" | "sm" | "lg" | "icon" | "icon-sm";

type HeroButtonPressEvent = Parameters<NonNullable<React.ComponentProps<typeof HeroButton>["onPress"]>>[0];

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
    "transition-colors [&>[data-icon]]:pointer-events-none [&>[data-icon]]:shrink-0",
    variant === "link" && "h-auto px-0 py-0 text-primary underline-offset-4 hover:underline",
    size === "default" && "[&>[data-icon]]:size-4",
    size === "sm" && "text-xs [&>[data-icon]]:size-3.5",
    size === "lg" && "[&>[data-icon]]:size-4",
    size === "icon" && "size-9 min-w-9 px-0 [&>[data-icon]]:size-4",
    size === "icon-sm" && "size-8 min-w-8 px-0 [&>[data-icon]]:size-3.5",
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
    } as React.HTMLAttributes<HTMLElement>;

    return React.cloneElement(child, childProps);
  }

  const handlePress = React.useCallback((event: HeroButtonPressEvent) => {
    onPress?.(event);
    if (!onClick) {
      return;
    }

    const compatEvent = {
      defaultPrevented: false,
      preventDefault() {
        this.defaultPrevented = true;
      },
      stopPropagation() {},
    } as React.MouseEvent<HTMLButtonElement>;

    onClick(compatEvent);
  }, [onClick, onPress]);

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
      onPress={handlePress}
      size={mapSize(size)}
      variant={mapVariant(variant)}
    >
      {children}
    </HeroButton>
  );
});

Button.displayName = "Button";

export { Button, buttonVariants };
