import { XIcon } from "lucide-react";
import type { CSSProperties, ReactNode } from "react";
import { useEffect, useLayoutEffect, useRef } from "react";

import { Button } from "../../components/ui/button";
import { cn } from "../../lib/utils";
import { isTargetInHigherOverlayLayer, useOverlayOwner } from "../OverlayStack";

type AdaptiveRailSurfaceProps = {
  active: boolean;
  children: ReactNode;
  className?: string;
  label: string;
  onClose: () => void;
  overlay: boolean;
  side: "left" | "right";
  width: number;
};

const FOCUSABLE_SELECTOR = [
  "button:not([disabled])",
  "[href]",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  '[tabindex]:not([tabindex="-1"])',
].join(",");

export function AdaptiveRailSurface({
  active,
  children,
  className,
  label,
  onClose,
  overlay,
  side,
  width,
}: AdaptiveRailSurfaceProps) {
  const closeButtonRef = useRef<HTMLButtonElement | null>(null);
  const paneRef = useRef<HTMLDivElement | null>(null);
  const restoreFocusRef = useRef<HTMLElement | null>(null);
  const wasOverlayActiveRef = useRef(false);
  useLayoutEffect(() => {
    const overlayActive = overlay && active;
    if (overlayActive && !wasOverlayActiveRef.current) {
      restoreFocusRef.current =
        document.activeElement instanceof HTMLElement ? document.activeElement : null;
    } else if (wasOverlayActiveRef.current && overlay && !active) {
      const target = restoreFocusRef.current;
      restoreFocusRef.current = null;
      const frame = window.requestAnimationFrame(() => {
        if (target?.isConnected) target.focus();
      });
      wasOverlayActiveRef.current = overlayActive;
      return () => window.cancelAnimationFrame(frame);
    }
    wasOverlayActiveRef.current = overlayActive;
  }, [active, overlay]);
  const ownership = useOverlayOwner({
    active: overlay && active,
    label,
    onDismiss: onClose,
    restoreFocus: () => restoreFocusRef.current,
  });
  const overlayZIndex = ownership?.zIndex ?? 1_000;
  const dismissOverlay = () => {
    const dismissed = ownership?.handleEscape({
      defaultPrevented: false,
      preventDefault: () => {},
      stopPropagation: () => {},
    });
    if (!dismissed) {
      onClose();
    }
  };
  const paneStyle: CSSProperties = {
    width: active ? width : 0,
    ...(overlay
      ? {
          maxWidth: "calc(100vw - 1rem)",
          zIndex: overlayZIndex + 1,
        }
      : {}),
  };

  useEffect(() => {
    if (!overlay || !active) return;
    const pane = paneRef.current;
    if (!pane) return;
    const frame = window.requestAnimationFrame(() => closeButtonRef.current?.focus());
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Tab") return;
      const focusable = Array.from(pane.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
        (element) =>
          !element.hasAttribute("inert") && element.getAttribute("aria-hidden") !== "true",
      );
      const first = focusable[0];
      const last = focusable.at(-1);
      if (!first || !last) {
        event.preventDefault();
        pane.focus();
        return;
      }
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    const handleFocusIn = (event: FocusEvent) => {
      if (
        event.target instanceof Node &&
        !pane.contains(event.target) &&
        !isTargetInHigherOverlayLayer(event.target, ownership?.sequence ?? 0)
      ) {
        closeButtonRef.current?.focus();
      }
    };
    pane.addEventListener("keydown", handleKeyDown);
    document.addEventListener("focusin", handleFocusIn, true);
    return () => {
      window.cancelAnimationFrame(frame);
      pane.removeEventListener("keydown", handleKeyDown);
      document.removeEventListener("focusin", handleFocusIn, true);
    };
  }, [active, overlay, ownership?.sequence]);

  return (
    <>
      {overlay && active ? (
        <div
          aria-hidden="true"
          className="fixed inset-0 bg-black/45 backdrop-blur-[1px]"
          data-slot="adaptive-rail-backdrop"
          onPointerDown={dismissOverlay}
          style={{ zIndex: overlayZIndex }}
        />
      ) : null}
      {/* biome-ignore lint/a11y/useAriaPropsSupportedByRole: both dynamic roles support an accessible name */}
      <div
        ref={paneRef}
        aria-hidden={!active ? "true" : undefined}
        aria-label={label}
        aria-modal={overlay && active ? "true" : undefined}
        className={cn(
          "app-adaptive-rail-surface min-h-0 shrink-0 overflow-hidden",
          !overlay && "relative h-full",
          overlay && [
            "app-native-no-drag fixed inset-y-0 h-dvh max-h-none border-border bg-background shadow-2xl",
            side === "left" ? "left-0 border-r" : "right-0 border-l",
            active ? "visible pointer-events-auto" : "invisible pointer-events-none",
          ],
          className,
        )}
        data-active={active ? "true" : "false"}
        data-presentation={overlay ? "overlay" : "inline"}
        data-side={side}
        inert={!active ? true : undefined}
        role={overlay ? "dialog" : "region"}
        style={paneStyle}
        tabIndex={overlay ? -1 : undefined}
      >
        <Button
          ref={closeButtonRef}
          aria-hidden={!overlay ? "true" : undefined}
          aria-label={`Close ${label}`}
          className={cn(
            "app-adaptive-rail-surface__close app-native-no-drag absolute top-2 right-2 z-30 rounded-full bg-background/90 shadow-sm backdrop-blur-sm",
            !overlay && "hidden",
          )}
          disabled={!overlay}
          onClick={dismissOverlay}
          size="icon-sm"
          tabIndex={overlay ? 0 : -1}
          type="button"
          variant="outline"
        >
          <XIcon aria-hidden="true" />
        </Button>
        {children}
      </div>
    </>
  );
}
