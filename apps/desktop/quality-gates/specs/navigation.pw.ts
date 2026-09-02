import { expect, test } from "../fixtures";

test.use({
  qualityOptions: {
    height: 820,
    width: 1240,
    mode: "light",
    scenario: "product",
    startupDelayMs: 0,
    recordVideo: false,
  },
});

test("route history preserves the live chat, draft, and transport", async ({ quality }) => {
  const { page } = quality;
  const composer = page.getByRole("combobox", { name: "Message input" });
  await composer.fill("Keep this draft across routes.");
  await quality.emitStreamingActivity();
  await expect(page.getByText("The quality review is in progress.")).toBeVisible();
  const originalIds = await page.evaluate(() => window.__coworkQualityGate?.getFeedItemIds());
  const originalSearch = await page.evaluate(() => window.location.search);
  const before = await quality.getMainMetrics();

  await page.evaluate(() => window.__coworkQualityGate?.openSettings("updates"));
  await expect(page.locator('[data-settings-page="updates"]')).toBeVisible();
  await expect(page).toHaveURL(/#\/settings\/updates$/);
  await page.getByRole("button", { name: "Usage", exact: true }).click();
  await expect(page.locator('[data-settings-page="usage"]')).toBeVisible();
  await page.evaluate(() => window.history.back());
  await expect(page.locator('[data-settings-page="updates"]')).toBeVisible();
  await page.evaluate(() => window.history.forward());
  await expect(page.locator('[data-settings-page="usage"]')).toBeVisible();
  await page.getByRole("button", { name: "Back", exact: true }).click();
  await expect(page).toHaveURL(/#\/chat$/);
  await expect(composer).toHaveValue("Keep this draft across routes.");
  await expect(page.getByText("The quality review is in progress.")).toBeVisible();
  expect(await page.evaluate(() => window.__coworkQualityGate?.getFeedItemIds())).toEqual(
    originalIds,
  );
  expect(await page.evaluate(() => window.location.search)).toBe(originalSearch);
  const after = await quality.getMainMetrics();
  expect(after.socketConnections).toBe(before.socketConnections);
  expect(after.turnInterruptRequests).toBe(before.turnInterruptRequests);
});

test("settings reload and task return retain their route context", async ({ quality }) => {
  const { page } = quality;
  await page.evaluate(() => window.__coworkQualityGate?.openSettings("updates"));
  await expect(page.locator('[data-settings-page="updates"]')).toBeVisible();
  await page.reload();
  await expect(page.locator('[data-settings-page="updates"]')).toBeVisible();
  await expect(page).toHaveURL(/#\/settings\/updates$/);

  await page.evaluate(() => window.__coworkQualityGate?.showTaskReview());
  await expect(page).toHaveURL(/#\/task$/);
  await page.evaluate(() => window.__coworkQualityGate?.openSettings("updates"));
  await expect(page.locator('[data-settings-page="updates"]')).toBeVisible();
  await page.getByRole("button", { name: "Usage", exact: true }).click();
  await expect(page.locator('[data-settings-page="usage"]')).toBeVisible();
  await page.getByRole("button", { name: "Back", exact: true }).click();
  await expect(page).toHaveURL(/#\/task$/);
});

test("direct locations canonicalize aliases and reject unavailable screens", async ({
  quality,
}) => {
  const { page } = quality;
  await page.evaluate(() => {
    window.location.hash = "/settings/developer";
  });
  await expect(page).toHaveURL(/#\/settings\/diagnostics$/);
  await expect(page.locator('[data-settings-page="diagnostics"]')).toBeVisible();
  await page.evaluate(() => {
    window.location.hash = "/settings/unknown-page";
  });
  await expect(page).toHaveURL(/#\/settings\/models$/);
  await expect(page.locator('[data-settings-page="models"]')).toBeVisible();
  await page.evaluate(() => window.__coworkQualityGate?.openSettings("experiments"));
  const tasksToggle = page.getByRole("switch", { name: "Tasks", exact: true });
  await tasksToggle.uncheck();
  await expect(tasksToggle).not.toBeChecked();
  await page.evaluate(() => {
    window.location.hash = "/task";
  });
  await expect(page).toHaveURL(/#\/chat$/);
  await expect(page.getByRole("combobox", { name: "Message input" })).toBeVisible();
});

test("keyboard skip control focuses content without changing the task route", async ({
  quality,
}) => {
  const { page } = quality;
  await page.evaluate(() => window.__coworkQualityGate?.showTaskReview());
  await expect(page.getByRole("main", { name: "Task", exact: true })).toBeVisible();
  const historyLength = await page.evaluate(() => window.history.length);
  const skipControl = page.getByRole("button", { name: "Skip to content" });
  await skipControl.focus();
  await skipControl.press("Enter");
  await expect(page.getByRole("main", { name: "Task", exact: true })).toBeFocused();
  await expect(page).toHaveURL(/#\/task$/);
  expect(await page.evaluate(() => window.history.length)).toBe(historyLength);
});
