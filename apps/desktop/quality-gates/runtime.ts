import { type ProfilerOnRenderCallback, useEffect, useState } from "react";
import type { ResearchRecord } from "../../../src/server/research/types";
import type { SessionFeedItem } from "../../../src/shared/sessionSnapshot";
import { useAppStore } from "../src/app/store";
import { defaultThreadRuntime } from "../src/app/store.helpers";
import type { SettingsPageId } from "../src/app/types";
import type { ProviderName } from "../src/lib/wsProtocol";
import {
  type DesktopRenderMetricEvent,
  setDesktopRenderMetricObserver,
} from "../src/ui/renderDiagnostics";
import {
  createQualityTaskFixture,
  FIXED_NOW,
  PROJECT_THREAD_ID,
  PROJECT_WORKSPACE_ID,
} from "./fixtureData";

const RESEARCH_ID = "quality-research";

export type QualityGateMetrics = {
  chatFeedRenders: number;
  chatFeedRendersByThreadId: Record<string, number>;
  contentPublications: number;
  desktopMarkdownRenders: number;
  feedRowRenders: number;
  fileExplorerRowRenders: number;
  fileExplorerRowRendersById: Record<string, number>;
  maxFeedDerivationItems: number;
  reactCommits: number;
  sidebarThreadRowRendersById: Record<string, number>;
  storePublications: number;
  streamingMarkdownRenders: number;
};

export type QualityGateRuntime = {
  getFileCount(): number;
  getFeedText(itemId: string): string | null;
  getFeedTextByPrefix(prefix: string): string | null;
  getMetrics(): QualityGateMetrics;
  isReady(): boolean;
  openSettings(page: SettingsPageId): void;
  refreshFileTree(): Promise<void>;
  resetFeed(): void;
  resetMetrics(): void;
  showDisconnect(): void;
  showCrashFallback(): void;
  showChat(): void;
  showFilePreview(): void;
  showPresentationPreview(): void;
  showNewChat(): Promise<void>;
  showReconnect(): void;
  showResearch(state: "empty" | "completed" | "follow-up"): Promise<void>;
  showTaskReview(): void;
  showToolFailureHistory(): void;
};

declare global {
  interface Window {
    __coworkQualityGate?: QualityGateRuntime;
  }
}

let metrics: QualityGateMetrics = {
  chatFeedRenders: 0,
  chatFeedRendersByThreadId: {},
  contentPublications: 0,
  desktopMarkdownRenders: 0,
  feedRowRenders: 0,
  fileExplorerRowRenders: 0,
  fileExplorerRowRendersById: {},
  maxFeedDerivationItems: 0,
  reactCommits: 0,
  sidebarThreadRowRendersById: {},
  storePublications: 0,
  streamingMarkdownRenders: 0,
};
let installed = false;
const crashListeners = new Set<() => void>();

export function QualityCrashProbe() {
  const [shouldCrash, setShouldCrash] = useState(false);
  useEffect(() => {
    const trigger = () => setShouldCrash(true);
    crashListeners.add(trigger);
    return () => {
      crashListeners.delete(trigger);
    };
  }, []);
  if (shouldCrash) {
    throw new Error("Deterministic quality-gate renderer crash.");
  }
  return null;
}

function selectedThreadId(): string {
  return useAppStore.getState().selectedThreadId ?? PROJECT_THREAD_ID;
}

function updateSelectedThread(
  update: (feed: SessionFeedItem[]) => {
    feed: SessionFeedItem[];
    busy?: boolean;
    activeTurnId?: string | null;
    connected?: boolean;
  },
): void {
  const threadId = selectedThreadId();
  useAppStore.setState((state) => {
    const current = state.threadRuntimeById[threadId] ?? defaultThreadRuntime();
    const next = update(current.feed);
    return {
      threadRuntimeById: {
        ...state.threadRuntimeById,
        [threadId]: {
          ...current,
          ...next,
        },
      },
    };
  });
}

function makeResearchFixture(state: "empty" | "completed" | "follow-up"): ResearchRecord | null {
  if (state === "empty") {
    return null;
  }
  const completed = state === "completed" || state === "follow-up";
  return {
    id: state === "follow-up" ? "quality-research-follow-up" : RESEARCH_ID,
    workspacePath: "/quality/project",
    parentResearchId: state === "follow-up" ? RESEARCH_ID : null,
    title: state === "follow-up" ? "Quality audit follow-up" : "Desktop quality research",
    prompt: "Compare deterministic Electron testing strategies.",
    status: completed ? "completed" : "running",
    interactionId: "quality-interaction",
    lastEventId: "quality-event",
    inputs: { files: [] },
    settings: {
      planApproval: false,
      agentId: "deep-research-max-preview-04-2026",
      thinkingSummaries: "auto",
      visualization: "auto",
    },
    outputsMarkdown: completed
      ? "## Recommendation\n\nUse a real Electron renderer with controlled fixtures and reviewed baselines."
      : "",
    thoughtSummaries: [
      {
        id: "thought-1",
        text: "Comparing IPC boundaries and rendering determinism.",
        ts: FIXED_NOW,
      },
    ],
    sources: completed
      ? [
          {
            url: "https://playwright.dev/docs/api/class-electron",
            title: "Playwright Electron",
            sourceType: "url",
            host: "playwright.dev",
          },
        ]
      : [],
    planPending: false,
    createdAt: FIXED_NOW,
    updatedAt: FIXED_NOW,
    error: null,
  };
}

