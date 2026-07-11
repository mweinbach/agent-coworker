import { describe, expect, test } from "bun:test";

import { areMarkdownRevisionPropsEqual } from "../apps/mobile/src/components/thread/markdown-memo";
import {
  ACTIVITY_INLINE_PAGE_SIZE,
  buildActivityEntryPage,
  previousActivityPageStart,
} from "../apps/mobile/src/features/cowork/activityEntryPagination";
import { buildChatRenderItems } from "../apps/mobile/src/features/cowork/activityGroups";
import {
  MOBILE_LIST_PERFORMANCE_CONTRACTS,
  MOBILE_LONG_FIXTURE_SIZE,
  MOBILE_STREAM_PERFORMANCE_BUDGET,
} from "../apps/mobile/src/features/cowork/mobilePerformanceContracts";
import type { SessionFeedItem } from "../apps/mobile/src/features/cowork/protocolTypes";
import {
  buildThreadHomeListSections,
  threadHomeListRowCount,
} from "../apps/mobile/src/features/cowork/threadHomeListModel";
import {
  buildThreadHomeViewModel,
  defaultThreadHomeUiState,
} from "../apps/mobile/src/features/cowork/threadHomeModel";
import {
  buildThreadDetailList,
  chatRenderItemRevision,
} from "../apps/mobile/src/features/cowork/threadListModel";
import { changedThreadRows } from "../apps/mobile/src/features/cowork/threadScrollState";
import {
  type MobileThreadSummary,
  useThreadStore,
} from "../apps/mobile/src/features/cowork/threadStore";

const FIXTURE_TS = "2026-07-10T00:00:00.000Z";

function makeMessage(index: number): Extract<SessionFeedItem, { kind: "message" }> {
  return {
    id: `message-${index}`,
    kind: "message",
    role: index % 2 === 0 ? "assistant" : "user",
    ts: FIXTURE_TS,
    text: `Long fixture message ${index} with deterministic markdown **content**.`,
  };
}

function makeHomeThread(index: number): MobileThreadSummary {
  return {
    id: `home-thread-${index}`,
    title: `Home thread ${index}`,
    preview: `Preview ${index}`,
    updatedAt: FIXTURE_TS,
    cwd: `/tmp/chat-${index}`,
    workspaceId: `chat-workspace-${index}`,
    workspaceName: `Chat ${index}`,
    workspaceKind: "oneOffChat",
    feed: [],
    composerDraft: "",
    pendingPrompt: false,
    pendingServerRequest: null,
  };
}

