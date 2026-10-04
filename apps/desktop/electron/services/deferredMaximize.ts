type MaximizableWindow = {
  isDestroyed(): boolean;
  maximize(): void;
};

/**
 * `BrowserWindow.maximize()` also shows a hidden window. Restored maximize
 * therefore waits until the first reveal, and only runs once.
 * A destroyed window does not consume that one shot.
 */
export function createDeferredMaximize(shouldRestore: boolean) {
  let pending = shouldRestore;
  return (win: MaximizableWindow): void => {
    if (!pending || win.isDestroyed()) return;
    pending = false;
    win.maximize();
  };
}
