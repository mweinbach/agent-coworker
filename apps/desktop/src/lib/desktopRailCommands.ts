export type DesktopRailCommand = "toggle-context" | "toggle-sidebar";

const listeners = new Set<(command: DesktopRailCommand) => void>();

export function requestDesktopRailCommand(command: DesktopRailCommand): void {
  for (const listener of listeners) {
    listener(command);
  }
}

export function onDesktopRailCommand(listener: (command: DesktopRailCommand) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
