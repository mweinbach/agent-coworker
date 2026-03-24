import * as React from "react";
import { Input as HeroInput } from "@heroui/react";

import { cn } from "@/lib/utils";

const Input = React.forwardRef<HTMLInputElement, React.ComponentPropsWithoutRef<typeof HeroInput>>(
  function Input({ className, type, ...props }, ref) {
    return (
      <HeroInput
        ref={ref}
        data-slot="input"
        className={cn(
          "h-9 w-full rounded-[10px] border border-border/70 bg-background/80 text-[13px] text-foreground shadow-none transition-colors [&_[data-slot=input]]:h-9 [&_[data-slot=input]]:bg-transparent [&_[data-slot=input]]:px-3 [&_[data-slot=input]]:py-0 [&_[data-slot=input]]:text-[13px] [&_[data-slot=input]]:text-foreground [&_[data-slot=input]]:placeholder:text-muted-foreground [&_[data-slot=input]]:outline-none",
          className,
        )}
        fullWidth
        type={type}
        variant="secondary"
        {...props}
      />
    );
  },
);

Input.displayName = "Input";

export { Input };
