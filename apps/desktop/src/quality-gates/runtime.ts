import type { ProfilerOnRenderCallback } from "react";
import type { ResearchRecord } from "../../../../src/server/research/types";
import type { SessionFeedItem } from "../../../../src/shared/sessionSnapshot";
import type { TaskRecord } from "../../../../src/shared/tasks";
import { useAppStore } from "../app/store";
import { defaultThreadRuntime } from "../app/store.helpers";
import type { SettingsPageId } from "../app/types";
import type { ProviderName } from "../lib/wsProtocol";

const FIXED_NOW = "2026-07-09T12:00:00.000Z";
const PROJECT_WORKSPACE_ID = "quality-project";
const PROJECT_THREAD_ID = "quality-thread";
const TASK_ID = "quality-task";
const RESEARCH_ID = "quality-research";

export type QualityGateMetrics = {
  reactCommits: number;
  storePublications: number;
};

export type QualityGateRuntime = {
  emitCancellation(): void;
  emitCompletion(): void;
  emitDeltas(count: number): void;
  emitStreamingActivity(): void;
  getFileCount(): number;
  getMetrics(): QualityGateMetrics;
  loadLongTranscript(count: number): void;
  openSettings(page: SettingsPageId): void;
  refreshFileTree(): Promise<void>;
  resetMetrics(): void;
  showDisconnect(): void;
  showFilePreview(): void;
  showReconnect(): void;
  showResearch(state: "loading" | "empty" | "completed" | "follow-up"): Promise<void>;
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

function streamingFeed(): SessionFeedItem[] {
  return [
    {
      id: "quality-user",
      kind: "message",
      role: "user",
      ts: FIXED_NOW,
      text: "Audit the desktop experience and prepare a release-ready report.",
    },
    {
      id: "quality-reasoning",
      kind: "reasoning",
      mode: "summary",
      ts: FIXED_NOW,
      text: "Reviewing navigation, accessibility, and responsive layout.",
    },
    {
      id: "quality-tool",
      kind: "tool",
      ts: FIXED_NOW,
      name: "read",
      state: "output-available",
      args: { path: "docs/ui-quality-audit-2026-07.md" },
      result: "Loaded the current audit and acceptance criteria.",
      completedAt: FIXED_NOW,
    },
    {
      id: "quality-assistant",
      kind: "message",
      role: "assistant",
      ts: FIXED_NOW,
      text: "The quality review is in progress. I’m validating the highest-risk desktop flows first.",
    },
  ];
}

function makeTaskFixture(): TaskRecord {
  return {
    id: TASK_ID,
    workspacePath: "/quality/project",
    title: "Ship Electron quality gates",
    objective:
      "Protect desktop releases with deterministic UI, accessibility, and performance checks.",
    context: "The task is active and awaiting a product decision before final review.",
    sourceSessionId: PROJECT_THREAD_ID,
    creationOrigin: "manual",
    status: "blocked",
    revision: 4,
    reviewRequired: true,
    reviewRounds: 3,
    createdAt: FIXED_NOW,
    updatedAt: FIXED_NOW,
    threadCount: 1,
    completedWorkItemCount: 1,
    totalWorkItemCount: 2,
    activeBlockerCount: 1,
    pendingQuestionCount: 1,
    blockingQuestionCount: 1,
    requirements: [
      {
        id: "requirement-1",
        kind: "acceptance_criterion",
        text: "All quality gates run without provider credentials.",
        source: "user",
        permanence: "fixed",
        status: "active",
        createdAt: FIXED_NOW,
        supersedes: null,
      },
    ],
    threads: [
      {
        id: "task-thread-1",
        taskId: TASK_ID,
        sessionId: "task-session-1",
        title: "Implementation",
        createdBy: "coordinator",
        createdAt: FIXED_NOW,
        updatedAt: FIXED_NOW,
      },
    ],
    workItems: [
      {
        id: "work-1",
        taskId: TASK_ID,
        title: "Build deterministic harness",
        description: "Launch the shipping renderer through Electron.",
        status: "done",
        dependsOn: [],
        assignedThreadId: "task-thread-1",
        claimedByThreadId: "task-thread-1",
        expectedOutputs: ["Electron harness"],
        completionEvidence: "Harness launches locally.",
        position: 0,
        createdAt: FIXED_NOW,
        updatedAt: FIXED_NOW,
      },
      {
        id: "work-2",
        taskId: TASK_ID,
        title: "Review release artifacts",
        description: "Approve the generated desktop screenshot.",
        status: "blocked",
        dependsOn: ["work-1"],
        assignedThreadId: "task-thread-1",
        claimedByThreadId: "task-thread-1",
        expectedOutputs: ["Approved screenshot"],
        completionEvidence: null,
        position: 1,
        createdAt: FIXED_NOW,
        updatedAt: FIXED_NOW,
      },
    ],
    decisions: [],
    questions: [
      {
        id: "question-1",
        taskId: TASK_ID,
        threadId: "task-thread-1",
        workItemId: "work-2",
        header: "Release screenshot",
        question: "Which theme should be used for the release screenshot?",
        context: "The approved image is copied from a visual baseline.",
        blocking: true,
        urgency: "now",
        defaultAction: "Use the light theme.",
        options: [
          {
            id: "light",
            label: "Light",
            description: "Use the 1240px light baseline.",
          },
          {
            id: "dark",
            label: "Dark",
            description: "Use the 1240px dark baseline.",
          },
        ],
        recommendedOptionId: "light",
        status: "pending",
        provisionalDecisionId: null,
        answer: null,
        answerOptionId: null,
        resolutionSource: null,
        supersedes: null,
        createdAt: FIXED_NOW,
        resolvedAt: null,
      },
    ],
    artifacts: [
      {
        id: "artifact-1",
        taskId: TASK_ID,
        workItemId: "work-2",
        threadId: "task-thread-1",
        path: "/quality/project/quality-gate-report.md",
        kind: "markdown",
        title: "Quality gate report",
        createdBy: "task-thread-1",
        provenance: { source: "quality-gate-fixture" },
        createdAt: FIXED_NOW,
      },
    ],
    blockers: [
      {
        id: "blocker-1",
        taskId: TASK_ID,
        workItemId: "work-2",
        description: "Waiting for the release screenshot decision.",
        blocking: true,
        status: "active",
        createdAt: FIXED_NOW,
        resolvedAt: null,
      },
    ],
    activity: [],
    latestCheckpoint: null,
  };
}

function makeResearchFixture(
  state: "loading" | "empty" | "completed" | "follow-up",
): ResearchRecord | null {
  if (state === "empty" || state === "loading") {
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
    archivedAt: null,
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
  if (installed || window.cowork?.qualityGateMode !== true) {
    return;
  }
  installed = true;
  useAppStore.subscribe(() => {
    metrics.storePublications += 1;
  });

  window.__coworkQualityGate = {
    emitCancellation: () => {
      updateSelectedThread((feed) => ({
        feed: [
          ...feed,
          {
            id: "quality-cancelled",
            kind: "error",
            ts: FIXED_NOW,
            message: "Response stopped by the user.",
            code: "internal_error",
            source: "session",
          },
        ],
        busy: false,
        activeTurnId: null,
      }));
    },
    emitCompletion: () => {
      updateSelectedThread((feed) => ({
        feed: feed.map((item) =>
          item.id === "quality-assistant" && item.kind === "message"
            ? {
                ...item,
                text: "The desktop quality review is complete and ready for release.",
              }
            : item,
        ),
        busy: false,
        activeTurnId: null,
      }));
    },
    emitDeltas: (count) => {
      const boundedCount = Math.max(0, Math.min(10_000, Math.floor(count)));
      for (let index = 0; index < boundedCount; index += 1) {
        updateSelectedThread((feed) => ({
          feed: feed.map((item) =>
            item.id === "quality-assistant" && item.kind === "message"
              ? { ...item, text: `${item.text}.` }
              : item,
          ),
        }));
      }
    },
    emitStreamingActivity: () => {
      updateSelectedThread(() => ({
        feed: streamingFeed(),
        busy: true,
        activeTurnId: "quality-turn",
        connected: true,
      }));
      const threadId = selectedThreadId();
      useAppStore.setState({
        sandboxApprovalsByThread: {
          [threadId]: [
            {
              requestId: "approval-1",
              command: "bun run desktop:quality",
              detail: "The quality harness requested a controlled command.",
              category: "filesystem",
              receivedSequence: 1,
            },
          ],
        },
      });
    },
    getFileCount: () =>
      useAppStore.getState().workspaceExplorerById[PROJECT_WORKSPACE_ID]?.entries.length ?? 0,
    getMetrics: () => ({ ...metrics }),
    loadLongTranscript: (count) => {
      const boundedCount = Math.max(1, Math.min(2_000, Math.floor(count)));
      const feed: SessionFeedItem[] = Array.from({ length: boundedCount }, (_, index) => ({
        id: `quality-long-${index}`,
        kind: "message",
        role: index % 2 === 0 ? "user" : "assistant",
        ts: FIXED_NOW,
        text: `Deterministic transcript message ${index + 1}`,
      }));
      updateSelectedThread(() => ({ feed }));
    },
    openSettings: (page) => {
      useAppStore.getState().openSettings(page);
    },
    refreshFileTree: async () => {
      await useAppStore.getState().refreshWorkspaceFiles(PROJECT_WORKSPACE_ID);
    },
    resetMetrics: () => {
      metrics = { reactCommits: 0, storePublications: 0 };
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
        researchListLoading: state === "loading",
        researchListError: null,
        view: "research",
      });
    },
    showTaskReview: () => {
      const task = makeTaskFixture();
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
