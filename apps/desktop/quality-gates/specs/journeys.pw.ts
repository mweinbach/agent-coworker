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
      holdBootstrap: true,
      mode: "dark",
      scenario: "first-launch",
      startupDelayMs: 750,
      width: 1_024,
    },
  });

  test("captures the requested first paint before bootstrap and persists onboarding dismissal", async ({
    quality,
  }, testInfo) => {
    const { page } = quality;
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    const lifecycle = await quality.getLifecycle();
    expect(lifecycle.networkGuardInstalled).toBeLessThan(lifecycle.captureReady);
    expect(lifecycle.captureReady).toBeLessThan(lifecycle.firstWindowCreated);
    expect(lifecycle.firstWindowCreated).toBeLessThan(lifecycle.firstLoadStarted);
    await expect(page).toHaveScreenshot("first-paint-dark-1024.png");

    await quality.releaseBootstrap();
    await expect(page.getByRole("dialog", { name: "Onboarding" })).toBeVisible();
    await expect(page.getByText("Welcome to Cowork")).toBeVisible();
    await assertKeyboardFocusJourney(page);
    await assertNoViewportClipping(page, '[role="dialog"]', "button");
    await assertNoSeriousAxeViolations(page, testInfo, '[role="dialog"]');
    await settleQualityPage(page);
    await expect(page).toHaveScreenshot("first-launch-dark-1024.png");
    await page.getByRole("button", { name: "Not now" }).click();
    await expect(page.getByRole("dialog", { name: "Onboarding" })).toHaveCount(0);
    await expect
      .poll(async () => (await quality.getMainMetrics()).stateSaves)
      .toBeGreaterThanOrEqual(1);
  });
});

test("covers project chat streaming, approval, stop, steer, cancellation, and completion", async ({
  quality,
}, testInfo) => {
  const { page } = quality;
  await expect(page.getByRole("group", { name: "Message composer" })).toBeVisible();

  await quality.emitStreamingActivity();
  await expect(page.getByText("The quality review is in progress.")).toBeVisible();
  await expect(page.getByText("bun run desktop:quality")).toBeVisible();
  await expect(page.getByRole("button", { name: "Stop generating response" })).toBeVisible();

  const composer = page.getByRole("combobox", { name: "Message input" });
  await composer.focus();
  await page.evaluate(() => {
    window.dispatchEvent(
      new KeyboardEvent("keydown", {
        bubbles: true,
        cancelable: true,
        ctrlKey: true,
        key: "k",
      }),
    );
  });
  await expect(page.getByRole("dialog", { name: "Command palette" })).toBeVisible();
  await expect(page.getByText("Stop current turn", { exact: true })).toBeVisible();
  await expect(page.getByPlaceholder("Search chats, workspaces, settings, skills…")).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog", { name: "Command palette" })).toHaveCount(0);
  await expect(composer).toBeFocused();
  await expect.poll(async () => (await quality.getMainMetrics()).turnInterruptRequests).toBe(0);

  await page.keyboard.press("Escape");
  await expect.poll(async () => (await quality.getMainMetrics()).turnInterruptRequests).toBe(0);
  await page.getByRole("button", { name: "Keep blocked" }).click();
  await expect.poll(async () => (await quality.getMainMetrics()).approvalResponses).toBe(1);

  await composer.fill("Prioritize the accessibility findings.");
  await expect(composer).toHaveValue("Prioritize the accessibility findings.");
  await page.getByRole("button", { name: "Steer current response" }).click();
  await expect.poll(async () => (await quality.getMainMetrics()).turnSteerRequests).toBe(1);

  await page.getByRole("button", { name: "Stop generating response" }).click();
  await expect.poll(async () => (await quality.getMainMetrics()).turnInterruptRequests).toBe(1);
  await expect(page.getByRole("button", { name: "Stop generating response" })).toHaveCount(0);

  await quality.emitStreamingActivity();
  await quality.emitCompletion();
  await expect(
    page.getByText("The desktop quality review is complete and ready for release."),
  ).toBeVisible();
  await assertNoSeriousAxeViolations(page, testInfo);
});

