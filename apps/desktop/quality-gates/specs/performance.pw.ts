import { settleQualityPage } from "../assertions";
import budgets from "../budgets.json" with { type: "json" };
import { expect, test } from "../fixtures";
import type { QualityGateMetrics } from "../runtime";

const transcriptRenderBarrierTimeoutMs = 20_000;

function assertPositiveRendererMetrics(
  metrics: QualityGateMetrics,
  budget: { reactCommits: number; storePublications: number },
): void {
  expect(
    metrics.storePublications,
    "The scenario must publish through the production store",
  ).toBeGreaterThan(0);
  expect(
    metrics.reactCommits,
    "The profiling renderer must observe at least one React commit",
  ).toBeGreaterThan(0);
  expect(metrics.storePublications).toBeLessThanOrEqual(budget.storePublications);
  expect(metrics.reactCommits).toBeLessThanOrEqual(budget.reactCommits);
}

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
    const streamingMarkdown = page.locator('[data-slot="streaming-markdown"]');
    await expect(streamingMarkdown).toBeVisible();
    await quality.completeDeltaBurst(itemId);
    await expect(streamingMarkdown).toHaveCount(0, { timeout: 5_000 });
    await settleQualityPage(page);
    const metrics = await page.evaluate(() => {
      if (!window.__coworkQualityGate) {
        throw new Error("Quality gate runtime is unavailable");
      }
      return window.__coworkQualityGate.getMetrics();
    });
    samples.push(metrics);
    assertPositiveRendererMetrics(metrics, budgets.deltaBurst);
    expect(metrics.contentPublications).toBeGreaterThan(0);
    expect(metrics.contentPublications).toBeLessThanOrEqual(budgets.deltaBurst.contentPublications);
    expect(metrics.chatFeedRenders).toBeLessThanOrEqual(budgets.deltaBurst.chatFeedRenders);
    expect(metrics.feedRowRenders).toBeLessThanOrEqual(budgets.deltaBurst.feedRowRenders);
    expect(metrics.streamingMarkdownRenders).toBeGreaterThan(0);
    expect(metrics.streamingMarkdownRenders).toBeLessThanOrEqual(
      budgets.deltaBurst.streamingMarkdownRenders,
    );
    expect(metrics.desktopMarkdownRenders).toBeGreaterThan(0);
    expect(metrics.desktopMarkdownRenders).toBeLessThanOrEqual(
      budgets.deltaBurst.desktopMarkdownRenders,
    );
    expect(metrics.maxFeedDerivationItems).toBeLessThanOrEqual(
      budgets.deltaBurst.maxFeedDerivationItems,
    );
    expect(metrics.sidebarThreadRowRendersById["quality-draft-thread"] ?? 0).toBeLessThanOrEqual(
      budgets.deltaBurst.unrelatedSidebarRowRenders,
    );
  }
  await testInfo.attach("performance-delta-burst", {
    body: Buffer.from(`${JSON.stringify({ budgets: budgets.deltaBurst, samples }, null, 2)}\n`),
    contentType: "application/json",
  });
});

test("1,000-message transcript stays inside publication and render budgets", async ({
  quality,
}, testInfo) => {
  test.setTimeout(90_000);
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
        {
          message: `Wait for transcript sample ${runId} to cross the renderer/store barrier`,
          timeout: transcriptRenderBarrierTimeoutMs,
        },
      )
      .toBe(expectedText);
    await expect(page.getByText(expectedText)).toBeVisible();
    await settleQualityPage(page);
    const metrics = await page.evaluate(() => {
      if (!window.__coworkQualityGate) {
        throw new Error("Quality gate runtime is unavailable");
      }
      return window.__coworkQualityGate.getMetrics();
    });
    samples.push(metrics);
    assertPositiveRendererMetrics(metrics, budgets.longTranscript);
    expect(metrics.maxFeedDerivationItems).toBeGreaterThan(0);
    expect(metrics.maxFeedDerivationItems).toBeLessThanOrEqual(
      budgets.longTranscript.maxFeedDerivationItems,
    );
    expect(await page.locator('[data-slot="message-scroller-item"]').count()).toBeLessThanOrEqual(
      budgets.longTranscript.mountedFeedRows,
    );
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
    const rendererMetrics = await page.evaluate(() => {
      if (!window.__coworkQualityGate) {
        throw new Error("Quality gate runtime is unavailable");
      }
      return window.__coworkQualityGate.getMetrics();
    });
    const mainMetrics = await quality.getMainMetrics();
    samples.push({ main: mainMetrics, renderer: rendererMetrics, runId });
    expect(
      mainMetrics.filesystemRequests,
      "The file-tree scenario must cross the production filesystem bridge",
    ).toBeGreaterThan(0);
    expect(mainMetrics.filesystemRequests).toBeLessThanOrEqual(budgets.fileTree.filesystemRequests);
    assertPositiveRendererMetrics(rendererMetrics, budgets.fileTree);
  }
  await testInfo.attach("performance-file-tree", {
    body: Buffer.from(`${JSON.stringify({ budgets: budgets.fileTree, samples }, null, 2)}\n`),
    contentType: "application/json",
  });
});
