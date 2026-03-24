import * as React from "react";
import { TextArea as HeroTextArea } from "@heroui/react";

import { cn } from "@/lib/utils";

function Textarea({ className, ...props }: React.ComponentProps<typeof HeroTextArea>) {
  return (
    <HeroTextArea
      data-slot="textarea"
      variant="secondary"
      className={cn(
        "min-h-20 w-full rounded-[10px] border border-border/70 bg-background/80 px-3 py-2 text-[13px] text-foreground shadow-none transition-colors placeholder:text-muted-foreground disabled:cursor-not-allowed disabled:opacity-50",
        className,
      )}
      {...props}
    />
  );
}

export { Textarea };
