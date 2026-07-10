import { settleQualityPage } from "../assertions";
import budgets from "../budgets.json" with { type: "json" };
import { expect, test } from "../fixtures";

test("1,000 streaming deltas stay inside publication and render budgets", async ({
  quality,
}, testInfo) => {
  const { page } = quality;
  const samples = [];
  for (let runId = 1; runId <= 3; runId += 1) {
    await page.evaluate(() => window.__coworkQualityGate?.resetFeed());
    await settleQualityPage(page);
    await page.evaluate(() => window.__coworkQualityGate?.resetMetrics());
    const itemId = await quality.emitDeltaBurst(1_000, runId);
    await expect
      .poll(
        async () =>
          await page.evaluate((id) => window.__coworkQualityGate?.getFeedText(id), itemId),
      )
      .toContain(`[delta-burst-complete-${runId}]`);
    await settleQualityPage(page);
    const metrics = await page.evaluate(() => window.__coworkQualityGate?.getMetrics());
    samples.push(metrics);
    expect(metrics?.storePublications).toBeLessThanOrEqual(budgets.deltaBurst.storePublications);
    expect(metrics?.reactCommits).toBeLessThanOrEqual(budgets.deltaBurst.reactCommits);
  }
  await testInfo.attach("performance-delta-burst", {
    body: Buffer.from(`${JSON.stringify({ budgets: budgets.deltaBurst, samples }, null, 2)}\n`),
    contentType: "application/json",
  });
});

test("1,000-message transcript stays inside publication and render budgets", async ({
  quality,
}, testInfo) => {
  const { page } = quality;
  const samples = [];
  for (let runId = 1; runId <= 3; runId += 1) {
    await page.evaluate(() => window.__coworkQualityGate?.resetFeed());
    await settleQualityPage(page);
    await page.evaluate(() => window.__coworkQualityGate?.resetMetrics());
    const lastItemId = await quality.emitLongTranscript(1_000, runId);
    const expectedText = `Deterministic transcript run ${runId} message 1000`;
    await expect
      .poll(
        async () =>
          await page.evaluate((id) => window.__coworkQualityGate?.getFeedText(id), lastItemId),
      )
      .toBe(expectedText);
    await expect(page.getByText(expectedText)).toBeVisible();
    await settleQualityPage(page);
    const metrics = await page.evaluate(() => window.__coworkQualityGate?.getMetrics());
    samples.push(metrics);
    expect(metrics?.storePublications).toBeLessThanOrEqual(
      budgets.longTranscript.storePublications,
    );
    expect(metrics?.reactCommits).toBeLessThanOrEqual(budgets.longTranscript.reactCommits);
  }
  await testInfo.attach("performance-long-transcript", {
    body: Buffer.from(`${JSON.stringify({ budgets: budgets.longTranscript, samples }, null, 2)}\n`),
    contentType: "application/json",
  });
});

test("1,000-file tree stays inside filesystem, publication, and render budgets", async ({
  quality,
}, testInfo) => {
  const { electronApp, page } = quality;
  const samples = [];
  for (let runId = 1; runId <= 3; runId += 1) {
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
    samples.push({ main: mainMetrics, renderer: rendererMetrics, runId });
    expect(mainMetrics.filesystemRequests).toBeLessThanOrEqual(budgets.fileTree.filesystemRequests);
    expect(rendererMetrics?.storePublications).toBeLessThanOrEqual(
      budgets.fileTree.storePublications,
    );
    expect(rendererMetrics?.reactCommits).toBeLessThanOrEqual(budgets.fileTree.reactCommits);
  }
  await testInfo.attach("performance-file-tree", {
    body: Buffer.from(`${JSON.stringify({ budgets: budgets.fileTree, samples }, null, 2)}\n`),
    contentType: "application/json",
  });
});
