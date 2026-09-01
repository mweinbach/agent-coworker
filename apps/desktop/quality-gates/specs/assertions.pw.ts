import {
  assertNoSeriousAxeViolations,
  assertNoViewportClipping,
  assertUsablePrimaryContentWidth,
  settleQualityPage,
} from "../assertions";
import { expect, test } from "../fixtures";

async function captureExpectedFailure(action: () => Promise<void>): Promise<Error> {
  try {
    await action();
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error));
  }
  throw new Error("Expected the quality assertion to fail");
}

test.describe("compact primary content width", () => {
  test.use({
    qualityOptions: {
      height: 820,
      mode: "light",
      scenario: "product",
      startupDelayMs: 0,
      width: 800,
    },
  });

  test("allows the inline context rail but rejects a primary pane below 320px", async ({
    quality,
  }) => {
    const { page } = quality;
    await expect(page.getByRole("region", { name: "Context", exact: true })).toBeVisible();
    await assertUsablePrimaryContentWidth(page);
    await page.locator('[data-slot="primary-content-pane"]').evaluate((element) => {
      (element as HTMLElement).style.flex = "0 0 319px";
    });
    const error = await captureExpectedFailure(() => assertUsablePrimaryContentWidth(page));
    expect(error.message).toContain("at least 320px");
  });

  test("keeps the 520px minimum when the context rail is collapsed", async ({ quality }) => {
    const { page } = quality;
    await page.getByRole("button", { name: "Hide context", exact: true }).click();
    await settleQualityPage(page);
    await expect(page.getByRole("region", { name: "Context", exact: true })).toBeHidden();
    await assertUsablePrimaryContentWidth(page);
    await page.locator('[data-slot="primary-content-pane"]').evaluate((element) => {
      (element as HTMLElement).style.flex = "0 0 519px";
    });
    const error = await captureExpectedFailure(() => assertUsablePrimaryContentWidth(page));
    expect(error.message).toContain("at least 520px");
  });

  test("keeps the 520px minimum when Canvas uses a context overlay", async ({ quality }) => {
    const { page } = quality;
    await page.evaluate(() => window.__coworkQualityGate?.showFilePreview());
    await settleQualityPage(page);
    await expect(page.getByRole("dialog", { name: "Context", exact: true })).toBeVisible();
    await assertUsablePrimaryContentWidth(page);
    await page.locator('[data-slot="primary-content-pane"]').evaluate((element) => {
      (element as HTMLElement).style.flex = "0 0 519px";
    });
    const error = await captureExpectedFailure(() => assertUsablePrimaryContentWidth(page));
    expect(error.message).toContain("at least 520px");
  });
});

test("clipping gate rejects an entirely off-viewport critical control", async ({ quality }) => {
  const { page } = quality;
  await page.evaluate(() => {
    const fixture = document.createElement("div");
    fixture.dataset.qualityClippingFixture = "off-viewport";
    fixture.style.position = "fixed";
    fixture.style.inset = "0";
    const button = document.createElement("button");
    button.ariaLabel = "Off-viewport critical action";
    button.dataset.qualityCriticalControl = "true";
    button.style.position = "absolute";
    button.style.left = "-200px";
    button.style.top = "20px";
    button.style.width = "120px";
    button.style.height = "32px";
    fixture.append(button);
    document.body.append(fixture);
  });

  const error = await captureExpectedFailure(async () => {
    await assertNoViewportClipping(page, '[data-quality-clipping-fixture="off-viewport"]');
  });
  expect(error.message).toContain(
    "Visible interactive controls must remain inside the viewport and every clipping ancestor",
  );
});

test("clipping exemptions require an actually reachable scroll position", async ({ quality }) => {
  const { page } = quality;
  await page.evaluate(() => {
    const fixture = document.createElement("div");
    fixture.dataset.qualityClippingFixture = "scroll-reachability";
    fixture.style.cssText =
      "position:fixed;left:20px;top:20px;width:180px;height:80px;overflow:auto";
    const content = document.createElement("div");
    content.style.cssText = "position:relative;width:500px;height:1000px";
    const button = document.createElement("button");
    button.textContent = "Reachable action";
    button.style.cssText = "position:absolute;left:10px;top:900px;width:120px;height:32px";
    content.append(button);
    fixture.append(content);
    document.body.append(fixture);
  });
  const scope = '[data-quality-clipping-fixture="scroll-reachability"]';
  await assertNoViewportClipping(page, scope);

  await page.locator(`${scope} button`).evaluate((button) => {
    button.style.left = "-200px";
    button.style.top = "10px";
  });
  expect(
    (await captureExpectedFailure(() => assertNoViewportClipping(page, scope))).message,
  ).toContain("every clipping ancestor");

  await page.locator(scope).evaluate((fixture) => {
    (fixture as HTMLElement).style.top = "900px";
  });
  await page.locator(`${scope} button`).evaluate((button) => {
    button.style.left = "10px";
  });
  expect(
    (await captureExpectedFailure(() => assertNoViewportClipping(page, scope))).message,
  ).toContain("every clipping ancestor");
});

