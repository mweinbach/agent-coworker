import * as React from "react";
import { Input as HeroInput } from "@heroui/react";

import { cn } from "@/lib/utils";

function Input({ className, type, ...props }: React.ComponentProps<"input">) {
  return (
    <HeroInput
      data-slot="input"
      className={cn(
        "h-10 w-full rounded-md border border-border bg-background text-sm text-foreground shadow-sm transition-colors [&_[data-slot=input]]:h-10 [&_[data-slot=input]]:bg-transparent [&_[data-slot=input]]:px-3 [&_[data-slot=input]]:py-2 [&_[data-slot=input]]:text-sm [&_[data-slot=input]]:text-foreground [&_[data-slot=input]]:placeholder:text-muted-foreground [&_[data-slot=input]]:outline-none",
        className,
      )}
      fullWidth
      type={type}
      variant="secondary"
      {...props}
    />
  );
}

export { Input };
