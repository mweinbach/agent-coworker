import {
  assertKeyboardFocusJourney,
  assertNoSeriousAxeViolations,
  assertNoViewportClipping,
  settleQualityPage,
} from "../assertions";
import { expect, type QualityLaunchOptions, type QualityMode, test } from "../fixtures";

const widths = [640, 800, 1_024, 1_240] as const;
const modes: QualityMode[] = ["light", "dark", "reduced-motion", "forced-colors"];
const visualMatrix: Array<Pick<QualityLaunchOptions, "mode" | "width">> = widths.flatMap((width) =>
  modes.map((mode) => ({ mode, width })),
);

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

    test("shipping chat passes clipping, keyboard, Axe, and visual gates", async ({
      quality,
    }, testInfo) => {
      const { page } = quality;
      await expect(page.getByRole("group", { name: "Message composer" })).toBeVisible();
      await expect(page.locator("html")).toHaveAttribute(
        "data-theme",
        entry.mode === "dark" ? "dark" : "light",
      );
      if (entry.mode === "forced-colors") {
        await expect(page.locator("html")).toHaveAttribute("data-high-contrast", "true");
      }
      await settleQualityPage(page);
      await assertNoViewportClipping(page);
      await assertKeyboardFocusJourney(page);
      await assertNoSeriousAxeViolations(page, testInfo);
      await expect(page).toHaveScreenshot(
        `shipping-chat-${entry.width}-${entry.mode satisfies QualityMode}.png`,
      );
    });
  });
}
