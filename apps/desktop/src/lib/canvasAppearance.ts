import { type CaptionSymbolTone, NATIVE_THEME_TOKENS } from "../styles/tokens/native";
import { getFilePreviewKind } from "./filePreviewKind";

export type CanvasSurfaceKind = "document" | "spreadsheet";

export const CANVAS_DOCUMENT_COLORS = NATIVE_THEME_TOKENS.canvasDocument;

export const CANVAS_SPREADSHEET_COLORS = NATIVE_THEME_TOKENS.canvasSpreadsheet;

export function getCanvasSurfaceKind(filePath: string): CanvasSurfaceKind {
  const previewKind = getFilePreviewKind(filePath);
  return previewKind === "csv" || previewKind === "xlsx" ? "spreadsheet" : "document";
}

export function getCanvasNativeBackgroundColor(filePath: string, useDarkColors: boolean): string {
  if (getCanvasSurfaceKind(filePath) === "spreadsheet") {
    return CANVAS_SPREADSHEET_COLORS.background;
  }
  return useDarkColors
    ? CANVAS_DOCUMENT_COLORS.dark.background
    : CANVAS_DOCUMENT_COLORS.light.background;
}

export function getCanvasCaptionSymbolTone(
  filePath: string,
  useDarkColors: boolean,
): CaptionSymbolTone {
  if (getCanvasSurfaceKind(filePath) === "spreadsheet") {
    return "dark";
  }
  return useDarkColors ? "light" : "dark";
}
