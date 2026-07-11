import { NATIVE_THEME_TOKENS } from "../../src/styles/tokens/native";
import { settleQualityPage } from "../assertions";
import { expect, type QualityHarness, type QualityMode, test } from "../fixtures";

const canvasCases = [
  {
    kind: "markdown",
    path: "/quality/project/canvas-notes.md",
    surface: "document",
  },
  {
    kind: "text",
    path: "/quality/project/canvas-notes.txt",
    surface: "document",
  },
  {
    kind: "spreadsheet",
    path: "/quality/project/canvas-report.xlsx",
    surface: "spreadsheet",
  },
  {
    kind: "presentation",
    path: "/quality/project/canvas-presentation.pptx",
    surface: "document",
  },
] as const;

async function openCanvasWindow(quality: QualityHarness, path: string) {
  return await quality.openWindow(async () => {
    await quality.electronApp.evaluate(async (_electron, canvasPath) => {
      const control = globalThis.__coworkQualityGateMain;
      if (!control) {
        throw new Error("Quality-gate main control is unavailable");
      }
      await control.openCanvas(canvasPath);
    }, path);
  });
}

function hexToRgbCss(hex: string): string {
  const value = Number.parseInt(hex.slice(1), 16);
  return `rgb(${(value >> 16) & 255}, ${(value >> 8) & 255}, ${value & 255})`;
}

for (const mode of ["light", "dark", "forced-colors"] satisfies QualityMode[]) {
  test.describe(`Canvas ${mode} surfaces`, () => {
    test.use({
      qualityOptions: {
        height: 700,
        mode,
        scenario: "product",
        startupDelayMs: 0,
        width: 900,
      },
    });

    test(`renders every Canvas kind with an opaque ${mode} surface`, async ({ quality }) => {
      for (const canvasCase of canvasCases) {
        const canvasWindow = await openCanvasWindow(quality, canvasCase.path);
        await expect(canvasWindow.locator("html")).toHaveAttribute(
          "data-theme",
          mode === "dark" ? "dark" : "light",
        );
        await expect(canvasWindow.locator("html")).toHaveAttribute(
          "data-canvas-surface",
          canvasCase.surface,
        );
        if (mode === "forced-colors") {
          await expect(canvasWindow.locator("html")).toHaveAttribute("data-high-contrast", "true");
        }
        if (canvasCase.kind === "spreadsheet") {
          await expect(canvasWindow.locator('[data-cowork-univer-canvas="true"]')).toBeVisible();
          await expect(canvasWindow.getByText("Opening workbook")).toHaveCount(0);
        } else if (canvasCase.kind === "presentation") {
          await expect(canvasWindow.getByRole("button", { name: "Refresh" })).toBeVisible();
          await settleQualityPage(canvasWindow);
          if (
            await canvasWindow
              .getByRole("heading", { name: "Couldn’t render presentation" })
              .isVisible()
          ) {
            await canvasWindow.getByRole("button", { name: "Try again" }).click();
          }
          await expect(canvasWindow.getByAltText("Canvas presentation")).toBeVisible();
        } else {
          await expect(
            canvasCase.kind === "markdown"
              ? canvasWindow.getByRole("heading", { name: "Electron Canvas", exact: true })
              : canvasWindow.getByText("Source Editor", { exact: true }),
          ).toBeVisible();
        }
        await expect
          .poll(async () =>
            canvasWindow.evaluate(() => {
              const root = document.documentElement;
              const body = document.body;
              return [root, body].every(
                (element) => getComputedStyle(element).backgroundColor !== "rgba(0, 0, 0, 0)",
              );
            }),
          )
          .toBe(true);
        await settleQualityPage(canvasWindow);
        await expect(canvasWindow).toHaveScreenshot(
          `canvas-${canvasCase.kind}-${mode satisfies QualityMode}.png`,
        );
        await canvasWindow.close();
      }
    });
  });
}

test.describe("Canvas loading and error surfaces", () => {
  test.use({
    qualityOptions: {
      height: 700,
      mode: "dark",
      scenario: "product",
      startupDelayMs: 0,
      width: 900,
    },
  });

  test("renders semantic document loading and error states", async ({ quality }) => {
    const loadingWindow = await openCanvasWindow(quality, "/quality/project/canvas-loading.md");
    await expect(loadingWindow.getByText("Reading file...", { exact: true })).toBeVisible();
    await expect(loadingWindow.locator("html")).toHaveAttribute("data-theme", "dark");
    await expect(loadingWindow).toHaveScreenshot("canvas-markdown-loading-dark.png");
    await loadingWindow.close();

    const errorWindow = await openCanvasWindow(quality, "/quality/project/canvas-error.md");
    await expect(errorWindow.getByText("Failed to load content", { exact: true })).toBeVisible();
    await expect(
      errorWindow.getByText("Quality fixture could not read this document.", { exact: true }),
    ).toBeVisible();
    await expect(errorWindow.getByRole("button", { name: "Retry" })).toBeVisible();
    await settleQualityPage(errorWindow);
    await expect(errorWindow).toHaveScreenshot("canvas-markdown-error-dark.png");
    await errorWindow.close();
  });
});

test.describe("Canvas live theme changes", () => {
  test.use({
    qualityOptions: {
      height: 700,
      mode: "light",
      scenario: "product",
      startupDelayMs: 0,
      width: 900,
    },
  });

  test("updates an open document renderer and native background together", async ({ quality }) => {
    const path = "/quality/project/canvas-theme-switch.md";
    const canvasWindow = await openCanvasWindow(quality, path);
    await expect(canvasWindow.getByText("Electron Canvas", { exact: true })).toBeVisible();
    await expect(canvasWindow.locator("html")).toHaveAttribute("data-theme", "light");

    await quality.electronApp.evaluate(() => {
      const control = globalThis.__coworkQualityGateMain;
      if (!control) {
        throw new Error("Quality-gate main control is unavailable");
      }
      control.setTheme("dark");
    });

    await expect(canvasWindow.locator("html")).toHaveAttribute("data-theme", "dark");
    await expect
      .poll(async () =>
        canvasWindow.evaluate(() => getComputedStyle(document.body).backgroundColor),
      )
      .toBe(hexToRgbCss(NATIVE_THEME_TOKENS.canvasDocument.dark.background));
    const nativeBackground = await quality.electronApp.evaluate(({ BrowserWindow }, canvasPath) => {
      const canvas = BrowserWindow.getAllWindows().find((candidate) =>
        candidate.webContents.getURL().includes(encodeURIComponent(canvasPath)),
      );
      return canvas?.getBackgroundColor() ?? "";
    }, path);
    expect(nativeBackground.toLowerCase()).toContain(
      NATIVE_THEME_TOKENS.canvasDocument.dark.background.slice(1),
    );
    await settleQualityPage(canvasWindow);
    await expect(canvasWindow).toHaveScreenshot("canvas-markdown-live-switch-dark.png");
  });
});
