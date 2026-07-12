import { hostPlatform } from "../../../../src/platform/host";
import { expect, test } from "../fixtures";

for (const mode of ["light", "dark", "system"] as const) {
  test.describe(`native first paint ${mode}`, () => {
    test.use({
      qualityOptions: {
        appearanceDelayMs: 250,
        // Fits the smallest macOS CI work area after its 36px native inset.
        height: 684,
        holdBootstrap: true,
        mode,
        recordVideo: false,
        scenario: "first-launch",
        startupDelayMs: 250,
        width: 960,
      },
    });

    test(`keeps the ${mode} native window and renderer surfaces aligned`, async ({ quality }) => {
      const { electronApp, page } = quality;
      const resolvedTheme = mode === "light" ? "light" : "dark";
      const expectedBackground = mode === "light" ? "dde1ca" : "171d13";

      await expect(page.locator("html")).toHaveAttribute("data-platform", hostPlatform());
      await expect(page.locator("html")).toHaveAttribute("data-theme-source", mode);
      await expect(page.locator("html")).toHaveAttribute("data-theme", resolvedTheme);
      await expect(page.getByRole("status")).toContainText("Restoring your workspace");

      const nativeWindow = await electronApp.evaluate(({ BrowserWindow }) => {
        const windows = BrowserWindow.getAllWindows();
        return {
          backgroundColor: windows[0]?.getBackgroundColor().toLowerCase() ?? null,
          count: windows.length,
        };
      });
      expect(nativeWindow.count).toBe(1);
      expect(nativeWindow.backgroundColor).toContain(expectedBackground);

      const lifecycle = await quality.getLifecycle();
      expect(lifecycle.networkGuardInstalled).toBeLessThan(lifecycle.captureReady);
      expect(lifecycle.captureReady).toBeLessThan(lifecycle.firstWindowCreated);
      expect(lifecycle.firstWindowCreated).toBeLessThan(lifecycle.firstLoadStarted);
    });
  });
}
