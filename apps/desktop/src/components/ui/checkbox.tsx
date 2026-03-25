import type { ComponentProps } from "react";

import { Checkbox as HeroCheckbox } from "@heroui/react";
import { CheckIcon } from "lucide-react";

import { cn } from "@/lib/utils";

type CheckboxProps = Omit<ComponentProps<typeof HeroCheckbox>, "children" | "isSelected" | "onChange" | "isDisabled"> & {
  checked?: boolean;
  disabled?: boolean;
  onCheckedChange?: (checked: boolean) => void;
};

function Checkbox({ className, checked, disabled, onCheckedChange, ...props }: CheckboxProps) {
  return (
    <HeroCheckbox
      data-slot="checkbox"
      className={cn(
        "inline-flex items-center justify-center",
        "[&_[data-slot=checkbox-control]]:size-4 [&_[data-slot=checkbox-control]]:shrink-0 [&_[data-slot=checkbox-control]]:rounded-[4px]",
        "[&_[data-slot=checkbox-control]]:border [&_[data-slot=checkbox-control]]:border-border [&_[data-slot=checkbox-control]]:shadow-[var(--shadow-surface)]",
        "[&_[data-slot=checkbox-control]]:transition-colors [&_[data-slot=checkbox-control]]:duration-150",
        "[&_[data-slot=checkbox-control]]:data-[selected=true]:border-primary [&_[data-slot=checkbox-control]]:data-[selected=true]:bg-primary",
        "[&_[data-slot=checkbox-control]]:text-primary-foreground",
        "[&_[data-slot=checkbox-control]]:outline-none [&_[data-slot=checkbox-control]]:focus-visible:ring-2 [&_[data-slot=checkbox-control]]:focus-visible:ring-primary",
        "[&_[data-slot=checkbox-indicator]]:flex [&_[data-slot=checkbox-indicator]]:items-center [&_[data-slot=checkbox-indicator]]:justify-center",
        "disabled:cursor-not-allowed disabled:opacity-50",
        className,
      )}
      isDisabled={disabled}
      isSelected={checked}
      onChange={onCheckedChange}
      {...props}
    >
      <HeroCheckbox.Control data-slot="checkbox-control">
        <HeroCheckbox.Indicator data-slot="checkbox-indicator">
          <CheckIcon className="size-3.5" />
        </HeroCheckbox.Indicator>
      </HeroCheckbox.Control>
    </HeroCheckbox>
  );
}

export { Checkbox };
