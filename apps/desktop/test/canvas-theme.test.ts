import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { runInNewContext } from "node:vm";
import { JSDOM } from "jsdom";

import {
  CANVAS_DOCUMENT_COLORS,
  CANVAS_SPREADSHEET_COLORS,
  getCanvasNativeBackgroundColor,
  getCanvasSurfaceKind,
} from "../src/lib/canvasAppearance";
import type { SystemAppearance } from "../src/lib/desktopApi";
import {
  applySystemAppearanceToDocument,
  RESOLVED_THEME_STORAGE_KEY,
  THEME_SOURCE_STORAGE_KEY,
} from "../src/lib/themeBootstrap";

function channelToLinear(channel: number): number {
  const value = channel / 255;
  return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
}

function relativeLuminance(hex: string): number {
  const channels = hex
    .slice(1)
    .match(/.{2}/g)
    ?.map((value) => Number.parseInt(value, 16));
  if (channels?.length !== 3) {
    throw new Error(`Expected six-digit hex color, received ${hex}`);
  }
  const [red, green, blue] = channels.map(channelToLinear);
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}

function contrastRatio(foreground: string, background: string): number {
  const lighter = Math.max(relativeLuminance(foreground), relativeLuminance(background));
  const darker = Math.min(relativeLuminance(foreground), relativeLuminance(background));
  return (lighter + 0.05) / (darker + 0.05);
}

function appearance(overrides: Partial<SystemAppearance> = {}): SystemAppearance {
  return {
    platform: "linux",
    themeSource: "system",
    shouldUseDarkColors: false,
    shouldUseDarkColorsForSystemIntegratedUI: false,
    shouldUseHighContrastColors: false,
    shouldUseInvertedColorScheme: false,
    prefersReducedTransparency: false,
    inForcedColorsMode: false,
    ...overrides,
  };
}

function executeBootstrapScript(options: {
  path: string;
  prefersDark: boolean;
  forcedColors?: boolean;
  storageFailure?: boolean;
  themeSource?: "system" | "light" | "dark";
}): JSDOM {
  const html = readFileSync(resolve(import.meta.dir, "../index.html"), "utf8");
  const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1];
  if (!script) {
    throw new Error("Missing first-paint bootstrap script");
  }
  const dom = new JSDOM("<!doctype html><html><head></head><body></body></html>");
  const storage = new Map<string, string>();
  if (options.themeSource) {
    storage.set(THEME_SOURCE_STORAGE_KEY, options.themeSource);
  }
  runInNewContext(script, {
    document: dom.window.document,
    localStorage: {
      getItem(key: string) {
        if (options.storageFailure) {
          throw new Error("Storage unavailable");
        }
        return storage.get(key) ?? null;
      },
    },
    URLSearchParams,
    window: {
      location: {
        search: `?window=canvas&path=${encodeURIComponent(options.path)}`,
      },
      matchMedia(query: string) {
        return {
          matches:
            query === "(prefers-color-scheme: dark)"
              ? options.prefersDark
              : query === "(forced-colors: active)"
                ? options.forcedColors === true
                : false,
        };
      },
    },
  });
  return dom;
}

describe("Canvas semantic appearance", () => {
  test("classifies every spreadsheet extension without affecting document kinds", () => {
    expect(getCanvasSurfaceKind("/tmp/report.csv")).toBe("spreadsheet");
    expect(getCanvasSurfaceKind("C:\\reports\\MODEL.XLSX")).toBe("spreadsheet");
    for (const path of ["notes.md", "notes.txt", "deck.pptx", "slide-1.mjs"]) {
      expect(getCanvasSurfaceKind(path)).toBe("document");
    }
  });

  test("uses explicit native backgrounds for file kind and resolved theme", () => {
    expect(getCanvasNativeBackgroundColor("notes.md", false)).toBe(
      CANVAS_DOCUMENT_COLORS.light.background,
    );
    expect(getCanvasNativeBackgroundColor("notes.md", true)).toBe(
      CANVAS_DOCUMENT_COLORS.dark.background,
    );
    expect(getCanvasNativeBackgroundColor("report.xlsx", true)).toBe(
      CANVAS_SPREADSHEET_COLORS.background,
    );
  });

  test("keeps normal Canvas text above WCAG AA contrast in every palette", () => {
    const palettes = [
      CANVAS_DOCUMENT_COLORS.light,
      CANVAS_DOCUMENT_COLORS.dark,
      CANVAS_SPREADSHEET_COLORS,
    ];
    for (const palette of palettes) {
      expect(contrastRatio(palette.foreground, palette.background)).toBeGreaterThanOrEqual(4.5);
    }
  });

  test("declares opaque semantic roots and forced-colors fallbacks", () => {
    const themeBridge = readFileSync(
      resolve(import.meta.dir, "../src/styles/theme-bridge.css"),
      "utf8",
    );
    const styles = readFileSync(resolve(import.meta.dir, "../src/styles.css"), "utf8");
    expect(themeBridge).toContain("--color-canvas: var(--surface-canvas)");
    expect(themeBridge).toContain('[data-canvas-surface="spreadsheet"]');
    expect(themeBridge).toContain("--surface-window: var(--surface-spreadsheet)");
    expect(themeBridge).toContain("--surface-canvas: Canvas");
    expect(themeBridge).toContain("--text-canvas: CanvasText");
    expect(styles).toContain(':root[data-window-mode="canvas"][data-canvas-surface] body');
    expect(styles).toContain("background: var(--surface-canvas)");
  });
});