test("clipping gate rejects a control clipped by a scrollable ancestor", async ({ quality }) => {
  const { page } = quality;
  await page.evaluate(() => {
    const fixture = document.createElement("div");
    fixture.dataset.qualityClippingFixture = "scroll-ancestor";
    fixture.style.position = "fixed";
    fixture.style.left = "20px";
    fixture.style.top = "20px";
    fixture.style.width = "80px";
    fixture.style.height = "40px";
    fixture.style.overflow = "auto";
    const button = document.createElement("button");
    button.ariaLabel = "Clipped scroll action";
    button.dataset.qualityCriticalControl = "true";
    button.style.display = "block";
    button.style.marginLeft = "100px";
    button.style.width = "120px";
    button.style.height = "32px";
    fixture.append(button);
    document.body.append(fixture);
  });

  const error = await captureExpectedFailure(async () => {
    await assertNoViewportClipping(page, '[data-quality-clipping-fixture="scroll-ancestor"]');
  });
  expect(error.message).toContain(
    "Visible interactive controls must remain inside the viewport and every clipping ancestor",
  );
});

test("clipping gate lets a fixed surface escape normal clipping ancestors", async ({ quality }) => {
  const { page } = quality;
  await page.evaluate(() => {
    const fixture = document.createElement("div");
    fixture.dataset.qualityClippingFixture = "fixed-surface";
    fixture.style.position = "relative";
    fixture.style.top = "120px";
    fixture.style.width = "80px";
    fixture.style.height = "40px";
    fixture.style.overflow = "hidden";

    const surface = document.createElement("div");
    surface.style.position = "fixed";
    surface.style.inset = "0";
    const button = document.createElement("button");
    button.ariaLabel = "Fixed surface action";
    button.style.position = "absolute";
    button.style.right = "8px";
    button.style.top = "8px";
    button.style.width = "120px";
    button.style.height = "32px";
    surface.append(button);
    fixture.append(surface);
    document.body.append(fixture);
  });

  await assertNoViewportClipping(page, '[data-quality-clipping-fixture="fixed-surface"]');
});

test("clipping gate rejects a fixed surface clipped by its transformed containing block", async ({
  quality,
}) => {
  const { page } = quality;
  await page.evaluate(() => {
    const fixture = document.createElement("div");
    fixture.dataset.qualityClippingFixture = "fixed-containing-block";
    fixture.style.position = "relative";
    fixture.style.left = "20px";
    fixture.style.top = "20px";
    fixture.style.width = "80px";
    fixture.style.height = "40px";
    fixture.style.overflow = "hidden";
    fixture.style.transform = "translateZ(0)";

    const surface = document.createElement("div");
    surface.style.position = "fixed";
    surface.style.inset = "0";
    const button = document.createElement("button");
    button.ariaLabel = "Transformed fixed surface action";
    button.dataset.qualityCriticalControl = "true";
    button.style.position = "absolute";
    button.style.left = "100px";
    button.style.top = "4px";
    button.style.width = "120px";
    button.style.height = "32px";
    surface.append(button);
    fixture.append(surface);
    document.body.append(fixture);
  });

  const error = await captureExpectedFailure(async () => {
    await assertNoViewportClipping(
      page,
      '[data-quality-clipping-fixture="fixed-containing-block"]',
    );
  });
  expect(error.message).toContain(
    "Visible interactive controls must remain inside the viewport and every clipping ancestor",
  );
});

test("Axe gate rejects an unbaselined color-contrast regression", async ({ quality }, testInfo) => {
  const { page } = quality;
  await page.evaluate(() => {
    const label = document.createElement("span");
    label.dataset.qualityContrastRegression = "true";
    label.id = "quality-contrast-regression";
    label.className = "tracking-wide";
    label.style.cssText = "display:block;padding:8px;background:#fff;color:#aaa";
    label.textContent = "Unbaselined contrast regression";
    document.querySelector("#main-content")?.prepend(label);
  });

  const error = await captureExpectedFailure(async () => {
    await assertNoSeriousAxeViolations(page, testInfo);
  });
  expect(error.message).toContain("color-contrast");
  expect(error.message).toContain("quality-contrast-regression");
});
