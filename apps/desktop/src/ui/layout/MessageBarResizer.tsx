import { useCallback, useEffect, useRef, useState } from "react";
import type { KeyboardEvent, MouseEvent as ReactMouseEvent } from "react";

import { useAppStore } from "../../app/store";
import { cn } from "../../lib/utils";

export function MessageBarResizer() {
  const messageBarHeight = useAppStore((s) => s.messageBarHeight);
  const setMessageBarHeight = useAppStore((s) => s.setMessageBarHeight);
  const [dragging, setDragging] = useState(false);

  const startYRef = useRef(0);
  const startHeightRef = useRef(0);

  const handleMouseDown = useCallback(
    (event: ReactMouseEvent) => {
      event.preventDefault();
      startYRef.current = event.clientY;
      startHeightRef.current = messageBarHeight;
      setDragging(true);
    },
    [messageBarHeight],
  );

  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLDivElement>) => {
      const step = event.shiftKey ? 32 : 16;
      if (event.key === "ArrowUp") {
        event.preventDefault();
        setMessageBarHeight(messageBarHeight + step); // Move up makes it taller
      } else if (event.key === "ArrowDown") {
        event.preventDefault();
        setMessageBarHeight(messageBarHeight - step); // Move down makes it shorter
      } else if (event.key === "Home") {
        event.preventDefault();
        setMessageBarHeight(500); // Max height
      } else if (event.key === "End") {
        event.preventDefault();
        setMessageBarHeight(80); // Min height
      }
    },
    [setMessageBarHeight, messageBarHeight],
  );

  useEffect(() => {
    if (!dragging) return;

    const handleMouseMove = (event: MouseEvent) => {
      // The cursor moving up (negative delta y) should increase height
      const delta = startYRef.current - event.clientY;
      setMessageBarHeight(startHeightRef.current + delta);
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
  }, [dragging, setMessageBarHeight]);

  return (
    <div
      className={cn("absolute top-0 left-0 right-0 -mt-[1px] h-[3px] cursor-row-resize bg-transparent hover:bg-border/80 transition-colors z-20", dragging && "bg-primary/20 hover:bg-primary/20")}
      role="separator"
      aria-orientation="horizontal"
      aria-label="Resize message bar"
      aria-valuemin={80}
      aria-valuemax={500}
      aria-valuenow={messageBarHeight}
      tabIndex={0}
      onMouseDown={handleMouseDown}
      onKeyDown={handleKeyDown}
    />
  );
}
