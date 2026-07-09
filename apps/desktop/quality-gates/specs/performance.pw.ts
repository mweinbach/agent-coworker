import { settleQualityPage } from "../assertions";
import budgets from "../budgets.json" with { type: "json" };
import { expect, test } from "../fixtures";

test("1,000 streaming deltas stay inside publication and render budgets", async ({
  quality,
}, testInfo) => {
  const { page } = quality;
  await page.evaluate(() => {
    window.__coworkQualityGate?.emitStreamingActivity();
    window.__coworkQualityGate?.resetMetrics();
    window.__coworkQualityGate?.emitDeltas(1_000);
  });
  await settleQualityPage(page);
  const metrics = await page.evaluate(() => window.__coworkQualityGate?.getMetrics());
  await testInfo.attach("performance-delta-burst", {
    body: Buffer.from(`${JSON.stringify({ budgets: budgets.deltaBurst, metrics }, null, 2)}\n`),
    contentType: "application/json",
  });
  expect(metrics?.storePublications).toBeLessThanOrEqual(budgets.deltaBurst.storePublications);
  expect(metrics?.reactCommits).toBeLessThanOrEqual(budgets.deltaBurst.reactCommits);
});

test("1,000-message transcript stays inside publication and render budgets", async ({
  quality,
}, testInfo) => {
  const { page } = quality;
  await page.evaluate(() => {
    window.__coworkQualityGate?.resetMetrics();
    window.__coworkQualityGate?.loadLongTranscript(1_000);
  });
  await expect(page.getByText("Deterministic transcript message 1000")).toBeVisible();
  await settleQualityPage(page);
  const metrics = await page.evaluate(() => window.__coworkQualityGate?.getMetrics());
  await testInfo.attach("performance-long-transcript", {
    body: Buffer.from(`${JSON.stringify({ budgets: budgets.longTranscript, metrics }, null, 2)}\n`),
    contentType: "application/json",
  });
  expect(metrics?.storePublications).toBeLessThanOrEqual(budgets.longTranscript.storePublications);
  expect(metrics?.reactCommits).toBeLessThanOrEqual(budgets.longTranscript.reactCommits);
});

test("1,000-file tree stays inside filesystem, publication, and render budgets", async ({
  quality,
}, testInfo) => {
  const { electronApp, page } = quality;
  await electronApp.evaluate(() => globalThis.__coworkQualityGateMain?.resetMetrics());
  await page.evaluate(() => {
    window.__coworkQualityGate?.resetMetrics();
  });
  await page.evaluate(async () => {
    await window.__coworkQualityGate?.refreshFileTree();
  });
  await expect
    .poll(async () => await page.evaluate(() => window.__coworkQualityGate?.getFileCount()))
    .toBe(1_000);
  await settleQualityPage(page);
  const rendererMetrics = await page.evaluate(() => window.__coworkQualityGate?.getMetrics());
  const mainMetrics = await quality.getMainMetrics();
  const metrics = { main: mainMetrics, renderer: rendererMetrics };
  await testInfo.attach("performance-file-tree", {
    body: Buffer.from(`${JSON.stringify({ budgets: budgets.fileTree, metrics }, null, 2)}\n`),
    contentType: "application/json",
  });
  expect(mainMetrics.filesystemRequests).toBeLessThanOrEqual(budgets.fileTree.filesystemRequests);
  expect(rendererMetrics?.storePublications).toBeLessThanOrEqual(
    budgets.fileTree.storePublications,
  );
  expect(rendererMetrics?.reactCommits).toBeLessThanOrEqual(budgets.fileTree.reactCommits);
});
