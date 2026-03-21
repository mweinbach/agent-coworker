import type { BrowserWindow, BrowserWindowConstructorOptions } from "electron";

export type WindowChromeContext = {
  useDarkColors: boolean;
  useMacosNativeGlass: boolean;
};

export type WindowChromeOptions = Partial<WindowChromeContext> & {
  platform?: NodeJS.Platform;
};

export type WindowChromeModule = {
  getBrowserWindowOptions: (
    context: WindowChromeContext,
  ) => Partial<BrowserWindowConstructorOptions>;
  applyWindowCreated?: (win: BrowserWindow) => void;
  syncAppearance?: (win: BrowserWindow, context: WindowChromeContext) => void;
};
