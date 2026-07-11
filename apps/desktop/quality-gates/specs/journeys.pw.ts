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
  const stopButton = page.getByRole("button", { name: "Stop current response" });
  await expect(stopButton).toBeVisible();
  await expect(stopButton).toBeEnabled();
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
  await page.getByRole("button", { name: "Send guidance to current response" }).click();
  await expect.poll(async () => (await quality.getMainMetrics()).turnSteerRequests).toBe(1);
  await expect(
    page.getByText("Guidance accepted. Restore it to edit and send as a follow-up."),
  ).toBeVisible();
  await expect(stopButton).toBeVisible();
  await expect(stopButton).toBeEnabled();
  await page.getByRole("button", { name: "Edit as follow-up" }).click();
  await expect(composer).toHaveValue("Prioritize the accessibility findings.");
  await expect(stopButton).toBeEnabled();

  await stopButton.click();
  await expect.poll(async () => (await quality.getMainMetrics()).turnInterruptRequests).toBe(1);
  await expect(stopButton).toHaveCount(0);

  await quality.emitStreamingActivity();
  await quality.emitCompletion();
  await expect(
    page.getByText("The desktop quality review is complete and ready for release."),
  ).toBeVisible();
  await assertNoSeriousAxeViolations(page, testInfo);
});

test("resolves one queued interaction without disturbing its siblings", async ({ quality }) => {
  const { page } = quality;
  await quality.emitInteractionQueue();

  const themeQuestion = page.locator('[data-interaction-id="quality-ask-theme"]');
  const docsApproval = page.locator('[data-interaction-id="quality-approval-docs"]');
  const reviewerQuestion = page.locator('[data-interaction-id="quality-ask-reviewer"]');
  await expect(themeQuestion).toBeVisible();
  await expect(docsApproval).toBeVisible();
  await expect(reviewerQuestion).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Open next chat needing input, 3 pending" }),
  ).toBeVisible();

  await themeQuestion.getByRole("button", { name: "Light", exact: true }).click();
  await expect.poll(async () => (await quality.getMainMetrics()).approvalResponses).toBe(1);
  await expect(themeQuestion).toHaveCount(0);
  await expect(docsApproval).toBeVisible();
  await expect(reviewerQuestion).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Open next chat needing input, 2 pending" }),
  ).toBeVisible();
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

