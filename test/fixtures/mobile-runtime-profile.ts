import { createElement, memo, Profiler, type ProfilerOnRenderCallback, useMemo } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";

import { setupJsdom } from "../../apps/desktop/test/jsdomHarness";
import { buildChatRenderItems } from "../../apps/mobile/src/features/cowork/activityGroups";
import {
  MOBILE_LONG_FIXTURE_SIZE,
  MOBILE_RUNTIME_PROFILE_BUDGET,
} from "../../apps/mobile/src/features/cowork/mobilePerformanceContracts";
import type { SessionFeedItem } from "../../apps/mobile/src/features/cowork/protocolTypes";
import { buildThreadDetailList } from "../../apps/mobile/src/features/cowork/threadListModel";

type RuntimeProfileRowProps = {
  id: string;
  revision: string;
  onRender: () => void;
};

export type MobileRuntimeProfile = {
  deltaEvents: number;
  elapsedMs: number;
  fixtureHeapBytes: number;
  frameBudgetMisses: number;
  maxUpdateCommitDurationMs: number;
  networkRequests: number;
  rowRenders: number;
  streamingHeapBytes: number;
  streamingHeapGrowthBytes: number;
  totalUpdateCommitDurationMs: number;
  updateCommits: number;
};

const RuntimeProfileRow = memo(
  function RuntimeProfileRow({ id, onRender }: RuntimeProfileRowProps) {
    onRender();
    return createElement("span", { "data-row-id": id }, id);
  },
  (previous, next) =>
    previous.id === next.id &&
    previous.revision === next.revision &&
    previous.onRender === next.onRender,
);

function RuntimeProfileTranscript({
  feed,
  onRowRender,
}: {
  feed: SessionFeedItem[];
  onRowRender: () => void;
}) {
  const rows = useMemo(() => buildThreadDetailList(buildChatRenderItems(feed), null), [feed]);
  const renderedRows = rows.slice(-MOBILE_RUNTIME_PROFILE_BUDGET.profiledRowWindow);

  return createElement(
    "div",
    null,
    renderedRows.map((row) =>
      createElement(RuntimeProfileRow, {
        key: row.key,
        id: row.key,
        revision: row.revision,
        onRender: onRowRender,
      }),
    ),
  );
}

function makeLongFixtureMessage(index: number): Extract<SessionFeedItem, { kind: "message" }> {
  return {
    id: `runtime-message-${index}`,
    kind: "message",
    role: index % 2 === 0 ? "assistant" : "user",
    ts: "2026-07-10T00:00:00.000Z",
    text: `Runtime profile message ${index}`,
  };
}

function retainedHeapGrowth(before: number, after: number): number {
  return Math.max(0, after - before);
}

export async function runMobileRuntimeProfile(): Promise<MobileRuntimeProfile> {
  const jsdom = setupJsdom();
  (
    globalThis as typeof globalThis & {
      IS_REACT_ACT_ENVIRONMENT?: boolean;
    }
  ).IS_REACT_ACT_ENVIRONMENT = false;
  const container = document.getElementById("root");
  if (!container) {
    jsdom.restore();
    throw new Error("Missing runtime profile root");
  }

  const root = createRoot(container);
  const originalFetch = globalThis.fetch;
  let networkRequests = 0;
  globalThis.fetch = (() => {
    networkRequests += 1;
    return Promise.resolve(new Response());
  }) as typeof fetch;

  let rowRenders = 0;
  const onRowRender = () => {
    rowRenders += 1;
  };
  const updateCommitDurations: number[] = [];
  const onRender: ProfilerOnRenderCallback = (_id, phase, actualDuration) => {
    if (phase === "update") {
      updateCommitDurations.push(actualDuration);
    }
  };

  try {
    Bun.gc(true);
    let feed: SessionFeedItem[] = Array.from({ length: MOBILE_LONG_FIXTURE_SIZE }, (_, index) =>
      makeLongFixtureMessage(index),
    );

    flushSync(() => {
      root.render(
        createElement(
          Profiler,
          { id: "mobile-streaming-runtime", onRender },
          createElement(RuntimeProfileTranscript, {
            feed,
            onRowRender,
          }),
        ),
      );
    });
    Bun.gc(true);
    const heapAfterFixture = process.memoryUsage().heapUsed;
    const profileStartedAt = performance.now();

    for (let index = 0; index < MOBILE_LONG_FIXTURE_SIZE; index += 1) {
      const previousTail = feed[feed.length - 1];
      if (previousTail?.kind !== "message") {
        throw new Error("Runtime profile fixture lost its tail message");
      }
      feed = [
        ...feed.slice(0, -1),
        {
          ...previousTail,
          text: `Streaming revision ${index}`,
        },
      ];
      flushSync(() => {
        root.render(
          createElement(
            Profiler,
            { id: "mobile-streaming-runtime", onRender },
            createElement(RuntimeProfileTranscript, {
              feed,
              onRowRender,
            }),
          ),
        );
      });
    }

    const elapsedMs = performance.now() - profileStartedAt;
    Bun.gc(true);
    const heapAfterStreaming = process.memoryUsage().heapUsed;
    const totalUpdateCommitDurationMs = updateCommitDurations.reduce(
      (total, duration) => total + duration,
      0,
    );
    return {
      deltaEvents: MOBILE_LONG_FIXTURE_SIZE,
      elapsedMs,
      fixtureHeapBytes: heapAfterFixture,
      frameBudgetMisses: updateCommitDurations.filter(
        (duration) => duration > MOBILE_RUNTIME_PROFILE_BUDGET.frameDurationMs,
      ).length,
      maxUpdateCommitDurationMs: Math.max(0, ...updateCommitDurations),
      networkRequests,
      rowRenders,
      streamingHeapBytes: heapAfterStreaming,
      streamingHeapGrowthBytes: retainedHeapGrowth(heapAfterFixture, heapAfterStreaming),
      totalUpdateCommitDurationMs,
      updateCommits: updateCommitDurations.length,
    };
  } finally {
    flushSync(() => root.unmount());
    globalThis.fetch = originalFetch;
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 100);
    });
    jsdom.restore();
  }
}

if (import.meta.main) {
  const profile = await runMobileRuntimeProfile();
  process.stdout.write(`${JSON.stringify(profile)}\n`);
}
