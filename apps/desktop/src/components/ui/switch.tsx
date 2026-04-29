import type { ComponentProps } from "react";
import * as React from "react";

import { cn } from "@/lib/utils";

type SwitchProps = Omit<ComponentProps<"span">, "children" | "onChange"> & {
  checked?: boolean;
  defaultChecked?: boolean;
  disabled?: boolean;
  onCheckedChange?: (checked: boolean) => void;
};

function Switch({
  className,
  checked,
  defaultChecked = false,
  disabled,
  onKeyDown,
  onCheckedChange,
  onClick,
  tabIndex,
  ...props
}: SwitchProps) {
  const [uncontrolledChecked, setUncontrolledChecked] = React.useState(defaultChecked);
  const nodeRef = React.useRef<HTMLSpanElement | null>(null);
  const isChecked = checked ?? uncontrolledChecked;

  const setChecked = React.useCallback(
    (nextChecked: boolean) => {
      if (checked === undefined) {
        setUncontrolledChecked(nextChecked);
      }
      onCheckedChange?.(nextChecked);
    },
    [checked, onCheckedChange],
  );

  React.useLayoutEffect(() => {
    nodeRef.current?.toggleAttribute("disabled", disabled ?? false);
  }, [disabled]);

  return (
    <span
      ref={nodeRef}
      role="switch"
      aria-checked={isChecked}
      aria-disabled={disabled || undefined}
      data-slot="switch"
      data-state={isChecked ? "checked" : "unchecked"}
      tabIndex={disabled ? undefined : (tabIndex ?? 0)}
      className={cn(
        "inline-flex h-6 w-10 shrink-0 cursor-pointer items-center overflow-hidden rounded-full border border-transparent bg-foreground/[0.12] shadow-[var(--shadow-surface)] transition-colors duration-150 outline-none data-[state=checked]:bg-primary focus-visible:ring-2 focus-visible:ring-primary aria-disabled:cursor-not-allowed aria-disabled:opacity-50",
        className,
      )}
      onClick={(event) => {
        onClick?.(event);
        if (!event.defaultPrevented && !disabled) {
          setChecked(!isChecked);
        }
      }}
      onKeyDown={(event) => {
        onKeyDown?.(event);
        if (event.defaultPrevented || disabled) {
          return;
        }
        if (event.key === " " || event.key === "Enter") {
          event.preventDefault();
          setChecked(!isChecked);
        }
      }}
      {...props}
    >
      <span
        data-slot="switch-thumb"
        data-state={isChecked ? "checked" : "unchecked"}
        className="ms-0.5 block size-5 rounded-full border border-border/60 !bg-[var(--panel-bg)] shadow-sm transition-transform duration-150 data-[state=checked]:translate-x-[1.125rem]"
      />
    </span>
  );
}

export { Switch };
