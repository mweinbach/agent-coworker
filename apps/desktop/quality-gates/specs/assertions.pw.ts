import { assertNoViewportClipping } from "../assertions";
import { expect, test } from "../fixtures";

async function captureClippingFailure(action: () => Promise<void>): Promise<Error> {
  try {
    await action();
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error));
  }
  throw new Error("Expected the clipping assertion to fail");
}

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

  const error = await captureClippingFailure(async () => {
    await assertNoViewportClipping(page, '[data-quality-clipping-fixture="off-viewport"]');
  });
  expect(error.message).toContain(
    "Visible interactive controls must remain inside the viewport and every clipping ancestor",
  );
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

  const error = await captureClippingFailure(async () => {
    await assertNoViewportClipping(page, '[data-quality-clipping-fixture="scroll-ancestor"]');
  });
  expect(error.message).toContain(
    "Visible interactive controls must remain inside the viewport and every clipping ancestor",
  );
});
