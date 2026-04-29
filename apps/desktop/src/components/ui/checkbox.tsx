import * as CheckboxPrimitive from "@radix-ui/react-checkbox";
import { CheckIcon } from "lucide-react";
import type { ComponentProps } from "react";

import { cn } from "@/lib/utils";

type CheckboxProps = Omit<
  ComponentProps<typeof CheckboxPrimitive.Root>,
  "children" | "onCheckedChange"
> & {
  onCheckedChange?: (checked: boolean) => void;
};

function Checkbox({ className, checked, disabled, onCheckedChange, ...props }: CheckboxProps) {
  return (
    <CheckboxPrimitive.Root
      data-slot="checkbox"
      className={cn(
        "inline-flex size-[18px] shrink-0 items-center justify-center rounded-[5px] border border-border bg-foreground/[0.06] text-transparent shadow-[var(--shadow-surface)] outline-none transition-colors duration-150",
        "focus-visible:ring-2 focus-visible:ring-primary",
        "data-[state=checked]:border-primary data-[state=checked]:bg-primary data-[state=checked]:text-primary-foreground",
        "disabled:cursor-not-allowed disabled:opacity-50",
        className,
      )}
      checked={checked}
      disabled={disabled}
      onCheckedChange={(nextChecked) => onCheckedChange?.(nextChecked === true)}
      {...props}
    >
      <CheckboxPrimitive.Indicator
        data-slot="checkbox-indicator"
        className="flex items-center justify-center"
      >
        <CheckIcon className="size-3.5" />
      </CheckboxPrimitive.Indicator>
    </CheckboxPrimitive.Root>
  );
}

export { Checkbox };
