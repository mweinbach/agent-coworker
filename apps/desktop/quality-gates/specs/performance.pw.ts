import { settleQualityPage } from "../assertions";
import budgets from "../budgets.json" with { type: "json" };
import { expect, type QualityDeltaBurstPath, test } from "../fixtures";
import type { QualityGateMetrics } from "../runtime";

const transcriptRenderBarrierTimeoutMs = 20_000;
const deltaBurstPaths = [
  "projected",
  "legacy-chunk",
  "legacy-raw",
] as const satisfies readonly QualityDeltaBurstPath[];

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
  for (const [index, path] of deltaBurstPaths.entries()) {
    const runId = index + 1;
    await page.evaluate(() => window.__coworkQualityGate?.resetFeed());
    await settleQualityPage(page);
    await page.evaluate(() => window.__coworkQualityGate?.resetMetrics());
    const burst = await quality.emitDeltaBurst(1_000, runId, path);
    const streamingMarkdown = page.locator('[data-slot="streaming-markdown"]');
    await expect
      .poll(
        async () =>
          await page.evaluate(
            (prefix) => window.__coworkQualityGate?.getFeedTextByPrefix(prefix),
            burst.lookupPrefix,
          ),
        { message: `Wait for ${path} streaming to enter the live renderer` },
      )
      .toContain(burst.lookupPrefix);
    await expect(streamingMarkdown).toBeVisible();

    const progressBeforeInput = await quality.getDeltaBurstProgress(burst.itemId);
    expect(progressBeforeInput.emitted).toBeGreaterThan(0);
    expect(progressBeforeInput.emitted).toBeLessThan(burst.count);
    const composerDraft = `responsive-${path}-${runId}`;
    const composer = page.getByPlaceholder("Steer...");
    const inputStartedAt = performance.now();
    await composer.fill(composerDraft);
    await expect(composer).toHaveValue(composerDraft);
    const composerInputMs = performance.now() - inputStartedAt;
    expect(composerInputMs, `${path} composer responsiveness`).toBeLessThanOrEqual(
      budgets.deltaBurst.composerInputMs,
    );
    expect((await quality.getDeltaBurstProgress(burst.itemId)).emitted).toBeLessThan(burst.count);

    const draftThread = page.locator('button[title="Controlled fixture draft"]');
    const projectThread = page.locator('button[title="Electron release review"]');
    const navigationAwayStartedAt = performance.now();
    await draftThread.click();
    await expect(page.getByPlaceholder("Reconnect to continue...")).toBeVisible();
    const navigationAwayMs = performance.now() - navigationAwayStartedAt;
    await settleQualityPage(page);

    const backgroundStartProgress = await quality.getDeltaBurstProgress(burst.itemId);
    expect(backgroundStartProgress.emitted).toBeLessThan(burst.count);
    const backgroundMetricsBefore = await page.evaluate(() => {
      if (!window.__coworkQualityGate) {
        throw new Error("Quality gate runtime is unavailable");
      }
      return window.__coworkQualityGate.getMetrics();
    });
    await expect
      .poll(async () => (await quality.getDeltaBurstProgress(burst.itemId)).emitted)
      .toBeGreaterThanOrEqual(Math.min(burst.count, backgroundStartProgress.emitted + 50));
    await settleQualityPage(page);
    const backgroundMetricsAfter = await page.evaluate(() => {
      if (!window.__coworkQualityGate) {
        throw new Error("Quality gate runtime is unavailable");
      }
      return window.__coworkQualityGate.getMetrics();
    });
    const backgroundChatFeedRenders =
      (backgroundMetricsAfter.chatFeedRendersByThreadId["quality-draft-thread"] ?? 0) -
      (backgroundMetricsBefore.chatFeedRendersByThreadId["quality-draft-thread"] ?? 0);
    const backgroundSidebarRowRenders =
      (backgroundMetricsAfter.sidebarThreadRowRendersById["quality-draft-thread"] ?? 0) -
      (backgroundMetricsBefore.sidebarThreadRowRendersById["quality-draft-thread"] ?? 0);
    expect(backgroundChatFeedRenders).toBeLessThanOrEqual(
      budgets.deltaBurst.backgroundChatFeedRenders,
    );
    expect(backgroundSidebarRowRenders).toBeLessThanOrEqual(
      budgets.deltaBurst.backgroundSidebarRowRenders,
    );

    const navigationBackStartedAt = performance.now();
    await projectThread.click();
    await expect(page.locator("textarea")).toHaveValue(composerDraft);
    const navigationMs = navigationAwayMs + performance.now() - navigationBackStartedAt;
    expect(navigationMs, `${path} thread navigation responsiveness`).toBeLessThanOrEqual(
      budgets.deltaBurst.threadNavigationMs,
    );

    await expect
      .poll(
        async () =>
          await page.evaluate(
            (prefix) => window.__coworkQualityGate?.getFeedTextByPrefix(prefix),
            burst.lookupPrefix,
          ),
        {
          message: `Wait for all ordered ${path} deltas`,
          timeout: transcriptRenderBarrierTimeoutMs,
        },
      )
      .toBe(burst.expectedText);
    expect(await quality.getDeltaBurstProgress(burst.itemId)).toEqual({
      count: burst.count,
      emitted: burst.count,
    });
    await quality.completeDeltaBurst(burst.itemId);
    await expect(streamingMarkdown).toHaveCount(0, { timeout: 5_000 });
    expect(
      await page.evaluate(
        (prefix) => window.__coworkQualityGate?.getFeedTextByPrefix(prefix),
        burst.lookupPrefix,
      ),
    ).toBe(burst.expectedText);
    await settleQualityPage(page);
    const metrics = await page.evaluate(() => {
      if (!window.__coworkQualityGate) {
        throw new Error("Quality gate runtime is unavailable");
      }
      return window.__coworkQualityGate.getMetrics();
    });
    const sample = {
      backgroundChatFeedRenders,
      backgroundSidebarRowRenders,
      composerInputMs,
      metrics,
      navigationMs,
      path,
    };
    samples.push(sample);
    await testInfo.attach(`performance-delta-burst-${path}`, {
      body: Buffer.from(`${JSON.stringify({ budget: budgets.deltaBurst, sample }, null, 2)}\n`),
      contentType: "application/json",
    });
    assertPositiveRendererMetrics(metrics, budgets.deltaBurst);
    expect(metrics.contentPublications).toBeGreaterThan(0);
    expect(metrics.contentPublications).toBeLessThanOrEqual(budgets.deltaBurst.contentPublications);
    expect(metrics.chatFeedRenders).toBeLessThanOrEqual(budgets.deltaBurst.chatFeedRenders);
    expect(metrics.chatFeedRenders).toBeLessThanOrEqual(metrics.contentPublications);
    expect(metrics.feedRowRenders).toBeLessThanOrEqual(budgets.deltaBurst.feedRowRenders);
    expect(metrics.feedRowRenders).toBeLessThanOrEqual(metrics.chatFeedRenders);
    expect(metrics.streamingMarkdownRenders).toBeGreaterThan(0);
    expect(metrics.streamingMarkdownRenders).toBeLessThanOrEqual(
      budgets.deltaBurst.streamingMarkdownRenders,
    );
    expect(metrics.streamingMarkdownRenders).toBeLessThanOrEqual(metrics.feedRowRenders);
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
  const fileRows = page.locator('[role="treeitem"]');
  const changedRow = page.locator('[data-file-row-key="/quality/project/fixture-0002.ts"]');
  await expect(fileRows).toHaveCount(1_000);
  const samples = [];
  for (let runId = 1; runId <= 3; runId += 1) {
    await settleQualityPage(page);
    await electronApp.evaluate(() => globalThis.__coworkQualityGateMain?.resetMetrics());
    await page.evaluate(() => {
      window.__coworkQualityGate?.resetMetrics();
    });
    await quality.emitFileChange(runId);
    await expect(changedRow).toContainText(`${513 + runId} B`);
    await expect(fileRows).toHaveCount(1_000);
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
    expect(rendererMetrics.reactCommits).toBeGreaterThan(0);
    expect(rendererMetrics.reactCommits).toBeLessThanOrEqual(budgets.fileTree.reactCommits);
    expect(rendererMetrics.storePublications).toBeLessThanOrEqual(
      budgets.fileTree.storePublications,
    );
    expect(rendererMetrics.fileExplorerRowRenders).toBeGreaterThan(0);
    expect(rendererMetrics.fileExplorerRowRenders).toBeLessThanOrEqual(
      budgets.fileTree.fileExplorerRowRenders,
    );
    expect(
      rendererMetrics.fileExplorerRowRendersById["/quality/project/fixture-0002.ts"] ?? 0,
    ).toBe(1);
    expect(
      rendererMetrics.fileExplorerRowRendersById["/quality/project/quality-gate-report.md"] ?? 0,
    ).toBe(0);
  }
  await testInfo.attach("performance-file-tree", {
    body: Buffer.from(`${JSON.stringify({ budgets: budgets.fileTree, samples }, null, 2)}\n`),
    contentType: "application/json",
  });
});
