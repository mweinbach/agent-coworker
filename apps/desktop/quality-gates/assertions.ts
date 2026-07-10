import { promises as fs } from "node:fs";

import { AxeBuilder } from "@axe-core/playwright";
import { expect } from "@playwright/test";
import type { Page, TestInfo } from "playwright";

import axeBaseline from "./axe-baseline.json" with { type: "json" };

const knownColorContrastTargets = new Set(axeBaseline.colorContrast.selectors);

function isKnownColorContrastTarget(target: Array<string | string[]>): boolean {
  return target.length === 1 && typeof target[0] === "string"
    ? knownColorContrastTargets.has(target[0])
    : false;
}

export async function settleQualityPage(page: Page): Promise<void> {
  await page.evaluate(async () => {
    await document.fonts.ready;
    await new Promise<void>((resolve) => setTimeout(resolve, 350));
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
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
    .exclude(".sidebar-symbol-slot");
  if (include) {
    builder = builder.include(include);
  }
  const results = await builder.analyze();
  const seriousViolations = results.violations.flatMap((violation) => {
    if (violation.impact !== "critical" && violation.impact !== "serious") {
      return [];
    }
    if (violation.id !== "color-contrast") {
      return [violation];
    }
    const unexpectedNodes = violation.nodes.filter(
      (node) => !isKnownColorContrastTarget(node.target),
    );
    return unexpectedNodes.length > 0 ? [{ ...violation, nodes: unexpectedNodes }] : [];
  });
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

export async function assertNoViewportClipping(
  page: Page,
  include?: string,
  criticalControlSelector = '[data-quality-critical-control="true"]',
): Promise<void> {
  const result = await page.evaluate(
    ({ criticalSelector, includeSelector }) => {
      const root = document.documentElement;
      const clippingTolerance = 1.5;
      const viewport = { width: window.innerWidth, height: window.innerHeight };
      const scope = includeSelector ? document.querySelector(includeSelector) : document;
      if (!scope) {
        throw new Error(`Clipping assertion scope was not found: ${includeSelector}`);
      }
      const clippedControls: Array<{
        clippingAncestor: {
          bottom: number;
          label: string;
          left: number;
          overflowX: string;
          overflowY: string;
          right: number;
          top: number;
        } | null;
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
      const controls = scope.querySelectorAll<HTMLElement>(
        'button, input, textarea, select, [role="button"], [role="checkbox"], [role="switch"]',
      );
      let recoverableScrollableClipping = 0;
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
        const critical = control.matches(criticalSelector);
        const entirelyOutsideViewport =
          rect.bottom <= 0 ||
          rect.top >= viewport.height ||
          rect.right <= 0 ||
          rect.left >= viewport.width;
        if (entirelyOutsideViewport && !critical) {
          continue;
        }
        let clippingAncestor = control.parentElement;
        let clippingAncestorDetails: (typeof clippedControls)[number]["clippingAncestor"] = null;
        let clippedByAncestor = false;
        let recoverablyClippedX = false;
        let recoverablyClippedY = false;
        while (clippingAncestor) {
          const ancestorStyle = getComputedStyle(clippingAncestor);
          const clipsX = ["auto", "clip", "hidden", "scroll"].includes(ancestorStyle.overflowX);
          const clipsY = ["auto", "clip", "hidden", "scroll"].includes(ancestorStyle.overflowY);
          if (clipsX || clipsY) {
            const ancestorRect = clippingAncestor.getBoundingClientRect();
            const clippedX =
              clipsX &&
              (rect.left < ancestorRect.left - clippingTolerance ||
                rect.right > ancestorRect.right + clippingTolerance);
            const clippedY =
              clipsY &&
              (rect.top < ancestorRect.top - clippingTolerance ||
                rect.bottom > ancestorRect.bottom + clippingTolerance);
            const canScrollX =
              clippedX &&
              ["auto", "scroll"].includes(ancestorStyle.overflowX) &&
              clippingAncestor.scrollWidth > clippingAncestor.clientWidth + clippingTolerance &&
              rect.width <= clippingAncestor.clientWidth + clippingTolerance;
            const canScrollY =
              clippedY &&
              ["auto", "scroll"].includes(ancestorStyle.overflowY) &&
              clippingAncestor.scrollHeight > clippingAncestor.clientHeight + clippingTolerance &&
              rect.height <= clippingAncestor.clientHeight + clippingTolerance;
            const canRecoverX =
              canScrollX ||
              (recoverablyClippedX &&
                rect.width <= clippingAncestor.clientWidth + clippingTolerance);
            const canRecoverY =
              canScrollY ||
              (recoverablyClippedY &&
                rect.height <= clippingAncestor.clientHeight + clippingTolerance);
            recoverablyClippedX ||= canRecoverX;
            recoverablyClippedY ||= canRecoverY;
            if (
              (critical && (clippedX || clippedY)) ||
              (clippedX && !canRecoverX) ||
              (clippedY && !canRecoverY)
            ) {
              clippedByAncestor = true;
              clippingAncestorDetails = {
                bottom: ancestorRect.bottom,
                label: `${clippingAncestor.tagName}.${clippingAncestor.className}`,
                left: ancestorRect.left,
                overflowX: ancestorStyle.overflowX,
                overflowY: ancestorStyle.overflowY,
                right: ancestorRect.right,
                top: ancestorRect.top,
              };
              break;
            }
          }
          clippingAncestor = clippingAncestor.parentElement;
        }
        if (recoverablyClippedX || recoverablyClippedY) {
          recoverableScrollableClipping += 1;
        }
        const clippedByViewport =
          rect.left < -clippingTolerance ||
          rect.right > viewport.width + clippingTolerance ||
          rect.top < -clippingTolerance ||
          rect.bottom > viewport.height + clippingTolerance;
        if (
          clippedByAncestor ||
          (critical && clippedByViewport) ||
          (!recoverablyClippedX &&
            (rect.left < -clippingTolerance || rect.right > viewport.width + clippingTolerance)) ||
          (!recoverablyClippedY &&
            (rect.top < -clippingTolerance || rect.bottom > viewport.height + clippingTolerance))
        ) {
          clippedControls.push({
            clippingAncestor: clippingAncestorDetails,
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
        recoverableScrollableClipping,
        viewport,
      };
    },
    { criticalSelector: criticalControlSelector, includeSelector: include },
  );

  expect(
    result.documentScrollWidth,
    `Document is ${result.documentScrollWidth}px wide in a ${result.viewport.width}px viewport`,
  ).toBeLessThanOrEqual(result.viewport.width);
  expect(
    result.clippedControls,
    "Visible interactive controls must remain inside the viewport and every clipping ancestor",
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
  const onboardingVisible = await page
    .getByRole("dialog", { name: "Onboarding" })
    .isVisible()
    .catch(() => false);
  if (onboardingVisible) {
    const getStarted = page.getByRole("button", { name: "Get started", exact: true });
    await getStarted.focus();
    const focusSequence = ["Get started"];
    for (let index = 0; index < 3; index += 1) {
      await page.keyboard.press("Tab");
      focusSequence.push(
        await page.evaluate(() => {
          const active = document.activeElement;
          return active?.getAttribute("aria-label") || active?.textContent?.trim() || "no focus";
        }),
      );
    }
    expect(focusSequence, "Onboarding focus must visit both actions and wrap").toEqual([
      "Get started",
      "Not now",
      "Close onboarding",
      "Get started",
    ]);
    return;
  }

  const expectedTargets = [
    page.getByRole("link", { name: "Skip to content", exact: true }),
    page.getByRole("button", { name: "Hide sidebar", exact: true }),
    page.getByRole("button", { name: "Open thread details", exact: true }),
    page.getByRole("button", { name: "Open quick chat", exact: true }),
  ];
  await page.evaluate(() => {
    document.body.tabIndex = -1;
    document.body.focus();
  });
  for (const target of expectedTargets) {
    await page.keyboard.press("Tab");
    await expect(target).toBeFocused();
  }
  await page.evaluate(() => {
    document.body.removeAttribute("tabindex");
  });
}