function googleProviderStatus() {
  return {
    provider: "google" as ProviderName,
    authorized: true,
    verified: true,
    mode: "api_key" as const,
    account: null,
    savedApiKeyMasks: { api_key: "quality-…-key" },
    message: "Deterministic quality-gate fixture",
    checkedAt: FIXED_NOW,
  };
}

function recordRenderMetric(event: DesktopRenderMetricEvent): void {
  switch (event.metric) {
    case "chat-feed":
      metrics.chatFeedRenders += 1;
      if (event.id) {
        metrics.chatFeedRendersByThreadId[event.id] =
          (metrics.chatFeedRendersByThreadId[event.id] ?? 0) + 1;
      }
      return;
    case "desktop-markdown":
      metrics.desktopMarkdownRenders += 1;
      return;
    case "feed-derivation":
      metrics.maxFeedDerivationItems = Math.max(metrics.maxFeedDerivationItems, event.value ?? 0);
      return;
    case "feed-row":
      metrics.feedRowRenders += 1;
      return;
    case "file-explorer-row":
      metrics.fileExplorerRowRenders += 1;
      if (event.id) {
        metrics.fileExplorerRowRendersById[event.id] =
          (metrics.fileExplorerRowRendersById[event.id] ?? 0) + 1;
      }
      return;
    case "sidebar-thread-row": {
      if (!event.id) return;
      metrics.sidebarThreadRowRendersById[event.id] =
        (metrics.sidebarThreadRowRendersById[event.id] ?? 0) + 1;
      return;
    }
    case "streaming-markdown":
      metrics.streamingMarkdownRenders += 1;
      return;
    default: {
      const exhaustive: never = event.metric;
      throw new Error(`Unhandled desktop render metric: ${exhaustive}`);
    }
  }
}

