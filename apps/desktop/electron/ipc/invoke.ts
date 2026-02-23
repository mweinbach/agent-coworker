import { ipcMain, type IpcMainInvokeEvent } from "electron";

import { assertTrustedSender } from "./trustedSender";

function toIpcError(error: unknown): Error {
  if (error instanceof Error) {
    return error;
  }
  return new Error(String(error));
}

export function handleDesktopInvoke<TArgs extends unknown[], TResult>(
  channel: string,
  handler: (event: IpcMainInvokeEvent, ...args: TArgs) => Promise<TResult> | TResult
): void {
  ipcMain.handle(channel, async (event, ...args) => {
    try {
      assertTrustedSender(event);
      return await handler(event, ...(args as TArgs));
    } catch (error) {
      throw toIpcError(error);
    }
  });
}
