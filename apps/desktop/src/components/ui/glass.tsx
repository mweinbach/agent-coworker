import { Button as GlisseButton, Glass as GlisseGlass } from "glisse";
import type * as React from "react";

import { cn } from "@/lib/utils";

/*
 * Liquid Glass primitives backed by glisse. Desktop code imports these wrappers,
 * never glisse directly, so sizing, tokens, and accessibility overrides stay in
 * one place (`src/styles/glass.css`).
 *
 * glisse refracts the live backdrop with an SVG lens sized to the element and
 * regenerates it on resize, so reserve these for small, fixed-size chrome that
 * floats over scrolling content. Text surfaces such as the composer stay opaque
 * (the quality gate proves their contrast) and use the `app-glass-edge` rim.
 *
 * glisse animates presses through the inline `scale` and `translate` properties.
 * Position glass buttons with a wrapper element, not translate utilities.
 */

type GlassProps = React.ComponentProps<typeof GlisseGlass>;

function Glass({ className, ...props }: GlassProps) {
  return <GlisseGlass data-slot="glass" className={className} {...props} />;
}

function GlassGroup({ className, ...props }: GlassProps) {
  return (
    <GlisseGlass
      data-slot="glass-group"
      role="group"
      className={cn("app-glass-group", className)}
      {...props}
    />
  );
}

type GlassButtonProps = React.ComponentProps<typeof GlisseButton> & {
  size?: "sm" | "default" | "lg";
};

function GlassButton({ className, size = "default", ...props }: GlassButtonProps) {
  return (
    <GlisseButton
      data-slot="glass-button"
      data-size={size}
      className={cn("app-glass-button", className)}
      {...props}
    />
  );
}

export type { GlassButtonProps, GlassProps };
export { Glass, GlassButton, GlassGroup };
