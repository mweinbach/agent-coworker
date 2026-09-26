/** At most one automatic reload per cooldown, so a renderer that crashes on load cannot loop. */
export const RENDERER_CRASH_RELOAD_COOLDOWN_MS = 30_000;

export type CrashedRendererReloadDecision = {
  reason: string;
  windowClosing: boolean;
  applicationQuitting: boolean;
  applicationQuitPending: boolean;
  windowDestroyed: boolean;
  webContentsDestroyed: boolean;
  lastReloadAtMs: number | undefined;
  nowMs: number;
};

/**
 * A crashed renderer is reloaded only when the window can still show it.
 * A close already in flight, a clean exit, or a shutdown must not start another load.
 */
export function shouldReloadCrashedRenderer(input: CrashedRendererReloadDecision): boolean {
  return (
    input.reason !== "clean-exit" &&
    !input.windowClosing &&
    !input.applicationQuitting &&
    !input.applicationQuitPending &&
    !input.windowDestroyed &&
    !input.webContentsDestroyed &&
    (input.lastReloadAtMs === undefined ||
      input.nowMs - input.lastReloadAtMs >= RENDERER_CRASH_RELOAD_COOLDOWN_MS)
  );
}