describe("mobile long-list performance contracts", () => {
  test.each([
    "ios",
    "android",
  ] as const)("%s keeps deterministic thread and home render windows within budget", (platform) => {
    for (const surface of ["thread", "home"] as const) {
      const contract = MOBILE_LIST_PERFORMANCE_CONTRACTS[platform][surface];
      expect(contract.initialNumToRender).toBeLessThanOrEqual(12);
      expect(contract.maxToRenderPerBatch).toBeLessThanOrEqual(8);
      expect(contract.windowSize).toBeLessThanOrEqual(7);
    }
  });

  test("1,000 raw deltas stay one-to-one without coalescing, requests, or feed growth", async () => {
    const threadId = "performance-stream";
    const originalFetch = globalThis.fetch;
    let networkRequests = 0;
    globalThis.fetch = (() => {
      networkRequests += 1;
      return Promise.resolve(new Response());
    }) as typeof fetch;
    useThreadStore.setState({
      snapshots: {},
      threads: [],
      lastFeedMutationByThread: {},
    });

    try {
      for (let index = 0; index < MOBILE_STREAM_PERFORMANCE_BUDGET.deltaEvents; index += 1) {
        useThreadStore.getState().appendAgentDelta(threadId, "assistant-stream", "x", FIXTURE_TS);
      }
      await Promise.resolve();

      const state = useThreadStore.getState();
      const snapshot = state.snapshots[threadId];
      expect(snapshot?.lastEventSeq).toBe(MOBILE_LONG_FIXTURE_SIZE);
      expect(snapshot?.feed).toHaveLength(MOBILE_STREAM_PERFORMANCE_BUDGET.maxRetainedFeedItems);
      expect(snapshot?.feed[0]).toMatchObject({
        id: "assistant-stream",
        kind: "message",
        role: "assistant",
        text: "x".repeat(MOBILE_LONG_FIXTURE_SIZE),
      });
      expect(state.lastFeedMutationByThread[threadId]?.revision).toBe(MOBILE_LONG_FIXTURE_SIZE);
      expect(networkRequests).toBe(MOBILE_STREAM_PERFORMANCE_BUDGET.maxNetworkRequests);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("a 1,000-row thread retains one row model per item and revises only the changed row", () => {
    const feed = Array.from({ length: MOBILE_LONG_FIXTURE_SIZE }, (_, index) => makeMessage(index));
    const before = buildThreadDetailList(buildChatRenderItems(feed), null);
    const updatedFeed = [...feed];
    updatedFeed[MOBILE_LONG_FIXTURE_SIZE - 1] = {
      ...feed[MOBILE_LONG_FIXTURE_SIZE - 1],
      text: "Changed tail",
    };
    const after = buildThreadDetailList(buildChatRenderItems(updatedFeed), null);
    const changed = changedThreadRows(before, after);

    expect(before).toHaveLength(MOBILE_LONG_FIXTURE_SIZE);
    expect(changed).toEqual([`message-${MOBILE_LONG_FIXTURE_SIZE - 1}`]);
    expect(changed).toHaveLength(MOBILE_STREAM_PERFORMANCE_BUDGET.maxChangedRowsPerDelta);
    expect(chatRenderItemRevision(before[0].data)).toBe(chatRenderItemRevision(after[0].data));
  });

  test("a single Markdown revision invalidates only one of 1,000 memo comparisons", () => {
    const before = Array.from({ length: MOBILE_LONG_FIXTURE_SIZE }, (_, index) => ({
      text: `Markdown ${index}`,
      variant: "default" as const,
    }));
    const after = before.map((props, index) =>
      index === MOBILE_LONG_FIXTURE_SIZE - 1 ? { ...props, text: "Changed Markdown" } : props,
    );
    const invalidated = before.reduce(
      (count, props, index) =>
        count + (areMarkdownRevisionPropsEqual(props, after[index] ?? props) ? 0 : 1),
      0,
    );

    expect(invalidated).toBe(1);
  });

  test("a 1,000-row home fixture is flattened for SectionList", () => {
    const threads = Array.from({ length: MOBILE_LONG_FIXTURE_SIZE }, (_, index) =>
      makeHomeThread(index),
    );
    const viewModel = buildThreadHomeViewModel({
      threads,
      workspaces: threads.map((thread, index) => ({
        id: thread.workspaceId ?? `workspace-${index}`,
        name: thread.workspaceName ?? `Chat ${index}`,
        path: thread.cwd ?? `/tmp/chat-${index}`,
        workspaceKind: "oneOffChat",
      })),
      searchQuery: "",
      ui: {
        ...defaultThreadHomeUiState(),
        showAllChats: true,
        oneOffChatWorkspaceLoadLimit: MOBILE_LONG_FIXTURE_SIZE,
      },
    });
    const sections = buildThreadHomeListSections({
      viewModel,
      homeLoadPending: { chats: false, projects: {} },
      chatsError: null,
      projectErrors: {},
    });

    expect(sections[0]?.key).toBe("chats");
    expect(sections[0]?.data).toHaveLength(MOBILE_LONG_FIXTURE_SIZE);
    expect(threadHomeListRowCount(sections)).toBe(MOBILE_LONG_FIXTURE_SIZE + 1);
  });

  test("all 1,000 Activity entries remain reachable through bounded inline pages", () => {
    const entries = Array.from({ length: MOBILE_LONG_FIXTURE_SIZE }, (_, index) => ({
      id: `activity-${index}`,
    }));
    const visited = new Set<string>();
    let page = buildActivityEntryPage(entries, null);

    while (true) {
      expect(page.entries.length).toBeLessThanOrEqual(ACTIVITY_INLINE_PAGE_SIZE);
      for (const entry of page.entries) {
        visited.add(entry.id);
      }
      if (page.hiddenBefore === 0) {
        break;
      }
      page = buildActivityEntryPage(entries, previousActivityPageStart(page));
    }

    expect(visited.size).toBe(MOBILE_LONG_FIXTURE_SIZE);
  });

  test("Activity has one bounded inline owner and both home contracts use SectionList", async () => {
    const [activitySource, threadSource, homeSource, iosWrapper, androidWrapper] =
      await Promise.all([
        Bun.file("apps/mobile/src/components/thread/activity-group-card.tsx").text(),
        Bun.file("apps/mobile/src/app/(app)/thread/[id].tsx").text(),
        Bun.file("apps/mobile/src/components/thread-home/thread-home-screen.shared.tsx").text(),
        Bun.file("apps/mobile/src/components/thread-home/thread-home-screen.ios.tsx").text(),
        Bun.file("apps/mobile/src/components/thread-home/thread-home-screen.tsx").text(),
      ]);

    expect(activitySource).not.toMatch(/\b(?:FlatList|SectionList|ScrollView)\b/);
    expect(activitySource).toContain("buildActivityEntryPage");
    expect(threadSource).toContain("maintainVisibleContentPosition");
    expect(threadSource).toContain("programmaticScrollGuardRef");
    expect(threadSource).toContain("new · Jump to latest");
    expect(homeSource).toContain("SectionList");
    expect(homeSource).not.toContain("ScrollView");
    expect(iosWrapper).toContain('platform="ios"');
    expect(androidWrapper).toContain('platform="android"');
  });
});
