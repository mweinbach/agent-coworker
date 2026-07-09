import {
  assertKeyboardFocusJourney,
  assertNoSeriousAxeViolations,
  assertNoViewportClipping,
  settleQualityPage,
} from "../assertions";
import { expect, test } from "../fixtures";

test.describe("first launch", () => {
  test.use({
    qualityOptions: {
      height: 820,
      mode: "dark",
      scenario: "first-launch",
      startupDelayMs: 750,
      width: 1_024,
    },
  });

  test("paints the requested theme before slow bootstrap and completes onboarding accessibly", async ({
    quality,
  }, testInfo) => {
    const { page } = quality;
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    await expect(page.getByRole("dialog", { name: "Onboarding" })).toBeVisible();
    await expect(page.getByText("Welcome to Cowork")).toBeVisible();
    await assertKeyboardFocusJourney(page);
    await assertNoViewportClipping(page);
    await assertNoSeriousAxeViolations(page, testInfo, '[role="dialog"]');
    await settleQualityPage(page);
    await expect(page).toHaveScreenshot("first-launch-dark-1024.png");
  });
});

test("covers project chat streaming, approval, stop, steer, cancellation, and completion", async ({
  quality,
}, testInfo) => {
  const { page } = quality;
  await expect(page.getByRole("group", { name: "Message composer" })).toBeVisible();

  await page.evaluate(() => window.__coworkQualityGate?.emitStreamingActivity());
  await expect(page.getByText("The quality review is in progress.")).toBeVisible();
  await expect(page.getByText("bun run desktop:quality")).toBeVisible();
  await expect(page.getByRole("button", { name: "Stop generating response" })).toBeVisible();

  const composer = page.getByRole("textbox");
  await composer.fill("Prioritize the accessibility findings.");
  await expect(composer).toHaveValue("Prioritize the accessibility findings.");
  await expect(page.getByRole("button", { name: "Steer current response" })).toBeVisible();

  await page.evaluate(() => window.__coworkQualityGate?.emitCancellation());
  await expect(page.getByText("Response stopped by the user.")).toBeVisible();

  await page.evaluate(() => {
    window.__coworkQualityGate?.emitStreamingActivity();
    window.__coworkQualityGate?.emitCompletion();
  });
  await expect(
    page.getByText("The desktop quality review is complete and ready for release."),
  ).toBeVisible();
  await assertNoSeriousAxeViolations(page, testInfo);
});

test("switches through a draft chat and restores the conversation scroll anchor", async ({
  quality,
}) => {
  const { page } = quality;
  await page.evaluate(() => window.__coworkQualityGate?.loadLongTranscript(200));
  const viewport = page.locator('[data-slot="message-scroller-viewport"]');
  await expect(page.getByText("Deterministic transcript message 200")).toBeAttached();
  await viewport.evaluate((element) => {
    element.scrollTop = 0;
  });

  const composer = page.getByRole("textbox");
  await composer.fill("Keep this controlled draft while switching chats.");
  await page.getByRole("button", { name: /^Responsive layout draft / }).click();
  await expect(page.getByText("Disconnected", { exact: true })).toBeVisible();
  await expect(composer).toBeEditable();

  await page.getByRole("button", { name: /^Electron release review / }).click();
  await expect(page.getByText("Deterministic transcript message 200")).toBeAttached();
  await expect
    .poll(async () => await viewport.evaluate((element) => element.scrollTop))
    .toBeGreaterThan(0);
});

