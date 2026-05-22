import type { KeyboardEvent, PointerEvent as ReactPointerEvent } from "react";
import { useCallback, useEffect, useRef, useState } from "react";

import { useAppStore } from "../../app/store";
import { isCanvasSupportedFile } from "../../lib/filePreviewKind";
import { cn } from "../../lib/utils";

export function ContextSidebarResizer() {
  const contextSidebarWidth = useAppStore((s) => s.contextSidebarWidth);
  const canvasSidebarWidth = useAppStore((s) => s.canvasSidebarWidth);
  const filePreview = useAppStore((s) => s.filePreview);
  const canvasEnabled = useAppStore((s) => s.desktopFeatureFlags?.canvas === true);
  const setContextSidebarWidth = useAppStore((s) => s.setContextSidebarWidth);
  const [dragging, setDragging] = useState(false);

  const startXRef = useRef(0);
  const startWidthRef = useRef(0);

  const isCanvasSupported = filePreview?.path && isCanvasSupportedFile(filePreview.path);
  const showCanvas = canvasEnabled && isCanvasSupported;
  const activeWidth = showCanvas ? canvasSidebarWidth : contextSidebarWidth;

  const handlePointerDown = useCallback(
    (event: ReactPointerEvent) => {
      if (event.button !== undefined && event.button !== 0) return;
      event.preventDefault();
      startXRef.current = event.clientX;
      startWidthRef.current = activeWidth;
      setDragging(true);
    },
    [activeWidth],
  );

  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLDivElement>) => {
      const step = event.shiftKey ? 32 : 16;
      if (event.key === "ArrowLeft") {
        event.preventDefault();
        setContextSidebarWidth(activeWidth + step); // Moving left makes right sidebar wider
      } else if (event.key === "ArrowRight") {
        event.preventDefault();
        setContextSidebarWidth(activeWidth - step); // Moving right makes right sidebar narrower
      } else if (event.key === "Home") {
        event.preventDefault();
        setContextSidebarWidth(200);
      } else if (event.key === "End") {
        event.preventDefault();
        setContextSidebarWidth(showCanvas ? 900 : 600);
      }
    },
    [setContextSidebarWidth, activeWidth, showCanvas],
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

    const handlePointerMove = (event: PointerEvent) => {
      // The cursor moving left (negative delta) should increase width
      const delta = startXRef.current - event.clientX;
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
        setContextSidebarWidth(pendingWidth);
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
  }, [dragging, setContextSidebarWidth]);

  return (
    <hr
      className={cn(
        "app-native-no-drag absolute -left-1 top-0 z-20 m-0 h-full w-3 cursor-col-resize touch-none border-0 bg-transparent p-0 outline-none transition-colors focus-visible:bg-primary/15",
        dragging && "bg-primary/20",
      )}
      aria-orientation="vertical"
      aria-label="Resize context sidebar"
      aria-valuemin={200}
      aria-valuemax={showCanvas ? 900 : 600}
      aria-valuenow={activeWidth}
      tabIndex={0}
      onPointerDown={handlePointerDown}
      onKeyDown={handleKeyDown}
    />
  );
}
