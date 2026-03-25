import * as React from "react";
import {
  Card as HeroCard,
  CardContent as HeroCardContent,
  CardDescription as HeroCardDescription,
  CardFooter as HeroCardFooter,
  CardHeader as HeroCardHeader,
  CardTitle as HeroCardTitle,
  type CardProps as HeroCardProps,
} from "@heroui/react";

import { cn } from "@/lib/utils";

type CardProps = Omit<HeroCardProps, "variant"> & {
  variant?: "default" | "secondary" | "tertiary" | "transparent";
};

function Card({ className, variant = "default", ...props }: CardProps) {
  return (
    <HeroCard
      data-slot="card"
      variant={variant}
      className={cn(
        "app-surface-card app-border-subtle rounded-[calc(var(--radius)*1.35)] border text-card-foreground shadow-none",
        className,
      )}
      {...props}
    />
  );
}

function CardHeader({ className, ...props }: React.ComponentProps<typeof HeroCardHeader>) {
  return (
    <HeroCardHeader
      data-slot="card-header"
      className={cn("flex flex-col gap-1.5 p-4", className)}
      {...props}
    />
  );
}

function CardTitle({ className, ...props }: React.ComponentProps<typeof HeroCardTitle>) {
  return (
    <HeroCardTitle
      data-slot="card-title"
      className={cn("font-semibold leading-none tracking-tight", className)}
      {...props}
    />
  );
}

function CardDescription({
  className,
  ...props
}: React.ComponentProps<typeof HeroCardDescription>) {
  return (
    <HeroCardDescription
      data-slot="card-description"
      className={cn("app-text-muted text-[13px]", className)}
      {...props}
    />
  );
}

function CardAction({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card-action"
      className={cn("self-start justify-self-end", className)}
      {...props}
    />
  );
}

function CardContent({ className, ...props }: React.ComponentProps<typeof HeroCardContent>) {
  return (
    <HeroCardContent
      data-slot="card-content"
      className={cn("p-4 pt-0", className)}
      {...props}
    />
  );
}

function CardFooter({ className, ...props }: React.ComponentProps<typeof HeroCardFooter>) {
  return (
    <HeroCardFooter
      data-slot="card-footer"
      className={cn("flex items-center p-4 pt-0", className)}
      {...props}
    />
  );
}

export { Card, CardAction, CardContent, CardDescription, CardFooter, CardHeader, CardTitle };
