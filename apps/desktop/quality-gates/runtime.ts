import type { ProfilerOnRenderCallback } from "react";
import type { ResearchRecord } from "../../../src/server/research/types";
import type { SessionFeedItem } from "../../../src/shared/sessionSnapshot";
import { useAppStore } from "../src/app/store";
import { defaultThreadRuntime } from "../src/app/store.helpers";
import type { SettingsPageId } from "../src/app/types";
import type { ProviderName } from "../src/lib/wsProtocol";
import {
  createQualityTaskFixture,
  FIXED_NOW,
  PROJECT_THREAD_ID,
  PROJECT_WORKSPACE_ID,
} from "./fixtureData";

const RESEARCH_ID = "quality-research";

export type QualityGateMetrics = {
  reactCommits: number;
  storePublications: number;
};

export type QualityGateRuntime = {
  getFileCount(): number;
  getFeedText(itemId: string): string | null;
  getMetrics(): QualityGateMetrics;
  openSettings(page: SettingsPageId): void;
  refreshFileTree(): Promise<void>;
  resetFeed(): void;
  resetMetrics(): void;
  showDisconnect(): void;
  showFilePreview(): void;
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
  reactCommits: 0,
  storePublications: 0,
};
let installed = false;

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

export function installQualityGateRuntime(): void {
  if (installed) {
    return;
  }
  installed = true;
  if (window.innerWidth <= 640) {
    useAppStore.setState({ contextSidebarCollapsed: true });
  }
  useAppStore.subscribe(() => {
    metrics.storePublications += 1;
  });

  window.__coworkQualityGate = {
    getFileCount: () =>
      useAppStore.getState().workspaceExplorerById[PROJECT_WORKSPACE_ID]?.entries.length ?? 0,
    getFeedText: (itemId) => {
      const runtime = useAppStore.getState().threadRuntimeById[selectedThreadId()];
      const item = runtime?.feed.find((entry) => entry.id === itemId);
      return item?.kind === "message" ? item.text : null;
    },
    getMetrics: () => ({ ...metrics }),
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
      metrics = { reactCommits: 0, storePublications: 0 };
    },
    showDisconnect: () => {
      const threadId = selectedThreadId();
      useAppStore.setState((state) => ({
        threads: state.threads.map((thread) =>
          thread.id === threadId ? { ...thread, status: "active" as const } : thread,
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
    showFilePreview: () => {
      useAppStore.getState().openFilePreview({
        path: "/quality/project/quality-gate-report.md",
      });
    },
    showResearch: async (state) => {
      const fixture = makeResearchFixture(state);
      const parent = state === "follow-up" ? makeResearchFixture("completed") : null;
      const research = [parent, fixture].filter((entry): entry is ResearchRecord => entry !== null);
      useAppStore.setState({
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
