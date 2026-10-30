import { cva, type VariantProps } from "class-variance-authority";
import { Slot } from "radix-ui";
import type * as React from "react";

import { cn } from "@/lib/utils";

// Push buttons are capsules, as on macOS 26; ghost and link buttons keep a soft
// rectangle because they double as list rows and inline actions.
const buttonVariants = cva(
  "inline-flex shrink-0 items-center justify-center gap-2 text-sm font-medium whitespace-nowrap transition-[color,background-color,border-color,box-shadow,transform,scale] duration-150 ease-out outline-none select-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        default:
          "rounded-full bg-primary text-primary-foreground hover:bg-primary-hover active:scale-[0.97]",
        destructive:
          "rounded-full bg-destructive text-destructive-foreground hover:bg-destructive-hover active:scale-[0.97]",
        outline:
          "rounded-full border border-border/60 bg-background shadow-xs hover:bg-accent hover:text-accent-foreground active:scale-[0.97] dark:border-input/60 dark:bg-input/30 dark:hover:bg-input/50",
        secondary:
          "rounded-full bg-secondary text-secondary-foreground hover:bg-secondary/80 active:scale-[0.97]",
        ghost: "rounded-md hover:bg-accent hover:text-accent-foreground dark:hover:bg-accent/50",
        link: "rounded-md text-primary underline-offset-4 hover:underline",
      },
      size: {
        default: "h-9 px-4 py-2 has-[>svg]:px-3",
        xs: "h-6 gap-1 px-2 text-xs has-[>svg]:px-1.5 [&_svg:not([class*='size-'])]:size-3",
        sm: "h-8 gap-1.5 px-3 has-[>svg]:px-2.5",
        lg: "h-10 px-6 has-[>svg]:px-4",
        icon: "size-9 active:scale-[0.97]",
        "icon-xs": "size-6 active:scale-[0.97] [&_svg:not([class*='size-'])]:size-3",
        "icon-sm": "size-8 active:scale-[0.97]",
        "icon-lg": "size-10 active:scale-[0.97]",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  },
);

function Button({
  className,
  variant = "default",
  size = "default",
  asChild = false,
  ...props
}: React.ComponentProps<"button"> &
  VariantProps<typeof buttonVariants> & {
    asChild?: boolean;
  }) {
  const Comp = asChild ? Slot.Root : "button";

  return (
    <Comp
      data-slot="button"
      data-variant={variant}
      data-size={size}
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  );
}

type AccessibleIconButtonProps = Omit<
  React.ComponentProps<typeof Button>,
  "aria-label" | "children" | "size"
> & {
  children: React.ReactNode;
  label: string;
  size?: "icon" | "icon-xs" | "icon-sm" | "icon-lg";
};

function AccessibleIconButton({
  children,
  label,
  size = "icon",
  title,
  ...props
}: AccessibleIconButtonProps) {
  return (
    <Button aria-label={label} size={size} title={title ?? label} {...props}>
      {children}
    </Button>
  );
}

export { AccessibleIconButton, Button, buttonVariants };
