import { useCallback, useEffect, useRef, useState } from "react";
import type { KeyboardEvent, MouseEvent as ReactMouseEvent } from "react";

import { useAppStore } from "../../app/store";
import { cn } from "../../lib/utils";

export function SidebarResizer() {
  const sidebarWidth = useAppStore((s) => s.sidebarWidth);
  const setSidebarWidth = useAppStore((s) => s.setSidebarWidth);
  const [dragging, setDragging] = useState(false);

  const startXRef = useRef(0);
  const startWidthRef = useRef(0);

  const handleMouseDown = useCallback(
    (event: ReactMouseEvent) => {
      event.preventDefault();
      startXRef.current = event.clientX;
      startWidthRef.current = sidebarWidth;
      setDragging(true);
    },
    [sidebarWidth],
  );

  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLDivElement>) => {
      const step = event.shiftKey ? 32 : 16;
      if (event.key === "ArrowLeft") {
        event.preventDefault();
        setSidebarWidth(sidebarWidth - step);
      } else if (event.key === "ArrowRight") {
        event.preventDefault();
        setSidebarWidth(sidebarWidth + step);
      } else if (event.key === "Home") {
        event.preventDefault();
        setSidebarWidth(180);
      } else if (event.key === "End") {
        event.preventDefault();
        setSidebarWidth(500);
      }
    },
    [setSidebarWidth, sidebarWidth],
  );

  useEffect(() => {
    if (!dragging) return;

    const handleMouseMove = (event: MouseEvent) => {
      const delta = event.clientX - startXRef.current;
      setSidebarWidth(startWidthRef.current + delta);
    };

    const handleMouseUp = () => {
      setDragging(false);
    };

    window.addEventListener("mousemove", handleMouseMove);
    window.addEventListener("mouseup", handleMouseUp);

    return () => {
      window.removeEventListener("mousemove", handleMouseMove);
      window.removeEventListener("mouseup", handleMouseUp);
    };
  }, [dragging, setSidebarWidth]);

  return (
    <div
      className={cn("absolute right-0 top-0 z-20 h-full w-2 cursor-col-resize", dragging && "bg-primary/20")}
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize sidebar"
      aria-valuemin={180}
      aria-valuemax={500}
      aria-valuenow={sidebarWidth}
      tabIndex={0}
      onMouseDown={handleMouseDown}
      onKeyDown={handleKeyDown}
    />
  );
}
