/// <reference types="vite/client" />

import type { DesktopApi } from "./lib/desktopApi";

declare global {
  interface Window {
    cowork?: DesktopApi;
  }
}
