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

    if (mode === "reduced-motion" || mode === "forced-colors") {
      test("keeps thinking feedback static and readable", async ({ quality }) => {
        const { page } = quality;
        // Exercise the shipping CSS without depending on a transient gap between
        // the turn-start and first-token notifications.
        await page.evaluate(() => {
          const label = document.createElement("span");
          label.dataset.qualityMotionProbe = "true";
          label.className = "activity-thinking-shimmer";
          label.textContent = "Working";
          document.body.append(label);
        });
        const label = page.locator('[data-quality-motion-probe="true"]');
        await expect(label).toHaveCSS("animation-name", "none");
        await expect(label).toHaveCSS("background-image", "none");
        const colors = await label.evaluate((element) => {
          const style = getComputedStyle(element);
          return { color: style.color, textFill: style.webkitTextFillColor };
        });
        expect(colors.textFill).toBe(colors.color);
        expect(colors.textFill).not.toBe("rgba(0, 0, 0, 0)");
      });
    }

    if (mode === "forced-colors") {
      test("shows a real focus outline on borderless controls and the composer", async ({
        quality,
      }) => {
        const { page } = quality;
        await page.keyboard.press("Tab");
        for (const control of [
          page.getByRole("button", { name: "Hide sidebar", exact: true }),
          page.getByRole("combobox", { name: "Message input", exact: true }),
        ]) {
          await control.focus();
          await expect(control).toBeFocused();
          expect(await control.evaluate((element) => element.matches(":focus-visible"))).toBe(true);
          await expect(control).toHaveCSS("outline-style", "solid");
          await expect(control).toHaveCSS("outline-width", "2px");
        }

        await page.evaluate(() => window.__coworkQualityGate?.openSettings("toolAccess"));
        const tab = page.getByRole("tab").first();
        await tab.focus();
        await expect(tab).toBeFocused();
        await expect(tab).toHaveCSS("outline-style", "solid");
        await expect(tab).toHaveCSS("outline-width", "2px");
      });
    }
  });
}
