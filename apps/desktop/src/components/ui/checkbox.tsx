import { CheckIcon } from "lucide-react";
import { type ComponentProps, useState } from "react";

import { cn } from "@/lib/utils";

type CheckboxProps = Omit<ComponentProps<"input">, "children" | "onChange" | "type"> & {
  onCheckedChange?: (checked: boolean) => void;
};

function Checkbox({
  className,
  checked,
  defaultChecked = false,
  disabled,
  onCheckedChange,
  ...props
}: CheckboxProps) {
  const [uncontrolledChecked, setUncontrolledChecked] = useState(Boolean(defaultChecked));
  const isChecked = checked ?? uncontrolledChecked;

  return (
    <span
      data-slot="checkbox"
      className={cn(
        "relative inline-flex size-[18px] shrink-0 items-center justify-center rounded-[5px] border border-border bg-foreground/[0.06] text-transparent shadow-[var(--shadow-surface)] transition-colors duration-150",
        "has-[:checked]:border-primary has-[:checked]:bg-primary has-[:checked]:text-primary-foreground",
        "has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-primary",
        "has-[:disabled]:cursor-not-allowed has-[:disabled]:opacity-50",
        className,
      )}
    >
      <input
        {...props}
        type="checkbox"
        className="peer absolute inset-0 m-0 cursor-pointer opacity-0 disabled:cursor-not-allowed"
        checked={isChecked}
        disabled={disabled}
        onChange={(event) => {
          const nextChecked = event.currentTarget.checked;
          if (checked === undefined) {
            setUncontrolledChecked(nextChecked);
          }
          onCheckedChange?.(nextChecked);
        }}
      />
      {isChecked ? (
        <span data-slot="checkbox-indicator" className="flex items-center justify-center">
          <CheckIcon className="size-3.5" />
        </span>
      ) : null}
    </span>
  );
}

export { Checkbox };
