import type { KeyboardEvent, PointerEvent as ReactPointerEvent } from "react";
import { useCallback, useEffect, useRef, useState } from "react";

import { useAppStore } from "../../app/store";
import { cn } from "../../lib/utils";

type SidebarResizerProps = {
  effectiveWidth?: number;
  maximumWidth?: number;
};

export function SidebarResizer({ effectiveWidth, maximumWidth = 440 }: SidebarResizerProps = {}) {
  const savedSidebarWidth = useAppStore((s) => s.sidebarWidth);
  const setSidebarWidth = useAppStore((s) => s.setSidebarWidth);
  const [dragging, setDragging] = useState(false);
  const resolvedMaximumWidth = Math.max(160, maximumWidth);
  const sidebarWidth = Math.max(
    160,
    Math.min(resolvedMaximumWidth, effectiveWidth ?? savedSidebarWidth),
  );

  const startXRef = useRef(0);
  const startWidthRef = useRef(0);

  const commitWidth = useCallback(
    (width: number) => setSidebarWidth(Math.max(160, Math.min(resolvedMaximumWidth, width))),
    [resolvedMaximumWidth, setSidebarWidth],
  );

  const handlePointerDown = useCallback(
    (event: ReactPointerEvent) => {
      if (event.button !== undefined && event.button !== 0) return;
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
        commitWidth(sidebarWidth - step);
      } else if (event.key === "ArrowRight") {
        event.preventDefault();
        commitWidth(sidebarWidth + step);
      } else if (event.key === "Home") {
        event.preventDefault();
        commitWidth(160);
      } else if (event.key === "End") {
        event.preventDefault();
        commitWidth(resolvedMaximumWidth);
      }
    },
    [commitWidth, resolvedMaximumWidth, sidebarWidth],
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
      commitWidth(pendingWidth);
      pendingWidth = null;
    };

    const handlePointerMove = (event: PointerEvent) => {
      const delta = event.clientX - startXRef.current;
      pendingWidth = startWidthRef.current + delta;
      if (frameId === null) {
        frameId = window.requestAnimationFrame(flushPendingWidth);
      }
    };

    const handlePointerUp = () => {
      if (frameId !== null) {
        window.cancelAnimationFrame(frameId);
        frameId = null;
      }
      if (pendingWidth !== null) {
        commitWidth(pendingWidth);
        pendingWidth = null;
      }
      document.body.classList.remove("app-resizing-sidebars");
      setDragging(false);
    };

    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", handlePointerUp);
    window.addEventListener("pointercancel", handlePointerUp);

    return () => {
      if (frameId !== null) {
        window.cancelAnimationFrame(frameId);
      }
      document.body.classList.remove("app-resizing-sidebars");
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerUp);
      window.removeEventListener("pointercancel", handlePointerUp);
    };
  }, [commitWidth, dragging]);

  return (
    <hr
      className={cn(
        "app-native-no-drag absolute right-0 top-0 z-20 m-0 h-full w-2 cursor-col-resize touch-none border-0 bg-transparent p-0 outline-none transition-colors focus-visible:bg-primary/15",
        dragging && "bg-primary/20",
      )}
      aria-orientation="vertical"
      aria-label="Resize sidebar"
      aria-valuemin={160}
      aria-valuemax={resolvedMaximumWidth}
      aria-valuenow={sidebarWidth}
      tabIndex={0}
      onPointerDown={handlePointerDown}
      onKeyDown={handleKeyDown}
    />
  );
}
