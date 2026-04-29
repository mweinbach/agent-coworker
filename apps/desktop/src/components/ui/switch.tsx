import * as SwitchPrimitive from "@radix-ui/react-switch";
import type { ComponentProps } from "react";

import { cn } from "@/lib/utils";

type SwitchProps = Omit<
  ComponentProps<typeof SwitchPrimitive.Root>,
  "children" | "checked" | "onCheckedChange" | "disabled"
> & {
  checked?: boolean;
  disabled?: boolean;
  onCheckedChange?: (checked: boolean) => void;
};

function Switch({ className, checked, disabled, onCheckedChange, ...props }: SwitchProps) {
  return (
    <SwitchPrimitive.Root
      data-slot="switch"
      className={cn(
        "inline-flex h-6 w-10 shrink-0 cursor-pointer items-center overflow-hidden rounded-full border border-transparent bg-foreground/[0.12] shadow-[var(--shadow-surface)] transition-colors duration-150 outline-none data-[state=checked]:bg-primary focus-visible:ring-2 focus-visible:ring-primary disabled:cursor-not-allowed disabled:opacity-50",
        "disabled:cursor-not-allowed disabled:opacity-50",
        className,
      )}
      checked={checked}
      disabled={disabled}
      onCheckedChange={onCheckedChange}
      {...props}
    >
      <SwitchPrimitive.Thumb
        data-slot="switch-thumb"
        className="ms-0.5 size-5 rounded-full border border-border/60 !bg-[var(--panel-bg)] shadow-sm transition-transform duration-150 data-[state=checked]:translate-x-[1.125rem]"
      />
    </SwitchPrimitive.Root>
  );
}

export { Switch };
