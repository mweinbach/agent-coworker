import path from "node:path";
import { fileURLToPath } from "node:url";

import { app, type IpcMainInvokeEvent } from "electron";

import { isTrustedDesktopSenderUrl } from "../services/ipcSecurity";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PACKAGED_RENDERER_DIR = path.resolve(path.join(__dirname, "../renderer"));

function resolveSenderUrl(event: IpcMainInvokeEvent): string {
  const senderFrameUrl = event.senderFrame?.url;
  if (typeof senderFrameUrl === "string") {
    return senderFrameUrl.trim();
  }
  return event.sender.getURL();
}

/** @public Imported dynamically by the ipc-trusted-sender test; not statically imported. */
export function isTrustedSender(event: IpcMainInvokeEvent): boolean {
  const senderUrl = resolveSenderUrl(event);
  return isTrustedDesktopSenderUrl(senderUrl, {
    isPackaged: app.isPackaged,
    electronRendererUrl: process.env.ELECTRON_RENDERER_URL,
    desktopRendererPort: process.env.COWORK_DESKTOP_RENDERER_PORT,
    packagedRendererDir: app.isPackaged ? PACKAGED_RENDERER_DIR : undefined,
  });
}

export function assertTrustedSender(event: IpcMainInvokeEvent): void {
  const senderUrl = resolveSenderUrl(event);
  if (!isTrustedSender(event)) {
    throw new Error(`Untrusted IPC sender: ${senderUrl || "unknown"}`);
  }
}
