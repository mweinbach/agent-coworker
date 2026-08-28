import { expect, type QualityMode, test } from "../fixtures";

for (const mode of [
  "light",
  "dark",
  "system",
  "reduced-motion",
  "forced-colors",
] satisfies QualityMode[]) {
  test.describe(`Quality ${mode} media`, () => {
    test.use({
      qualityOptions: {
        height: 700,
        mode,
        scenario: "product",
        startupDelayMs: 0,
        width: 900,
      },
    });

    test("applies requested media to initial and popup windows", async ({ quality }) => {
      const popup = await quality.openWindow(async () => {
        await quality.electronApp.evaluate(async () => {
          const control = globalThis.__coworkQualityGateMain;
          if (!control) {
            throw new Error("Quality-gate main control is unavailable");
          }
          await control.openCanvas("/quality/project/canvas-notes.md");
        });
      });

      const expected = {
        dark: mode === "dark" || mode === "system",
        forcedColors: mode === "forced-colors",
        reducedMotion: mode === "reduced-motion",
      };
      for (const [name, page] of [
        ["initial", quality.page],
        ["popup", popup],
      ] as const) {
        const media = await page.evaluate(() => ({
          dark: window.matchMedia("(prefers-color-scheme: dark)").matches,
          forcedColors: window.matchMedia("(forced-colors: active)").matches,
          reducedMotion: window.matchMedia("(prefers-reduced-motion: reduce)").matches,
        }));
        expect(media, `${name} window media`).toEqual(expected);
      }
      await popup.close();
    });
  });
}
