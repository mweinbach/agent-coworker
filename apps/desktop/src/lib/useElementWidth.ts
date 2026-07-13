import { type RefObject, useEffect, useState } from "react";

export function useElementWidth<T extends HTMLElement>(ref: RefObject<T | null>): number {
  const [width, setWidth] = useState(0);

  useEffect(() => {
    const node = ref.current;
    if (!node) return;

    const updateWidth = () => setWidth(node.getBoundingClientRect().width);
    updateWidth();

    if (typeof ResizeObserver !== "function") return;
    const observer = new ResizeObserver((entries) => {
      const nextWidth = entries[0]?.contentRect.width;
      if (typeof nextWidth === "number") {
        setWidth(nextWidth);
      }
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, [ref]);

  return width;
}
