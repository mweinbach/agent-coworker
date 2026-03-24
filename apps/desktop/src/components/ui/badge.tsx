import * as React from "react";
import { Chip, chipVariants, type ChipVariants } from "@heroui/react";

import { cn } from "@/lib/utils";

type BadgeVariant = "default" | "secondary" | "destructive" | "outline";

const BADGE_VARIANT_MAP: Record<BadgeVariant, NonNullable<ChipVariants["variant"]>> = {
  default: "primary",
  secondary: "secondary",
  destructive: "primary",
  outline: "tertiary",
};

const BADGE_COLOR_MAP: Record<BadgeVariant, NonNullable<ChipVariants["color"]>> = {
  default: "accent",
  secondary: "default",
  destructive: "danger",
  outline: "default",
};

const badgeVariants = ({
  variant = "default",
  className,
}: {
  variant?: BadgeVariant | null;
  className?: string;
} = {}) =>
  chipVariants({
    color: BADGE_COLOR_MAP[variant ?? "default"],
    size: "sm",
    variant: BADGE_VARIANT_MAP[variant ?? "default"],
    className,
  });

type BadgeProps = Omit<React.ComponentProps<typeof Chip>, "color" | "variant" | "size"> & {
  variant?: BadgeVariant;
};

function Badge({ className, variant = "default", children, ...props }: BadgeProps) {
  return (
    <Chip
      data-slot="badge"
      data-variant={variant}
      color={BADGE_COLOR_MAP[variant]}
      size="sm"
      variant={BADGE_VARIANT_MAP[variant]}
      className={cn("min-h-0 rounded-md shadow-none", className)}
      {...props}
    >
      {children}
    </Chip>
  );
}

export { Badge, badgeVariants };
