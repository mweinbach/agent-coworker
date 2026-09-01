import type { Locator, Page, TestInfo } from "@playwright/test";
import { DESKTOP_LAYOUT_BREAKPOINTS } from "../../src/lib/adaptiveLayout";
import {
  assertMinimumTextContrast,
  assertNoSeriousAxeViolations,
  assertNoViewportClipping,
  assertUsablePrimaryContentWidth,
  settleQualityPage,
} from "../assertions";
import { expect, type QualityMode, test } from "../fixtures";

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

    test("keeps Canvas, Task, Presentation, and Settings usable", async ({ quality }, testInfo) => {
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

for (const mode of ["light", "dark", "forced-colors"] satisfies QualityMode[]) {
  test.describe(`${mode} error notifications`, () => {
    test.use({
      qualityOptions: {
        height: 820,
        mode,
        scenario: "product",
        startupDelayMs: 0,
        width: 640,
      },
    });

    test("keeps errors readable above the Settings backdrop", async ({ quality }, testInfo) => {
      const { page } = quality;
      await page.evaluate(() => window.__coworkQualityGate?.openSettings("models"));
      await expect(page.getByRole("heading", { name: "Models", exact: true })).toBeVisible();
      await page.getByRole("button", { name: "Open settings navigation", exact: true }).click();
      const navigation = page.getByRole("dialog", { name: "Settings navigation", exact: true });
      await expect(navigation).toBeVisible();
      await expect(page.locator('[data-slot="adaptive-rail-backdrop"]')).toBeVisible();

      const closeNavigation = navigation.getByRole("button", {
        name: "Close Settings navigation",
        exact: true,
      });
      await closeNavigation.focus();
      await expect(closeNavigation).toBeFocused();
      await page.evaluate(() => window.__coworkQualityGate?.showErrorNotification());
      const toastSelector = '[data-slot="in-app-toast"][data-kind="error"]';
      const toast = page.locator(toastSelector).filter({ hasText: "Changes were not saved" });
      await expect(toast).toBeVisible();
      await expect(toast).toHaveAttribute("aria-live", "assertive");
      await expect(
        toast.getByText("Your work is still open. Check the connection and try again.", {
          exact: true,
        }),
      ).toBeVisible();
      await expect(closeNavigation).toBeFocused();
      await settleQualityPage(page);

      for (const slot of ["in-app-toast-title", "in-app-toast-detail"]) {
        await assertMinimumTextContrast(page, {
          backgroundSelector: toastSelector,
          foregroundSelector: `${toastSelector} [data-slot="${slot}"]`,
          label: `${mode} ${slot}`,
          minimumRatio: 4.5,
        });
      }
      if (mode === "forced-colors") {
        expect(
          await page.evaluate(() => window.matchMedia("(forced-colors: active)").matches),
        ).toBe(true);
        const colors = await toast.evaluate((element) => ({
          title: getComputedStyle(
            element.querySelector('[data-slot="in-app-toast-title"]') ?? element,
          ).color,
          detail: getComputedStyle(
            element.querySelector('[data-slot="in-app-toast-detail"]') ?? element,
          ).color,
          foreground: getComputedStyle(document.documentElement).color,
          surface: getComputedStyle(document.documentElement)
            .getPropertyValue("--surface-opaque")
            .trim(),
        }));
        expect(colors.surface).toBe("Canvas");
        expect(colors.title).toBe(colors.foreground);
        expect(colors.detail).toBe(colors.foreground);
      }
      await captureSurface(page, testInfo, `error-notification-${mode}`);

      if (mode === "light" || mode === "forced-colors") {
        if (mode === "light") {
          await page.emulateMedia({ forcedColors: "active" });
          await settleQualityPage(page);
        }
        const models = navigation.getByRole("button", { name: "Models", exact: true });
        await expect(models).toHaveAttribute("aria-current", "page");
        await expect(models).toHaveScreenshot("settings-navigation-models-forced-colors.png");
      }

      if (mode === "light") {
        await captureSurface(page, testInfo, "settings-navigation-media-transition");
      }
      if (mode === "forced-colors") {
        for (const { label, snapshot } of [
          { label: "Profile & Memory", snapshot: "profile-memory" },
          { label: "Models", snapshot: "models" },
        ]) {
          await navigation.getByRole("button", { name: label, exact: true }).click();
          await expect(page.getByRole("heading", { name: label, exact: true })).toBeVisible();
          await page.getByRole("button", { name: "Open settings navigation", exact: true }).click();
          const selectedPage = navigation.getByRole("button", { name: label, exact: true });
          await expect(selectedPage).toHaveAttribute("aria-current", "page");
          await expect(selectedPage).toHaveScreenshot(
            `settings-navigation-${snapshot}-forced-colors.png`,
          );
        }
        await captureSurface(page, testInfo, "settings-navigation-round-trip");
      }
    });
  });
}