test("switches through a draft chat and restores the conversation scroll anchor", async ({
  quality,
}) => {
  const { page } = quality;
  await quality.emitLongTranscript(200, 0);
  const viewport = page.locator('[data-slot="message-scroller-viewport"]');
  await expect(page.getByText("Deterministic transcript run 0 message 200")).toBeAttached();
  await viewport.evaluate((element) => {
    element.scrollTop = 0;
  });

  const composer = page.getByRole("combobox", { name: "Message input" });
  await composer.fill("Keep this controlled draft while switching chats.");
  await page.getByRole("button", { name: /^Controlled fixture draft / }).click();
  await expect(page.getByText("Disconnected", { exact: true })).toBeVisible();
  await expect(composer).toBeEditable();

  await page.getByRole("button", { name: /^Electron release review / }).click();
  await expect(page.getByText("Deterministic transcript run 0 message 200")).toBeAttached();
  await expect
    .poll(async () => await viewport.evaluate((element) => element.scrollTop))
    .toBeGreaterThan(0);
});

test("covers persistent disconnect recovery, tool failures, and quick chat", async ({
  quality,
}) => {
  const { page } = quality;
  await page.evaluate(() => window.__coworkQualityGate?.showDisconnect());
  await expect(page.getByText("Disconnected from this chat. Reconnect to continue.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Reconnect" })).toBeVisible();

  await page.evaluate(() => window.__coworkQualityGate?.showReconnect());
  await expect(page.getByText("Disconnected from this chat. Reconnect to continue.")).toHaveCount(
    0,
  );

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

  const quickComposer = quickWindow.getByRole("combobox", { name: "Message input" });
  await quickComposer.fill("@");
  await expect(quickWindow.getByRole("listbox")).toBeVisible();
  await expect(quickComposer).toBeFocused();
  await quickWindow.keyboard.press("Escape");
  await expect(quickWindow.getByRole("listbox")).toHaveCount(0);
  await expect(quickComposer).toBeFocused();
  expect(quickWindow.isClosed()).toBe(false);

  await quickWindow.keyboard.press("Escape");
  expect(quickWindow.isClosed()).toBe(false);

  const quickWindowClosed = quickWindow.waitForEvent("close");
  await quickWindow.getByRole("button", { name: "Close quick chat" }).focus();
  await quickWindow.keyboard.press("Escape");
  await quickWindowClosed;
});

test("covers file preview, Canvas popout, and resizers with bounded filesystem work", async ({
  quality,
}) => {
  const { electronApp, page } = quality;
  await electronApp.evaluate(() => globalThis.__coworkQualityGateMain?.resetMetrics());

  const messageBarResizer = page.getByRole("separator", {
    name: "Resize maximum message height",
  });
  await expect(messageBarResizer).toBeVisible();
  const initialMessageBarHeight = Number(await messageBarResizer.getAttribute("aria-valuenow"));
  await messageBarResizer.focus();
  await page.keyboard.press("ArrowUp");
  await expect(messageBarResizer).toHaveAttribute(
    "aria-valuenow",
    String(initialMessageBarHeight + 16),
  );

  await page.evaluate(() => window.__coworkQualityGate?.showFilePreview());
  await expect(page.getByRole("button", { name: "Open canvas in window" })).toBeVisible();

  const canvasWindow = await quality.openWindow(async () => {
    await page.getByRole("button", { name: "Open canvas in window" }).click();
  });
  await expect(canvasWindow.getByText("quality-gate-report.md")).toBeVisible();

  await expect(page.getByRole("separator", { name: "Resize sidebar" })).toBeVisible();
  await expect(page.getByRole("separator", { name: "Resize context sidebar" })).toBeVisible();
  const sidebarResizer = page.getByRole("separator", { name: "Resize sidebar" });
  const initialSidebarWidth = Number(await sidebarResizer.getAttribute("aria-valuenow"));
  await sidebarResizer.focus();
  await page.keyboard.press("ArrowRight");
  await expect(sidebarResizer).toHaveAttribute("aria-valuenow", String(initialSidebarWidth + 16));

  const contextResizer = page.getByRole("separator", { name: "Resize context sidebar" });
  const initialContextWidth = Number(await contextResizer.getAttribute("aria-valuenow"));
  await contextResizer.focus();
  await page.keyboard.press("ArrowLeft");
  await expect(contextResizer).toHaveAttribute("aria-valuenow", String(initialContextWidth + 16));

  await expect
    .poll(async () => (await quality.getMainMetrics()).stateSaves)
    .toBeGreaterThanOrEqual(1);
  const metrics = await quality.getMainMetrics();
  expect(metrics.filesystemRequests).toBeLessThanOrEqual(4);
});

