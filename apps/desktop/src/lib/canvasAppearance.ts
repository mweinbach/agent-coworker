import { getFilePreviewKind } from "./filePreviewKind";

export type CanvasSurfaceKind = "document" | "spreadsheet";

export const CANVAS_DOCUMENT_COLORS = {
  light: {
    background: "#f8f9f2",
    foreground: "#232a18",
  },
  dark: {
    background: "#2a3120",
    foreground: "#eef0dc",
  },
} as const;

export const CANVAS_SPREADSHEET_COLORS = {
  background: "#ffffff",
  foreground: "#24292f",
} as const;

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
