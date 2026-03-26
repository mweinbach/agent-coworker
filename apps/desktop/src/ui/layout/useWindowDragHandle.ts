import { useCallback, useEffect, useRef, type MouseEventHandler, type PointerEventHandler } from "react";

import { windowDragEnd, windowDragMove, windowDragStart } from "../../lib/desktopCommands";

const DRAG_THRESHOLD_PX = 4;

type WindowDragHandleProps<T extends HTMLElement> = {
  onClickCapture: MouseEventHandler<T>;
  onLostPointerCapture: PointerEventHandler<T>;
  onPointerCancel: PointerEventHandler<T>;
  onPointerDown: PointerEventHandler<T>;
  onPointerMove: PointerEventHandler<T>;
  onPointerUp: PointerEventHandler<T>;
};

type DragState = {
  activePointerId: number | null;
  dragging: boolean;
  frameId: number | null;
  lastScreenX: number;
  lastScreenY: number;
  startScreenX: number;
  startScreenY: number;
  suppressClick: boolean;
};

const EMPTY_PROPS: Partial<WindowDragHandleProps<HTMLElement>> = {};

function createInitialState(): DragState {
  return {
    activePointerId: null,
    dragging: false,
    frameId: null,
    lastScreenX: 0,
    lastScreenY: 0,
    startScreenX: 0,
    startScreenY: 0,
    suppressClick: false,
  };
}

export function useWindowDragHandle<T extends HTMLElement>(enabled: boolean): Partial<WindowDragHandleProps<T>> {
  const dragStateRef = useRef<DragState>(createInitialState());

  const flushMove = useCallback(() => {
    const state = dragStateRef.current;
    state.frameId = null;
    if (!state.dragging) {
      return;
    }
    void windowDragMove({
      screenX: state.lastScreenX,
      screenY: state.lastScreenY,
    });
  }, []);

  const queueMove = useCallback((screenX: number, screenY: number) => {
    const state = dragStateRef.current;
    state.lastScreenX = screenX;
    state.lastScreenY = screenY;
    if (state.frameId !== null) {
      return;
    }
    state.frameId = window.requestAnimationFrame(flushMove);
  }, [flushMove]);

  const resetDrag = useCallback(() => {
    const state = dragStateRef.current;
    if (state.frameId !== null) {
      window.cancelAnimationFrame(state.frameId);
    }
    state.activePointerId = null;
    state.dragging = false;
    state.frameId = null;
    state.lastScreenX = 0;
    state.lastScreenY = 0;
    state.startScreenX = 0;
    state.startScreenY = 0;
  }, []);

  const finishDrag = useCallback((screenX?: number, screenY?: number) => {
    const state = dragStateRef.current;
    if (state.frameId !== null) {
      window.cancelAnimationFrame(state.frameId);
      state.frameId = null;
    }
    if (!state.dragging) {
      resetDrag();
      return;
    }
    if (typeof screenX === "number" && typeof screenY === "number") {
      void windowDragMove({ screenX, screenY });
    }
    void windowDragEnd();
    state.suppressClick = true;
    resetDrag();
  }, [resetDrag]);

  const onPointerDown = useCallback<PointerEventHandler<T>>((event) => {
    if (!enabled || event.button !== 0) {
      return;
    }
    const state = dragStateRef.current;
    state.activePointerId = event.pointerId;
    state.dragging = false;
    state.suppressClick = false;
    state.startScreenX = event.screenX;
    state.startScreenY = event.screenY;
    state.lastScreenX = event.screenX;
    state.lastScreenY = event.screenY;
    event.currentTarget.setPointerCapture?.(event.pointerId);
  }, [enabled]);

  const onPointerMove = useCallback<PointerEventHandler<T>>((event) => {
    const state = dragStateRef.current;
    if (!enabled || state.activePointerId !== event.pointerId) {
      return;
    }
    const deltaX = event.screenX - state.startScreenX;
    const deltaY = event.screenY - state.startScreenY;
    if (!state.dragging) {
      if (Math.hypot(deltaX, deltaY) < DRAG_THRESHOLD_PX) {
        return;
      }
      state.dragging = true;
      void windowDragStart({
        screenX: state.startScreenX,
        screenY: state.startScreenY,
      });
    }
    queueMove(event.screenX, event.screenY);
  }, [enabled, queueMove]);

  const onPointerUp = useCallback<PointerEventHandler<T>>((event) => {
    if (!enabled || dragStateRef.current.activePointerId !== event.pointerId) {
      return;
    }
    finishDrag(event.screenX, event.screenY);
  }, [enabled, finishDrag]);

  const onPointerCancel = useCallback<PointerEventHandler<T>>((event) => {
    if (!enabled || dragStateRef.current.activePointerId !== event.pointerId) {
      return;
    }
    finishDrag();
  }, [enabled, finishDrag]);

  const onClickCapture = useCallback<MouseEventHandler<T>>((event) => {
    const state = dragStateRef.current;
    if (!enabled || !state.suppressClick) {
      return;
    }
    state.suppressClick = false;
    event.preventDefault();
    event.stopPropagation();
  }, [enabled]);

  useEffect(() => {
    return () => {
      const state = dragStateRef.current;
      if (state.dragging) {
        void windowDragEnd();
      }
      if (state.frameId !== null) {
        window.cancelAnimationFrame(state.frameId);
      }
    };
  }, []);

  if (!enabled) {
    return EMPTY_PROPS as Partial<WindowDragHandleProps<T>>;
  }

  return {
    onClickCapture,
    onLostPointerCapture: onPointerCancel,
    onPointerCancel,
    onPointerDown,
    onPointerMove,
    onPointerUp,
  };
}
