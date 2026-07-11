import type { BrowserWindow, BrowserWindowConstructorOptions } from "electron";
import type { CaptionSymbolTone } from "../../../src/styles/tokens/native";

export type WindowChromeContext = {
  backgroundColor?: string;
  captionSymbolTone: CaptionSymbolTone;
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
