import { promises as fs } from "node:fs";

import { AxeBuilder } from "@axe-core/playwright";
import { expect } from "@playwright/test";
import type { Page, TestInfo } from "playwright";

export async function settleQualityPage(page: Page): Promise<void> {
  await page.evaluate(async () => {
    await document.fonts.ready;
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
    );
  });
}

export async function assertNoSeriousAxeViolations(
  page: Page,
  testInfo: TestInfo,
  include?: string,
): Promise<void> {
  let builder = new AxeBuilder({ page })
    .setLegacyMode()
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]);
  if (include) {
    builder = builder.include(include);
  }
  const results = await builder.analyze();
  const seriousViolations = results.violations.filter(
    (violation) => violation.impact === "critical" || violation.impact === "serious",
  );
  const axeResultsPath = testInfo.outputPath("axe-results.json");
  await fs.writeFile(axeResultsPath, `${JSON.stringify(results, null, 2)}\n`, "utf8");
  await testInfo.attach("axe-results", {
    path: axeResultsPath,
  });
  expect(
    seriousViolations,
    seriousViolations
      .map(
        (violation) =>
          `${violation.id}: ${violation.help}\n${violation.nodes
            .map((node) => `  ${node.target.join(" ")}: ${node.failureSummary ?? ""}`)
            .join("\n")}`,
      )
      .join("\n\n"),
  ).toEqual([]);
}

export async function assertNoViewportClipping(page: Page): Promise<void> {
  const result = await page.evaluate(() => {
    const root = document.documentElement;
    const viewport = { width: window.innerWidth, height: window.innerHeight };
    const clippedControls: Array<{
      label: string;
      rect: {
        bottom: number;
        height: number;
        left: number;
        right: number;
        top: number;
        width: number;
      };
    }> = [];
    const controls = document.querySelectorAll<HTMLElement>(
      'button, input, textarea, select, [role="button"], [role="checkbox"], [role="switch"]',
    );
    for (const control of controls) {
      const style = getComputedStyle(control);
      const rect = control.getBoundingClientRect();
      if (
        style.display === "none" ||
        style.visibility === "hidden" ||
        rect.width === 0 ||
        rect.height === 0
      ) {
        continue;
      }
      if (
        rect.bottom <= 0 ||
        rect.top >= viewport.height ||
        rect.right <= 0 ||
        rect.left >= viewport.width
      ) {
        continue;
      }
      let clippingAncestor = control.parentElement;
      let clippedByScrollableAncestor = false;
      while (clippingAncestor) {
        const ancestorStyle = getComputedStyle(clippingAncestor);
        const clipsX = ["auto", "clip", "hidden", "scroll"].includes(ancestorStyle.overflowX);
        const clipsY = ["auto", "clip", "hidden", "scroll"].includes(ancestorStyle.overflowY);
        if (clipsX || clipsY) {
          const ancestorRect = clippingAncestor.getBoundingClientRect();
          if (
            (clipsX && (rect.left < ancestorRect.left || rect.right > ancestorRect.right)) ||
            (clipsY && (rect.top < ancestorRect.top || rect.bottom > ancestorRect.bottom))
          ) {
            clippedByScrollableAncestor = true;
            break;
          }
        }
        clippingAncestor = clippingAncestor.parentElement;
      }
      if (clippedByScrollableAncestor) {
        continue;
      }
      if (
        rect.left < -0.5 ||
        rect.right > viewport.width + 0.5 ||
        rect.top < -0.5 ||
        rect.bottom > viewport.height + 0.5
      ) {
        clippedControls.push({
          label:
            control.getAttribute("aria-label") ||
            control.textContent?.trim().slice(0, 80) ||
            control.tagName,
          rect: {
            bottom: rect.bottom,
            height: rect.height,
            left: rect.left,
            right: rect.right,
            top: rect.top,
            width: rect.width,
          },
        });
      }
    }
    return {
      clippedControls,
      documentScrollWidth: root.scrollWidth,
      viewport,
    };
  });

  expect(
    result.documentScrollWidth,
    `Document is ${result.documentScrollWidth}px wide in a ${result.viewport.width}px viewport`,
  ).toBeLessThanOrEqual(result.viewport.width);
  expect(
    result.clippedControls,
    "Visible interactive controls must remain inside the viewport",
  ).toEqual([]);
}

export async function assertUsablePrimaryContentWidth(
  page: Page,
  minimumWidth = 280,
): Promise<void> {
  const primaryContentWidth = await page
    .locator('[data-slot="primary-content-pane"]')
    .evaluate((element) => element.getBoundingClientRect().width);
  expect(
    primaryContentWidth,
    `Primary content must retain at least ${minimumWidth}px of usable width`,
  ).toBeGreaterThanOrEqual(minimumWidth);
}

export async function assertKeyboardFocusJourney(page: Page): Promise<void> {
  await page.locator("body").click({ position: { x: 2, y: 2 } });
  let focused = false;
  for (let index = 0; index < 12; index += 1) {
    await page.keyboard.press("Tab");
    focused = await page.evaluate(() => {
      const active = document.activeElement;
      if (!(active instanceof HTMLElement) || active === document.body) {
        return false;
      }
      const rect = active.getBoundingClientRect();
      return (
        rect.width > 0 &&
        rect.height > 0 &&
        rect.left >= 0 &&
        rect.top >= 0 &&
        rect.right <= window.innerWidth &&
        rect.bottom <= window.innerHeight
      );
    });
    if (focused) {
      break;
    }
  }
  expect(focused, "Keyboard-only navigation must reach a visible focus target").toBe(true);
}
