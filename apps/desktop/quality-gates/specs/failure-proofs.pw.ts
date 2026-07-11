import { promises as fs } from "node:fs";

import type { TestInfo } from "playwright";

import { assertNoSeriousAxeViolations, settleQualityPage } from "../assertions";
import { expect, test } from "../fixtures";
import { assertIndependentMentionGeometry } from "../mentionGeometry";

async function attachIntentionalFailureMarker(
  testInfo: TestInfo,
  proof: "axe" | "mention-geometry" | "renderer" | "visual",
): Promise<void> {
  const markerPath = testInfo.outputPath("intentional-failure-marker.json");
  await fs.writeFile(
    markerPath,
    `${JSON.stringify({
      marker: `intentional-quality-gate-${proof}-failure`,
      proof,
    })}\n`,
    "utf8",
  );
  await testInfo.attach("intentional-failure-marker.json", {
    path: markerPath,
  });
}

test.describe("renderer failure proof", () => {
  test.skip(process.env.COWORK_QUALITY_PROOF !== "renderer", "opt-in failure proof");

  test("proof:renderer captures trace, log, video, and screenshot", async ({
    quality,
  }, testInfo) => {
    await attachIntentionalFailureMarker(testInfo, "renderer");
    await quality.page.evaluate(() => {
      setTimeout(() => {
        throw new Error("intentional-quality-gate-renderer-failure");
      }, 0);
    });
    await quality.page.waitForTimeout(100);
  });
});

test.describe("visual failure proof", () => {
  test.skip(process.env.COWORK_QUALITY_PROOF !== "visual", "opt-in failure proof");

  test("proof:visual rejects an intentional unapproved pixel change", async ({
    quality,
  }, testInfo) => {
    await attachIntentionalFailureMarker(testInfo, "visual");
    await quality.page.evaluate(() => {
      const overlay = document.createElement("div");
      overlay.setAttribute("data-quality-gate-pixel-change", "true");
      overlay.style.cssText =
        "position:fixed;inset:0;background:#ff00ff;z-index:2147483647;pointer-events:none";
      document.body.append(overlay);
    });
    await settleQualityPage(quality.page);
    await expect(quality.page).toHaveScreenshot("shipping-chat-1240-light.png");
  });
});

test.describe("mention geometry failure proof", () => {
  test.skip(process.env.COWORK_QUALITY_PROOF !== "mention-geometry", "opt-in failure proof");

  test("proof:mention-geometry rejects intentional highlight drift", async ({
    quality,
  }, testInfo) => {
    await attachIntentionalFailureMarker(testInfo, "mention-geometry");
    const composer = quality.page.getByRole("combobox", { name: "Message input" });
    await composer.fill("Independent geometry keeps @geometry-audit aligned while choosing @g");
    await composer.focus();
    await expect(quality.page.getByRole("listbox", { name: "Mentions" })).toBeVisible();
    await composer.evaluate((textarea) => {
      const highlights = textarea.parentElement?.querySelectorAll<HTMLElement>(
        '[data-slot="composer-highlight-overlay"] [data-mention-start]',
      );
      const highlight = highlights?.item((highlights?.length ?? 1) - 1);
      if (!highlight) throw new Error("Intentional geometry drift target is missing");
      highlight.style.position = "relative";
      highlight.style.left = "4px";
    });
    await assertIndependentMentionGeometry(quality.page, testInfo, {
      attachmentName: "mention-geometry-intentional-drift",
    });
  });
});

test.describe("Axe failure proof", () => {
  test.skip(process.env.COWORK_QUALITY_PROOF !== "axe", "opt-in failure proof");

  test("proof:axe rejects an intentional serious violation", async ({ quality }, testInfo) => {
    await attachIntentionalFailureMarker(testInfo, "axe");
    await quality.page.evaluate(() => {
      const button = document.createElement("button");
      button.style.cssText =
        "position:fixed;inset:20px auto auto 20px;width:44px;height:44px;background:#777;color:#777;z-index:99999";
      document.body.append(button);
    });
    await assertNoSeriousAxeViolations(quality.page, testInfo);
  });
});
