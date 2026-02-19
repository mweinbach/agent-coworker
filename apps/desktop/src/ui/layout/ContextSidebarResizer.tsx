import { useCallback, useEffect, useRef, useState } from "react";
import type { KeyboardEvent, MouseEvent as ReactMouseEvent } from "react";

import { useAppStore } from "../../app/store";
import { cn } from "../../lib/utils";

export function ContextSidebarResizer() {
  const contextSidebarWidth = useAppStore((s) => s.contextSidebarWidth);
  const setContextSidebarWidth = useAppStore((s) => s.setContextSidebarWidth);
  const [dragging, setDragging] = useState(false);

  const startXRef = useRef(0);
  const startWidthRef = useRef(0);

  const handleMouseDown = useCallback(
    (event: ReactMouseEvent) => {
      event.preventDefault();
      startXRef.current = event.clientX;
      startWidthRef.current = contextSidebarWidth;
      setDragging(true);
    },
    [contextSidebarWidth],
  );

  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLDivElement>) => {
      const step = event.shiftKey ? 32 : 16;
      if (event.key === "ArrowLeft") {
        event.preventDefault();
        setContextSidebarWidth(contextSidebarWidth + step); // Moving left makes right sidebar wider
      } else if (event.key === "ArrowRight") {
        event.preventDefault();
        setContextSidebarWidth(contextSidebarWidth - step); // Moving right makes right sidebar narrower
      } else if (event.key === "Home") {
        event.preventDefault();
        setContextSidebarWidth(200);
      } else if (event.key === "End") {
        event.preventDefault();
        setContextSidebarWidth(600);
      }
    },
    [setContextSidebarWidth, contextSidebarWidth],
  );

  useEffect(() => {
    if (!dragging) return;

    document.body.classList.add("app-resizing-sidebars");

    let frameId: number | null = null;
    let pendingWidth: number | null = null;

    const flushPendingWidth = () => {
      frameId = null;
      if (pendingWidth === null) {
        return;
      }
      setContextSidebarWidth(pendingWidth);
      pendingWidth = null;
    };

    const handleMouseMove = (event: MouseEvent) => {
      // The cursor moving left (negative delta) should increase width
      const delta = startXRef.current - event.clientX;
      pendingWidth = startWidthRef.current + delta;
      if (frameId === null) {
        frameId = window.requestAnimationFrame(flushPendingWidth);
      }
    };

    const handleMouseUp = () => {
      if (frameId !== null) {
        window.cancelAnimationFrame(frameId);
        frameId = null;
      }
      if (pendingWidth !== null) {
        setContextSidebarWidth(pendingWidth);
        pendingWidth = null;
      }
      document.body.classList.remove("app-resizing-sidebars");
      setDragging(false);
    };

    window.addEventListener("mousemove", handleMouseMove);
    window.addEventListener("mouseup", handleMouseUp);

    return () => {
      if (frameId !== null) {
        window.cancelAnimationFrame(frameId);
      }
      document.body.classList.remove("app-resizing-sidebars");
      window.removeEventListener("mousemove", handleMouseMove);
      window.removeEventListener("mouseup", handleMouseUp);
    };
  }, [dragging, setContextSidebarWidth]);

  return (
    <div
      className={cn("absolute left-0 top-0 z-20 h-full w-2 cursor-col-resize", dragging && "bg-primary/20")}
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize context sidebar"
      aria-valuemin={200}
      aria-valuemax={600}
      aria-valuenow={contextSidebarWidth}
      tabIndex={0}
      onMouseDown={handleMouseDown}
      onKeyDown={handleKeyDown}
    />
  );
}
