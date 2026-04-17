import type { ComponentProps } from "react";

import { Switch as HeroSwitch } from "@heroui/react";

import { cn } from "@/lib/utils";

type SwitchProps = Omit<ComponentProps<typeof HeroSwitch>, "children" | "isSelected" | "onChange" | "isDisabled"> & {
  checked?: boolean;
  disabled?: boolean;
  onCheckedChange?: (checked: boolean) => void;
};

function Switch({ className, checked, disabled, onCheckedChange, ...props }: SwitchProps) {
  return (
    <HeroSwitch
      data-slot="switch"
      className={cn("inline-flex items-center justify-center", "disabled:cursor-not-allowed disabled:opacity-50", className)}
      isDisabled={disabled}
      isSelected={checked}
      onChange={onCheckedChange}
      {...props}
    >
      {({ isSelected }) => (
        <HeroSwitch.Control
          data-slot="switch-control"
          className={cn(
            "flex h-6 w-10 items-center rounded-full border border-transparent p-0.5 transition-colors duration-150",
            "shadow-[var(--shadow-surface)] outline-none focus-visible:ring-2 focus-visible:ring-primary",
            isSelected ? "bg-primary text-primary-foreground" : "bg-foreground/[0.12] text-transparent",
          )}
        >
          <HeroSwitch.Thumb
            data-slot="switch-thumb"
            className={cn(
              "size-5 rounded-full bg-background shadow-sm transition-transform duration-150",
              isSelected ? "translate-x-4" : "translate-x-0",
            )}
          />
        </HeroSwitch.Control>
      )}
    </HeroSwitch>
  );
}

export { Switch };