test("covers persistent disconnect recovery, tool failures, and quick chat", async ({
  quality,
}) => {
  const { page } = quality;
  await page.evaluate(() => window.__coworkQualityGate?.showDisconnect());
  await expect(page.getByText("Disconnected", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Reconnect" })).toBeVisible();

  await page.evaluate(() => window.__coworkQualityGate?.showReconnect());
  await expect(page.getByText("Disconnected", { exact: true })).toHaveCount(0);

  await page.evaluate(() => window.__coworkQualityGate?.showToolFailureHistory());
  await page.getByRole("button", { name: /Couldn't finish/ }).click();
  await expect(page.getByText("Finished with an issue")).toBeVisible();
  await expect(
    page.getByText("The failed command remains visible in transcript history."),
  ).toBeVisible();
  await expect(page.getByText("Attached quality-gate-report.md")).toBeVisible();

  const quickWindow = await quality.openWindow(async () => {
    await page.getByRole("button", { name: "Open quick chat" }).click();
  });
  await expect(quickWindow.getByRole("button", { name: "Open full app" })).toBeVisible();
  await expect(quickWindow.getByRole("group", { name: "Message composer" })).toBeVisible();
});

test("covers file preview, Canvas popout, and resizers with bounded filesystem work", async ({
  quality,
}) => {
  const { electronApp, page } = quality;
  await electronApp.evaluate(() => globalThis.__coworkQualityGateMain?.resetMetrics());

  await page.evaluate(() => window.__coworkQualityGate?.showFilePreview());
  await expect(page.getByRole("button", { name: "Open canvas in window" })).toBeVisible();

  const canvasWindow = await quality.openWindow(async () => {
    await page.getByRole("button", { name: "Open canvas in window" }).click();
  });
  await expect(canvasWindow.getByText("quality-gate-report.md")).toBeVisible();

  await expect(page.getByRole("separator", { name: "Resize sidebar" })).toBeVisible();
  await expect(page.getByRole("separator", { name: "Resize context sidebar" })).toBeVisible();
  await expect(
    page.getByRole("separator", { name: "Resize minimum message bar height" }),
  ).toBeVisible();
  const metrics = await quality.getMainMetrics();
  expect(metrics.filesystemRequests).toBeLessThanOrEqual(4);
});

test("persists settings and covers full-payload and forget-device confirmations", async ({
  quality,
}) => {
  const { electronApp, page } = quality;
  await electronApp.evaluate(() => globalThis.__coworkQualityGateMain?.resetMetrics());

  await page.evaluate(() => window.__coworkQualityGate?.openSettings("developer"));
  await expect(page.getByRole("switch", { name: "Show hidden files" })).toBeVisible();
  await page.getByRole("switch", { name: "Show hidden files" }).click();

  await page.evaluate(() => window.__coworkQualityGate?.openSettings("privacyTelemetry"));
  await page.getByRole("switch", { name: "AI trace diagnostics" }).click();
  await page.getByRole("switch", { name: "Include prompts and responses in AI traces" }).click();

  await page.evaluate(() => window.__coworkQualityGate?.openSettings("remoteAccess"));
  await expect(page.getByRole("button", { name: "Forget Quality Phone" })).toBeVisible();
  await page.getByRole("button", { name: "Forget Quality Phone" }).click();

  await expect
    .poll(async () => {
      const metrics = await quality.getMainMetrics();
      return {
        confirmationRequests: metrics.confirmationRequests,
        mobileForgetRequests: metrics.mobileForgetRequests,
        stateSaves: metrics.stateSaves,
      };
    })
    .toMatchObject({
      confirmationRequests: 2,
      mobileForgetRequests: 1,
    });
});

test("covers active task review and the complete research lifecycle", async ({
  quality,
}, testInfo) => {
  const { electronApp, page } = quality;
  await page.evaluate(() => window.__coworkQualityGate?.showTaskReview());
  await expect(page.getByText("Ship Electron quality gates")).toBeVisible();
  await expect(page.getByText("Blocked", { exact: true })).toBeVisible();
  await expect(page.getByText("1 blocking", { exact: true })).toBeVisible();
  await page.getByText("Quality gate report").scrollIntoViewIfNeeded();
  await expect(page.getByText("Quality gate report")).toBeVisible();
  await page.getByRole("button", { name: "Cancel task" }).scrollIntoViewIfNeeded();
  await expect(page.getByRole("button", { name: "Cancel task" })).toBeVisible();
  await assertNoSeriousAxeViolations(page, testInfo);

  await page.evaluate(async () => await window.__coworkQualityGate?.showResearch("loading"));
  await expect(page.getByRole("status").getByText("Loading research…")).toBeVisible();

  await page.evaluate(async () => await window.__coworkQualityGate?.showResearch("empty"));
  await expect(page.getByText("Select a run or follow-up")).toBeVisible();

  await page.evaluate(async () => await window.__coworkQualityGate?.showResearch("completed"));
  await expect(page.getByText("Use a real Electron renderer")).toBeVisible();
  await expect(page.getByRole("button", { name: "Ask a follow-up" })).toBeVisible();

  await page.evaluate(async () => await window.__coworkQualityGate?.showResearch("follow-up"));
  await expect(page.getByText("Quality audit follow-up")).toBeVisible();

  await page.evaluate(async () => await window.__coworkQualityGate?.showResearch("completed"));
  const researchOption = page.getByRole("option", { name: /Desktop quality research/ });
  await electronApp.evaluate(() =>
    globalThis.__coworkQualityGateMain?.setNextContextMenuResult("archive"),
  );
  await researchOption.click({ button: "right" });
  await expect(researchOption).toContainText("Archived");

  await electronApp.evaluate(() =>
    globalThis.__coworkQualityGateMain?.setNextContextMenuResult("restore"),
  );
  await researchOption.click({ button: "right" });
  await expect(researchOption).not.toContainText("Archived");

  await electronApp.evaluate(() =>
    globalThis.__coworkQualityGateMain?.setNextContextMenuResult("delete"),
  );
  await researchOption.click({ button: "right" });
  await expect(researchOption).toHaveCount(0);
  await expect(
    page.getByPlaceholder(
      "Investigate a market, compare vendors, summarize a benchmark run, or draft a cited brief.",
    ),
  ).toBeVisible();
});

for (const zoomFactor of [1, 1.25]) {
  test(`keeps mention geometry inside the viewport at ${zoomFactor}x zoom`, async ({ quality }) => {
    const { electronApp, page } = quality;
    await electronApp.evaluate(({ BrowserWindow }, zoom) => {
      BrowserWindow.getAllWindows()[0]?.webContents.setZoomFactor(zoom);
    }, zoomFactor);
    await page.getByRole("textbox").fill("@");
    const menu = page.getByRole("listbox");
    await expect(menu).toBeVisible();
    const insideViewport = await menu.evaluate((element) => {
      const rect = element.getBoundingClientRect();
      return (
        rect.left >= 0 &&
        rect.top >= 0 &&
        rect.right <= window.innerWidth &&
        rect.bottom <= window.innerHeight
      );
    });
    expect(insideViewport).toBe(true);
  });
}
