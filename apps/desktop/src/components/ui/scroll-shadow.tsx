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
  const scrollRef = React.useRef<HTMLDivElement | null>(null);
  const [shadowState, setShadowState] = React.useState({
    showEnd: false,
    showStart: false,
  });

  const setRefs = React.useCallback(
    (node: HTMLDivElement | null) => {
      scrollRef.current = node;
      if (typeof ref === "function") {
        ref(node);
      } else if (ref) {
        ref.current = node;
      }
    },
    [ref],
  );

  const updateShadowState = React.useCallback(() => {
    const node = scrollRef.current;
    if (!node) {
      return;
    }

    const maxScroll =
      orientation === "vertical"
        ? node.scrollHeight - node.clientHeight
        : node.scrollWidth - node.clientWidth;
    const scrollPosition = orientation === "vertical" ? node.scrollTop : node.scrollLeft;
    const nextState = {
      showEnd: maxScroll > 1 && scrollPosition < maxScroll - 1,
      showStart: maxScroll > 1 && scrollPosition > 1,
    };

    setShadowState((currentState) =>
      currentState.showStart === nextState.showStart && currentState.showEnd === nextState.showEnd
        ? currentState
        : nextState,
    );
  }, [orientation]);

  React.useEffect(() => {
    const node = scrollRef.current;
    if (!node) {
      return;
    }

    updateShadowState();
    node.addEventListener("scroll", updateShadowState, { passive: true });

    const resizeObserver =
      typeof ResizeObserver === "undefined" ? null : new ResizeObserver(updateShadowState);
    resizeObserver?.observe(node);

    const mutationObserver =
      typeof MutationObserver === "undefined" ? null : new MutationObserver(updateShadowState);
    mutationObserver?.observe(node, {
      attributes: true,
      characterData: true,
      childList: true,
      subtree: true,
    });

    return () => {
      node.removeEventListener("scroll", updateShadowState);
      resizeObserver?.disconnect();
      mutationObserver?.disconnect();
    };
  }, [updateShadowState]);

  const shadowColor = "var(--border-strong)";
  const scrollShadow = [
    shadowState.showStart
      ? orientation === "vertical"
        ? `inset 0 ${size}px ${size}px -${size}px ${shadowColor}`
        : `inset ${size}px 0 ${size}px -${size}px ${shadowColor}`
      : null,
    shadowState.showEnd
      ? orientation === "vertical"
        ? `inset 0 -${size}px ${size}px -${size}px ${shadowColor}`
        : `inset -${size}px 0 ${size}px -${size}px ${shadowColor}`
      : null,
  ]
    .filter(Boolean)
    .join(", ");

  const resolvedStyle = {
    ...style,
    "--scroll-shadow-size": `${size}px`,
    boxShadow: [style?.boxShadow, scrollShadow].filter(Boolean).join(", ") || undefined,
  } as React.CSSProperties;

  return (
    <div
      ref={setRefs}
      data-orientation={orientation}
      data-slot="scroll-shadow"
      className={cn(
        "relative overflow-auto",
        hideScrollBar && "[scrollbar-width:none] [&::-webkit-scrollbar]:hidden",
        className,
      )}
      style={resolvedStyle}
      {...props}
    />
  );
});

ScrollShadow.displayName = "ScrollShadow";

export { ScrollShadow };