describe("Canvas first paint and live theme changes", () => {
  test("sets document dark theme and surface before the renderer module", () => {
    const html = readFileSync(resolve(import.meta.dir, "../index.html"), "utf8");
    expect(html.indexOf("root.dataset.canvasSurface")).toBeLessThan(
      html.indexOf('type="module" src="/src/main.tsx"'),
    );

    const dom = executeBootstrapScript({
      path: "/workspace/notes.md",
      prefersDark: true,
    });
    const root = dom.window.document.documentElement;
    expect(root.dataset.windowMode).toBe("canvas");
    expect(root.dataset.canvasSurface).toBe("document");
    expect(root.dataset.theme).toBe("dark");
    expect(root.dataset.systemTheme).toBe("dark");
    expect(root.classList.contains("dark")).toBe(true);
  });

  test("keeps spreadsheets light-scoped while detecting forced colors before paint", () => {
    const dom = executeBootstrapScript({
      path: "/workspace/report.XLSX",
      prefersDark: true,
      forcedColors: true,
    });
    const root = dom.window.document.documentElement;
    expect(root.dataset.canvasSurface).toBe("spreadsheet");
    expect(root.dataset.highContrast).toBe("true");
    expect(root.style.colorScheme).toBe("light dark");
  });

  test("keeps spreadsheet control chrome light under a dark system theme", () => {
    const dom = executeBootstrapScript({
      path: "/workspace/report.csv",
      prefersDark: true,
    });
    const root = dom.window.document.documentElement;
    expect(root.dataset.theme).toBe("dark");
    expect(root.dataset.canvasSurface).toBe("spreadsheet");
    expect(root.style.colorScheme).toBe("light");
  });

  test("continues probing system media when persisted theme storage is unavailable", () => {
    const dom = executeBootstrapScript({
      path: "/workspace/notes.md",
      prefersDark: true,
      storageFailure: true,
    });
    const root = dom.window.document.documentElement;
    expect(root.dataset.themeSource).toBe("system");
    expect(root.dataset.theme).toBe("dark");
    expect(root.dataset.canvasSurface).toBe("document");
  });

  test("applies light-to-dark updates without dropping the Canvas surface", () => {
    const dom = new JSDOM("<!doctype html><html data-canvas-surface='document'></html>");
    const writes = new Map<string, string>();
    const storage = {
      setItem(key: string, value: string) {
        writes.set(key, value);
      },
    };

    applySystemAppearanceToDocument(appearance(), dom.window.document, storage);
    applySystemAppearanceToDocument(
      appearance({
        shouldUseDarkColors: true,
        shouldUseDarkColorsForSystemIntegratedUI: true,
        themeSource: "dark",
      }),
      dom.window.document,
      storage,
    );

    const root = dom.window.document.documentElement;
    expect(root.dataset.canvasSurface).toBe("document");
    expect(root.dataset.theme).toBe("dark");
    expect(root.style.colorScheme).toBe("dark");
    expect(root.classList.contains("dark")).toBe(true);
    expect(root.classList.contains("light")).toBe(false);
    expect(writes.get(THEME_SOURCE_STORAGE_KEY)).toBe("dark");
    expect(writes.get(RESOLVED_THEME_STORAGE_KEY)).toBe("dark");
  });

  test("preserves spreadsheet color scheme during live dark-theme updates", () => {
    const dom = new JSDOM(
      "<!doctype html><html data-canvas-surface='spreadsheet' data-window-mode='canvas'></html>",
    );
    applySystemAppearanceToDocument(
      appearance({
        shouldUseDarkColors: true,
        shouldUseDarkColorsForSystemIntegratedUI: true,
      }),
      dom.window.document,
    );

    const root = dom.window.document.documentElement;
    expect(root.dataset.theme).toBe("dark");
    expect(root.style.colorScheme).toBe("light");
  });
});
