import {
  assertKeyboardFocusJourney,
  assertNoViewportClipping,
  assertUsablePrimaryContentWidth,
  settleQualityPage,
} from "../assertions";
import { expect, type QualityLaunchOptions, type QualityMode, test } from "../fixtures";

const visualMatrix: Array<Pick<QualityLaunchOptions, "mode" | "width">> = [
  { mode: "light", width: 640 },
  { mode: "light", width: 800 },
  { mode: "light", width: 1_024 },
  { mode: "light", width: 1_240 },
  { mode: "dark", width: 640 },
  { mode: "dark", width: 1_240 },
  { mode: "reduced-motion", width: 800 },
  { mode: "forced-colors", width: 1_024 },
];

for (const entry of visualMatrix) {
  test.describe(`${entry.width}px ${entry.mode}`, () => {
    test.use({
      qualityOptions: {
        height: 820,
        mode: entry.mode,
        scenario: "product",
        startupDelayMs: 0,
        width: entry.width,
      },
    });

    test("shipping chat has no clipping and matches its approved baseline", async ({ quality }) => {
      const { page } = quality;
      await expect(page.getByRole("group", { name: "Message composer" })).toBeVisible();
      await expect(page.locator("html")).toHaveAttribute(
        "data-theme",
        entry.mode === "dark" ? "dark" : "light",
      );
      if (entry.mode === "forced-colors") {
        await expect(page.locator("html")).toHaveAttribute("data-high-contrast", "true");
      }
      if (entry.width <= 800) {
        await page.getByRole("button", { name: "Show sidebar" }).click();
        await expect(page.getByRole("button", { name: "Hide sidebar" })).toBeVisible();
        await page.getByRole("button", { name: "Hide sidebar" }).click();
        await expect(page.getByRole("button", { name: "Show sidebar" })).toBeVisible();
      }
      await settleQualityPage(page);
      await assertNoViewportClipping(page);
      await assertUsablePrimaryContentWidth(page);
      await assertKeyboardFocusJourney(page);
      await expect(page).toHaveScreenshot(
        `shipping-chat-${entry.width}-${entry.mode satisfies QualityMode}.png`,
      );
    });
  });
}
