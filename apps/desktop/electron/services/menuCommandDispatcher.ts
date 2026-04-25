import type { DesktopMenuCommand } from "../../src/lib/desktopApi";

type MenuCommandSink = {
  send(command: DesktopMenuCommand): void;
};

export function createMenuCommandDispatcher() {
  const pendingCommands: DesktopMenuCommand[] = [];

  return {
    dispatch(command: DesktopMenuCommand, sink?: MenuCommandSink | null): void {
      if (!sink) {
        pendingCommands.push(command);
        return;
      }
      sink.send(command);
    },
    drainPending(): DesktopMenuCommand[] {
      if (pendingCommands.length === 0) {
        return [];
      }
      return pendingCommands.splice(0, pendingCommands.length);
    },
  };
}
