import * as React from "react";
import { TextArea as HeroTextArea } from "@heroui/react";

import { cn } from "@/lib/utils";

function Textarea({ className, ...props }: React.ComponentProps<typeof HeroTextArea>) {
  return (
    <HeroTextArea
      data-slot="textarea"
      variant="secondary"
      className={cn(
        "app-focus-ring app-surface-field app-border-subtle app-shadow-field min-h-20 w-full rounded-[10px] border px-3 py-2 text-[13px] transition-colors placeholder:text-muted-foreground disabled:cursor-not-allowed disabled:opacity-50",
        className,
      )}
      {...props}
    />
  );
}

export { Textarea };
