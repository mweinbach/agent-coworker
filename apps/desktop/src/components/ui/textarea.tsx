import * as React from "react";
import { TextArea as HeroTextArea } from "@heroui/react";

import { cn } from "@/lib/utils";

function Textarea({ className, ...props }: React.ComponentProps<typeof HeroTextArea>) {
  return (
    <HeroTextArea
      data-slot="textarea"
      variant="secondary"
      className={cn(
        "min-h-20 w-full rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground shadow-sm transition-colors placeholder:text-muted-foreground disabled:cursor-not-allowed disabled:opacity-50",
        className,
      )}
      {...props}
    />
  );
}

export { Textarea };
