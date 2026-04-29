import * as React from "react";

import { cn } from "@/lib/utils";

type ScrollShadowProps = React.HTMLAttributes<HTMLDivElement> & {
  hideScrollBar?: boolean;
  orientation?: "horizontal" | "vertical";
  size?: number;
};

const ScrollShadow = React.forwardRef<HTMLDivElement, ScrollShadowProps>(function ScrollShadow(
  { className, hideScrollBar = false, orientation = "vertical", size = 24, style, ...props },
  ref,
) {
  return (
    <div
      ref={ref}
      data-orientation={orientation}
      data-slot="scroll-shadow"
      className={cn(
        "relative overflow-auto",
        hideScrollBar && "[scrollbar-width:none] [&::-webkit-scrollbar]:hidden",
        className,
      )}
      style={
        {
          "--scroll-shadow-size": `${size}px`,
          ...style,
        } as React.CSSProperties
      }
      {...props}
    />
  );
});

ScrollShadow.displayName = "ScrollShadow";

export { ScrollShadow };
