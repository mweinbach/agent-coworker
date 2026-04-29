import * as React from "react";

import { cn } from "@/lib/utils";

const Input = React.forwardRef<HTMLInputElement, React.ComponentProps<"input">>(function Input(
  { className, type, ...props },
  ref,
) {
  return (
    <input
      ref={ref}
      data-slot="input"
      className={cn(
        "app-focus-ring app-surface-field app-border-subtle app-shadow-field h-9 w-full rounded-[10px] border bg-transparent px-3 py-0 text-[13px] text-foreground transition-colors placeholder:text-muted-foreground disabled:cursor-not-allowed disabled:opacity-50",
        className,
      )}
      type={type}
      {...props}
    />
  );
});

Input.displayName = "Input";

export { Input };