test("persists settings through the production desktop state bridge", async ({ quality }) => {
  const { electronApp, page } = quality;
  await electronApp.evaluate(() => globalThis.__coworkQualityGateMain?.resetMetrics());

  await page.evaluate(() => window.__coworkQualityGate?.openSettings("developer"));
  await expect(page.getByRole("switch", { name: "Show hidden files" })).toBeVisible();
  await page.getByRole("switch", { name: "Show hidden files" }).click();
  await expect
    .poll(async () => (await quality.getMainMetrics()).stateSaves)
    .toBeGreaterThanOrEqual(1);
  await page.reload();
  await page.waitForFunction(() => Boolean(window.__coworkQualityGate));
  await page.evaluate(() => window.__coworkQualityGate?.openSettings("developer"));
  await expect(page.getByRole("switch", { name: "Show hidden files" })).toBeChecked();
});

test("covers active task cancellation and supported research fixture states", async ({
  quality,
}, testInfo) => {
  const { page } = quality;
  await page.evaluate(() => window.__coworkQualityGate?.showTaskReview());
  await expect(page.getByText("Ship Electron quality gates")).toBeVisible();
  await expect(page.getByText("Blocked", { exact: true })).toBeVisible();
  await expect(page.getByText("1 blocking", { exact: true })).toBeVisible();
  await page.getByText("Quality gate report").scrollIntoViewIfNeeded();
  await expect(page.getByText("Quality gate report")).toBeVisible();
  await page.getByRole("button", { name: "Cancel task" }).scrollIntoViewIfNeeded();
  await page.getByRole("button", { name: "Cancel task" }).click();
  await expect.poll(async () => (await quality.getMainMetrics()).taskCancellationRequests).toBe(1);
  await expect(page.getByText("Cancelled", { exact: true })).toBeVisible();
  await assertNoSeriousAxeViolations(page, testInfo);

  await page.evaluate(async () => await window.__coworkQualityGate?.showResearch("empty"));
  await expect(page.getByText("Select a run or follow-up")).toBeVisible();

  await page.evaluate(async () => await window.__coworkQualityGate?.showResearch("completed"));
  await expect(page.getByText("Use a real Electron renderer")).toBeVisible();
  await expect(page.getByRole("button", { name: "Ask a follow-up" })).toBeVisible();

  await page.evaluate(async () => await window.__coworkQualityGate?.showResearch("follow-up"));
  await expect(page.getByText("Quality audit follow-up")).toBeVisible();
});

test("aborts an external renderer request in the main process", async ({ quality }) => {
  await quality.electronApp.evaluate(() => globalThis.__coworkQualityGateMain?.resetMetrics());
  const proofUrl = await quality.getExternalNetworkProofUrl();
  const result = await quality.page.evaluate(async (url) => {
    try {
      await fetch(url);
      return "resolved";
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  }, proofUrl);
  expect(result).not.toBe("resolved");
  await expect
    .poll(async () => (await quality.getMainMetrics()).blockedRequests)
    .toEqual([proofUrl]);
});

for (const zoomFactor of [1, 1.25]) {
  test(`keeps mention geometry inside the viewport at ${zoomFactor}x zoom`, async ({ quality }) => {
    const { electronApp, page } = quality;
    await electronApp.evaluate(({ BrowserWindow }, zoom) => {
      BrowserWindow.getAllWindows()[0]?.webContents.setZoomFactor(zoom);
    }, zoomFactor);
    await page.getByRole("combobox", { name: "Message input" }).fill("@");
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
