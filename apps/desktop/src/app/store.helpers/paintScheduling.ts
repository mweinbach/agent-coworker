const DEFAULT_NEXT_PAINT_TIMEOUT_MS = 100;

export function waitForNextPaintOrTimeout(
  timeoutMs = DEFAULT_NEXT_PAINT_TIMEOUT_MS,
): Promise<void> {
  return new Promise<void>((resolve) => {
    runAfterNextPaintOrTimeout(resolve, timeoutMs);
  });
}

function runAfterNextPaintOrTimeout(
  task: () => void,
  timeoutMs = DEFAULT_NEXT_PAINT_TIMEOUT_MS,
): void {
  if (typeof window === "undefined" || typeof window.requestAnimationFrame !== "function") {
    setTimeout(task, 0);
    return;
  }

  let settled = false;
  let fallbackTimer: ReturnType<typeof setTimeout> | undefined;

  const settle = () => {
    if (settled) {
      return;
    }
    settled = true;
    if (fallbackTimer) {
      clearTimeout(fallbackTimer);
    }
    setTimeout(task, 0);
  };

  fallbackTimer = setTimeout(settle, Math.max(0, timeoutMs));
  window.requestAnimationFrame(() => {
    settle();
  });
}
