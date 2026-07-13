import type { Locator, Page, TestInfo } from "@playwright/test";
import { DESKTOP_LAYOUT_BREAKPOINTS } from "../../src/lib/adaptiveLayout";
import {
  assertNoSeriousAxeViolations,
  assertNoViewportClipping,
  assertUsablePrimaryContentWidth,
  settleQualityPage,
} from "../assertions";
import { expect, test } from "../fixtures";

const widths = [640, 800, 1_024, 1_240] as const;

async function captureSurface(page: Page, testInfo: TestInfo, name: string): Promise<void> {
  await settleQualityPage(page);
  await assertNoViewportClipping(page);
  await assertNoSeriousAxeViolations(page, testInfo);
  await testInfo.attach(name, {
    body: await page.screenshot({ animations: "disabled" }),
    contentType: "image/png",
  });
}

for (const width of widths) {
  test.describe(`${width}px adaptive product surfaces`, () => {
    test.use({
      qualityOptions: {
        height: 820,
        mode: "light",
        scenario: "product",
        startupDelayMs: 0,
        width,
      },
    });

    test("keeps Canvas, Task, Research, Presentation, and Settings usable", async ({
      quality,
    }, testInfo) => {
      const { page } = quality;
      await assertUsablePrimaryContentWidth(page);

      await page.evaluate(() => window.__coworkQualityGate?.showFilePreview());
      await expect(
        page.getByRole("heading", { name: "Electron Canvas", exact: true }),
      ).toBeVisible();
      await expect(page.getByRole("button", { name: "Close canvas", exact: true })).toBeVisible();
      await assertUsablePrimaryContentWidth(page);
      await captureSurface(page, testInfo, `canvas-${width}`);

      await page.evaluate(() => {
        window.__coworkQualityGate?.showChat();
        window.__coworkQualityGate?.showPresentationPreview();
      });
      await expect(page.getByText("Canvas presentation", { exact: true }).first()).toBeVisible();
      const presentation = page.locator("[data-presentation-layout]");
      const presentationWidth = (await presentation.boundingBox())?.width ?? 0;
      await expect(presentation).toHaveAttribute(
        "data-presentation-layout",
        presentationWidth > 0 && presentationWidth < 520 ? "compact" : "full",
      );
      await assertUsablePrimaryContentWidth(page);
      await captureSurface(page, testInfo, `presentation-${width}`);

      await page.evaluate(() => window.__coworkQualityGate?.showTaskReview());
      let taskContext: Locator;
      if (width < DESKTOP_LAYOUT_BREAKPOINTS.full) {
        const contextTrigger = page.getByRole("button", { name: "Show context", exact: true });
        await expect(contextTrigger).toBeVisible();
        await contextTrigger.click();
        taskContext = page.getByRole("dialog", { name: "Context", exact: true });
      } else {
        taskContext = page.getByRole("region", { name: "Context", exact: true });
      }
      await expect(taskContext).toBeVisible();
      await expect(taskContext.getByRole("textbox", { name: "Title", exact: true })).toHaveValue(
        "Ship Electron quality gates",
      );
      await assertUsablePrimaryContentWidth(page);
      await captureSurface(page, testInfo, `task-${width}`);

      await page.evaluate(() => window.__coworkQualityGate?.showResearch("completed"));
      await expect(
        page.getByRole("heading", { name: "Recommendation", exact: true }),
      ).toBeVisible();
      const research = page.locator("[data-research-layout]");
      const researchWidth = (await research.boundingBox())?.width ?? 0;
      await expect(research).toHaveAttribute(
        "data-research-layout",
        researchWidth > 0 && researchWidth < 808 ? "compact" : "split",
      );
      await assertUsablePrimaryContentWidth(page);
      await captureSurface(page, testInfo, `research-${width}`);

      await page.evaluate(() => window.__coworkQualityGate?.openSettings("models"));
      await expect(page.getByRole("heading", { name: "Models", exact: true })).toBeVisible();
      await expect(page.locator("[data-layout-tier]").first()).toHaveAttribute(
        "data-layout-tier",
        width < DESKTOP_LAYOUT_BREAKPOINTS.narrow
          ? "narrow"
          : width < DESKTOP_LAYOUT_BREAKPOINTS.full
            ? "compact"
            : "full",
      );
      if (width < DESKTOP_LAYOUT_BREAKPOINTS.narrow) {
        await page.getByRole("button", { name: "Open settings navigation", exact: true }).click();
        await expect(
          page.getByRole("dialog", { name: "Settings navigation", exact: true }),
        ).toBeVisible();
      }
      await captureSurface(page, testInfo, `settings-${width}`);
    });
  });
}
