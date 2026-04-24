import { Switch as HeroSwitch } from "@heroui/react";
import type { ComponentProps } from "react";

import { cn } from "@/lib/utils";

type SwitchProps = Omit<
  ComponentProps<typeof HeroSwitch>,
  "children" | "isSelected" | "onChange" | "isDisabled"
> & {
  checked?: boolean;
  disabled?: boolean;
  onCheckedChange?: (checked: boolean) => void;
};

function Switch({ className, checked, disabled, onCheckedChange, ...props }: SwitchProps) {
  return (
    <HeroSwitch
      data-slot="switch"
      className={cn(
        "inline-flex items-center justify-center",
        "[&_[data-slot=switch-control]]:flex [&_[data-slot=switch-control]]:h-6 [&_[data-slot=switch-control]]:w-10 [&_[data-slot=switch-control]]:shrink-0 [&_[data-slot=switch-control]]:items-center [&_[data-slot=switch-control]]:overflow-hidden [&_[data-slot=switch-control]]:rounded-full",
        "[&_[data-slot=switch-control]]:border [&_[data-slot=switch-control]]:border-transparent [&_[data-slot=switch-control]]:bg-foreground/[0.12]",
        "[&_[data-slot=switch-control]]:shadow-[var(--shadow-surface)] [&_[data-slot=switch-control]]:transition-colors [&_[data-slot=switch-control]]:duration-150",
        "[&[data-focus-visible=true]_[data-slot=switch-control]]:ring-2 [&[data-focus-visible=true]_[data-slot=switch-control]]:ring-primary",
        "[&[data-selected=true]_[data-slot=switch-control]]:bg-primary",
        "[&_[data-slot=switch-thumb]]:ms-0.5 [&_[data-slot=switch-thumb]]:size-5 [&_[data-slot=switch-thumb]]:rounded-full",
        "[&_[data-slot=switch-thumb]]:!bg-[var(--panel-bg)] [&_[data-slot=switch-thumb]]:border [&_[data-slot=switch-thumb]]:border-border/60 [&_[data-slot=switch-thumb]]:shadow-sm",
        "[&_[data-slot=switch-thumb]]:transition-[margin,background-color] [&_[data-slot=switch-thumb]]:duration-150",
        "[&[data-selected=true]_[data-slot=switch-thumb]]:ms-[1.125rem]",
        "disabled:cursor-not-allowed disabled:opacity-50",
        className,
      )}
      isDisabled={disabled}
      isSelected={checked}
      onChange={onCheckedChange}
      {...props}
    >
      <HeroSwitch.Control data-slot="switch-control">
        <HeroSwitch.Thumb data-slot="switch-thumb" />
      </HeroSwitch.Control>
    </HeroSwitch>
  );
}

export { Switch };
