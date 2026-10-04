type MaximizableWindow = { isDestroyed(): boolean; maximize(): void };

/**
 * `BrowserWindow.maximize()` also shows a hidden window, so restored maximize
 * waits until the first live reveal and runs at most once.
 */
export function createDeferredMaximize(shouldRestore: boolean) {
  let pending = shouldRestore;
  return (win: MaximizableWindow): void => {
    if (!pending || win.isDestroyed()) return;
    pending = false;
    win.maximize();
  };
}