for (const zoomFactor of [1, 1.25, 2]) {
  test(`keeps mention text, highlight, scroll, and caret picker aligned at ${zoomFactor}x zoom`, async ({
    quality,
  }, testInfo) => {
    const { electronApp, page } = quality;
    await electronApp.evaluate(({ BrowserWindow }, zoom) => {
      BrowserWindow.getAllWindows()[0]?.webContents.setZoomFactor(zoom);
    }, zoomFactor);
    const composer = page.getByRole("combobox", { name: "Message input" });
    await composer.evaluate(async (textarea) => {
      textarea.style.fontFamily = "monospace";
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      textarea.style.fontFamily = "serif";
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      );
    });
    const text = [
      ...Array.from(
        { length: 18 },
        (_, index) =>
          `Wrapped geometry line ${index + 1} keeps @geometry-audit aligned through the composer.`,
      ),
      `${"Long wrapping text ".repeat(8)}use @geometry-audit then @g`,
    ].join("\n");
    await composer.fill(text);
    await composer.focus();

    const menu = page.getByRole("listbox", { name: "Mentions" });
    await expect(menu).toBeVisible();
    await expect(page.getByRole("option", { name: /@geometry-audit/ })).toBeVisible();
    const geometry = await composer.evaluate((textarea) => {
      const overlay = textarea.parentElement?.querySelector<HTMLDivElement>(
        '[data-slot="composer-highlight-overlay"]',
      );
      const menuElement = document.querySelector<HTMLElement>(
        '[data-slot="composer-mention-menu"]',
      );
      const highlights = overlay?.querySelectorAll<HTMLElement>("[data-mention-start]");
      const highlight = highlights?.item((highlights?.length ?? 1) - 1) ?? null;
      if (!overlay || !menuElement || !highlight) {
        throw new Error("Mention geometry surface is incomplete");
      }
      const textRect = textarea.getBoundingClientRect();
      const overlayRect = overlay.getBoundingClientRect();
      const menuRect = menuElement.getBoundingClientRect();
      const textStyle = getComputedStyle(textarea);
      const overlayStyle = getComputedStyle(overlay);
      const highlightStyle = getComputedStyle(highlight);
      const metricProperties = [
        "font-family",
        "font-size",
        "font-style",
        "font-weight",
        "letter-spacing",
        "line-height",
        "overflow-wrap",
        "padding-bottom",
        "padding-left",
        "padding-right",
        "padding-top",
        "tab-size",
        "white-space",
        "word-break",
        "word-spacing",
      ];
      const metricMismatches = metricProperties.filter(
        (property) =>
          textStyle.getPropertyValue(property) !== overlayStyle.getPropertyValue(property),
      );

      const walker = document.createTreeWalker(overlay, NodeFilter.SHOW_TEXT);
      let consumed = 0;
      let caretRect: DOMRect | null = null;
      let node = walker.nextNode();
      while (node) {
        const length = node.textContent?.length ?? 0;
        if (textarea.value.length <= consumed + length) {
          const range = document.createRange();
          range.setStart(node, textarea.value.length - consumed);
          range.collapse(true);
          caretRect = range.getClientRects()[0] ?? range.getBoundingClientRect();
          break;
        }
        consumed += length;
        node = walker.nextNode();
      }
      if (!caretRect) throw new Error("Unable to measure mirrored caret");

      const placement = menuElement.dataset.placement;
      const pickerGap =
        placement === "above" ? caretRect.top - menuRect.bottom : menuRect.top - caretRect.bottom;
      return {
        activeDescendant: textarea.getAttribute("aria-activedescendant"),
        caretInsideMenuWidth: caretRect.left >= menuRect.left && caretRect.left <= menuRect.right,
        highlightBackground: highlightStyle.backgroundColor,
        highlightBorderWidth: highlightStyle.borderWidth,
        highlightFontWeight: highlightStyle.fontWeight,
        highlightMargin: highlightStyle.margin,
        highlightPadding: highlightStyle.padding,
        insideViewport:
          menuRect.left >= 0 &&
          menuRect.top >= 0 &&
          menuRect.right <= window.innerWidth &&
          menuRect.bottom <= window.innerHeight,
        metricMismatches,
        overlayHeightDelta: Math.abs(overlayRect.height - textarea.clientHeight),
        overlayLeftDelta: Math.abs(overlayRect.left - (textRect.left + textarea.clientLeft)),
        overlayScrollTop: overlay.scrollTop,
        overlayTopDelta: Math.abs(overlayRect.top - (textRect.top + textarea.clientTop)),
        overlayWidthDelta: Math.abs(overlayRect.width - textarea.clientWidth),
        pickerGap,
        scrollTop: textarea.scrollTop,
        tolerance: 1 / window.devicePixelRatio + 0.01,
      };
    });

    expect(geometry.metricMismatches).toEqual([]);
    expect(geometry.overlayLeftDelta).toBeLessThanOrEqual(geometry.tolerance);
    expect(geometry.overlayTopDelta).toBeLessThanOrEqual(geometry.tolerance);
    expect(geometry.overlayWidthDelta).toBeLessThanOrEqual(geometry.tolerance);
    expect(geometry.overlayHeightDelta).toBeLessThanOrEqual(geometry.tolerance);
    expect(geometry.overlayScrollTop).toBe(geometry.scrollTop);
    expect(geometry.scrollTop).toBeGreaterThan(0);
    expect(geometry.highlightPadding).toBe("0px");
    expect(geometry.highlightMargin).toBe("0px");
    expect(geometry.highlightBorderWidth).toBe("0px");
    expect(geometry.highlightFontWeight).toBe("400");
    expect(geometry.highlightBackground).not.toBe("rgba(0, 0, 0, 0)");
    expect(geometry.activeDescendant).toContain("-skill-geometry-audit");
    expect(geometry.insideViewport).toBe(true);
    expect(geometry.caretInsideMenuWidth).toBe(true);
    expect(geometry.pickerGap).toBeGreaterThanOrEqual(0);
    expect(geometry.pickerGap).toBeLessThanOrEqual(8);
    if (zoomFactor === 1) {
      await assertNoSeriousAxeViolations(page, testInfo);
    }

    await composer.evaluate((textarea) => {
      textarea.wrap = "off";
      textarea.style.setProperty("field-sizing", "fixed");
      textarea.style.flex = "none";
      textarea.style.maxWidth = "320px";
      textarea.style.overflowWrap = "normal";
      textarea.style.whiteSpace = "pre";
      textarea.style.width = "320px";
    });
    await composer.fill(`${"horizontal-geometry-".repeat(24)} @geometry-audit then @g`);
    await composer.evaluate((textarea) => {
      textarea.scrollLeft = Math.max(1, textarea.scrollWidth - textarea.clientWidth - 20);
      textarea.dispatchEvent(new Event("scroll"));
    });
    const horizontalScroll = await composer.evaluate((textarea) => {
      const overlay = textarea.parentElement?.querySelector<HTMLDivElement>(
        '[data-slot="composer-highlight-overlay"]',
      );
      return {
        overlayScrollLeft: overlay?.scrollLeft ?? -1,
        scrollLeft: textarea.scrollLeft,
      };
    });
    expect(horizontalScroll.scrollLeft).toBeGreaterThan(0);
    expect(horizontalScroll.overlayScrollLeft).toBe(horizontalScroll.scrollLeft);

    const screenshot = await page.screenshot();
    await testInfo.attach(`mention-geometry-${zoomFactor}x`, {
      body: screenshot,
      contentType: "image/png",
    });
    const finalMenuRect = await menu.evaluate((element) => {
      const rect = element.getBoundingClientRect();
      return (
        rect.left >= 0 &&
        rect.top >= 0 &&
        rect.right <= window.innerWidth &&
        rect.bottom <= window.innerHeight
      );
    });
    expect(finalMenuRect).toBe(true);
  });
}