export function installQualityGateRuntime(): void {
  if (installed) {
    return;
  }
  installed = true;
  setDesktopRenderMetricObserver(recordRenderMetric);
  useAppStore.subscribe((state, previousState) => {
    metrics.storePublications += 1;
    const contentChanged = Object.entries(state.threadRuntimeById).some(
      ([threadId, runtime]) => runtime?.feed !== previousState.threadRuntimeById[threadId]?.feed,
    );
    if (contentChanged) {
      metrics.contentPublications += 1;
    }
  });

  window.__coworkQualityGate = {
    getFileCount: () =>
      useAppStore.getState().workspaceExplorerById[PROJECT_WORKSPACE_ID]?.entries.length ?? 0,
    getFeedText: (itemId) => {
      const runtime = useAppStore.getState().threadRuntimeById[selectedThreadId()];
      const item = runtime?.feed.find((entry) => entry.id === itemId);
      return item?.kind === "message" ? item.text : null;
    },
    getFeedTextByPrefix: (prefix) => {
      const state = useAppStore.getState();
      for (const runtime of Object.values(state.threadRuntimeById)) {
        const item = runtime.feed.find(
          (entry) =>
            entry.kind === "message" && entry.role === "assistant" && entry.text.startsWith(prefix),
        );
        if (item?.kind === "message") {
          return item.text;
        }
      }
      return null;
    },
    getMetrics: () => ({ ...metrics }),
    isReady: () => {
      const state = useAppStore.getState();
      const threadId = state.selectedThreadId;
      if (!threadId) {
        return false;
      }
      const thread = state.threads.find((entry) => entry.id === threadId);
      const runtime = state.threadRuntimeById[threadId];
      return (
        thread?.status === "active" &&
        runtime?.connected === true &&
        runtime.hydrating === false &&
        runtime.transcriptOnly === false &&
        runtime.sessionId === threadId &&
        runtime.feed.length > 0
      );
    },
    openSettings: (page) => {
      useAppStore.getState().openSettings(page);
    },
    refreshFileTree: async () => {
      await useAppStore.getState().refreshWorkspaceFiles(PROJECT_WORKSPACE_ID);
    },
    resetFeed: () => {
      updateSelectedThread(() => ({
        feed: [],
        busy: false,
        activeTurnId: null,
      }));
    },
    resetMetrics: () => {
      metrics = {
        chatFeedRenders: 0,
        chatFeedRendersByThreadId: {},
        contentPublications: 0,
        desktopMarkdownRenders: 0,
        feedRowRenders: 0,
        fileExplorerRowRenders: 0,
        fileExplorerRowRendersById: {},
        maxFeedDerivationItems: 0,
        reactCommits: 0,
        sidebarThreadRowRendersById: {},
        storePublications: 0,
        streamingMarkdownRenders: 0,
      };
    },
    showCrashFallback: () => {
      for (const listener of crashListeners) {
        listener();
      }
    },
    showDisconnect: () => {
      const threadId = selectedThreadId();
      useAppStore.setState((state) => ({
        threads: state.threads.map((thread) =>
          thread.id === threadId ? { ...thread, status: "disconnected" as const } : thread,
        ),
        threadRuntimeById: {
          ...state.threadRuntimeById,
          [threadId]: {
            ...(state.threadRuntimeById[threadId] ?? defaultThreadRuntime()),
            connected: false,
            busy: false,
            activeTurnId: null,
            hydrating: false,
            sessionId: threadId,
            transcriptOnly: false,
          },
        },
      }));
    },
    showReconnect: () => {
      const threadId = selectedThreadId();
      useAppStore.setState((state) => ({
        threads: state.threads.map((thread) =>
          thread.id === threadId ? { ...thread, status: "active" as const } : thread,
        ),
        threadRuntimeById: {
          ...state.threadRuntimeById,
          [threadId]: {
            ...(state.threadRuntimeById[threadId] ?? defaultThreadRuntime()),
            connected: true,
          },
        },
      }));
    },
    showChat: () => {
      useAppStore.setState({
        filePreview: null,
        isCanvasMaximized: false,
        selectedTaskId: null,
        selectedThreadId: PROJECT_THREAD_ID,
        view: "chat",
      });
    },
    showFilePreview: () => {
      useAppStore.getState().openFilePreview({
        path: "/quality/project/quality-gate-report.md",
      });
    },
    showPresentationPreview: () => {
      useAppStore.getState().openFilePreview({
        path: "/quality/project/quality-gate-presentation.pptx",
      });
    },
    showNewChat: async () => {
      await useAppStore.getState().openNewChatLanding({
        target: { kind: "project", workspaceId: PROJECT_WORKSPACE_ID },
      });
    },
    showResearch: async (state) => {
      const fixture = makeResearchFixture(state);
      const parent = state === "follow-up" ? makeResearchFixture("completed") : null;
      const research = [parent, fixture].filter((entry): entry is ResearchRecord => entry !== null);
      useAppStore.setState({
        filePreview: null,
        isCanvasMaximized: false,
        providerStatusByName: { google: googleProviderStatus() },
        providerConnected: ["google"],
        researchById: {},
        researchOrder: [],
        selectedResearchId: null,
        researchListLoading: true,
        researchListError: null,
        view: "research",
      });
      for (let attempt = 0; attempt < 10; attempt += 1) {
        await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
        if (!useAppStore.getState().researchListLoading) {
          break;
        }
      }
      useAppStore.setState({
        filePreview: null,
        isCanvasMaximized: false,
        researchById: Object.fromEntries(research.map((entry) => [entry.id, entry])),
        researchOrder: research.map((entry) => entry.id),
        selectedResearchId: fixture?.id ?? null,
        researchListLoading: false,
        researchListError: null,
        view: "research",
      });
    },
    showTaskReview: () => {
      const task = createQualityTaskFixture();
      useAppStore.setState({
        filePreview: null,
        isCanvasMaximized: false,
        selectedWorkspaceId: PROJECT_WORKSPACE_ID,
        selectedTaskId: task.id,
        selectedThreadId: null,
        taskSummariesByWorkspaceId: {
          [PROJECT_WORKSPACE_ID]: [task],
        },
        tasksById: {
          [task.id]: task,
        },
        view: "task",
      });
    },
    showToolFailureHistory: () => {
      updateSelectedThread(() => ({
        feed: [
          {
            id: "quality-failed-tool",
            kind: "tool",
            ts: FIXED_NOW,
            name: "bash",
            state: "output-error",
            args: { command: "bun run desktop:quality" },
            result: "Quality fixture command failed deterministically.",
            completedAt: FIXED_NOW,
          },
          {
            id: "quality-failure-summary",
            kind: "message",
            role: "assistant",
            ts: FIXED_NOW,
            text: "The failed command remains visible in transcript history.",
          },
          {
            id: "quality-attachment-only",
            kind: "message",
            role: "user",
            ts: FIXED_NOW,
            text: "Attached quality-gate-report.md",
          },
        ],
        busy: false,
        activeTurnId: null,
      }));
    },
  };
}

export const recordQualityGateRender: ProfilerOnRenderCallback = () => {
  if (!installed) {
    return;
  }
  metrics.reactCommits += 1;
};
