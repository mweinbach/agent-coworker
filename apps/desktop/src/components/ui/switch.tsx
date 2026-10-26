import { Switch as GlisseSwitch } from "glisse";
import * as React from "react";

import { cn } from "@/lib/utils";

type SwitchProps = Omit<React.ComponentProps<typeof GlisseSwitch>, "children"> & {
  size?: "sm" | "default";
};

/**
 * Liquid Glass switch (glisse) with the shadcn Switch contract: `checked`,
 * `defaultChecked`, `onCheckedChange`, `size`, and the `data-slot`/`data-state`
 * hooks that the high-contrast and forced-colors rules in `styles.css` target.
 */
function Switch({
  className,
  size = "default",
  checked: checkedProp,
  defaultChecked = false,
  onCheckedChange,
  ...props
}: SwitchProps) {
  const [uncontrolled, setUncontrolled] = React.useState(defaultChecked);
  const controlled = checkedProp !== undefined;
  const checked = controlled ? checkedProp : uncontrolled;

  const handleCheckedChange = React.useCallback(
    (next: boolean) => {
      if (!controlled) setUncontrolled(next);
      onCheckedChange?.(next);
    },
    [controlled, onCheckedChange],
  );

  return (
    <GlisseSwitch
      data-slot="switch"
      data-size={size}
      data-state={checked ? "checked" : "unchecked"}
      className={cn("app-glass-switch", className)}
      checked={checked}
      onCheckedChange={handleCheckedChange}
      {...props}
    />
  );
}

export { Switch };
