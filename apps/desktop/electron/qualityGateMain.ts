import { createReadStream, promises as fs } from "node:fs";
import { createServer, type Server as HttpServer } from "node:http";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type * as Electron from "electron";
import type * as Ws from "ws";
import { hostPlatform } from "../../../src/platform/host";
import type { ResearchRecord } from "../../../src/server/research/types";
import {
  createQualityTaskArtifactDetail,
  createQualityTaskFixture,
  PROJECT_THREAD_ID,
} from "../quality-gates/fixtureData";
import type { PersistedState } from "../src/app/types";
import {
  createDefaultUpdaterState,
  DESKTOP_IPC_CHANNELS,
  type ExplorerEntry,
  type PlatformChromeInfo,
  type SystemAppearance,
} from "../src/lib/desktopApi";
import { getPlatformChrome } from "./services/windowChrome/platformChrome";

const nodeRequire = createRequire(import.meta.url);
const { app, BrowserWindow, ipcMain, session } = nodeRequire("electron") as typeof Electron;
const { WebSocket, WebSocketServer } = nodeRequire("ws") as typeof Ws;
const qualityGateDir = path.dirname(fileURLToPath(import.meta.url));
const FIXED_NOW = "2026-07-09T12:00:00.000Z";
const PROJECT_WORKSPACE_ID = "quality-project";
const QUICK_WORKSPACE_ID = "quality-quick";
const QUICK_THREAD_ID = "quality-quick-thread";
const qualityPlatform = hostPlatform();
const EXTERNAL_NETWORK_PROOF_URL = "https://example.invalid/quality-gate-network-proof";

type QualityMode = "light" | "dark" | "reduced-motion" | "forced-colors";
type QualityScenario = "first-launch" | "product";

type QualityMainMetrics = {
  approvalResponses: number;
  blockedRequests: string[];
  clientRequestsByMethod: Record<string, number>;
  confirmationRequests: number;
  filesystemRequests: number;
  missingAssetRequests: number;
  mobileForgetRequests: number;
  rendererLogEntries: number;
  stateSaves: number;
  taskCancellationRequests: number;
  turnInterruptRequests: number;
  turnSteerRequests: number;
  websocketRequests: number;
};

type QualityLifecycle = {
  captureReady: number;
  firstLoadStarted: number;
  firstWindowCreated: number;
  networkGuardInstalled: number;
};

type QualityMainControl = {
  completeDeltaBurst(itemId: string): void;
  emitCompletion(): void;
  emitDeltaBurst(count: number, runId: number): string;
  emitLongTranscript(count: number, runId: number): string;
  emitStreamingActivity(): void;
  getExternalNetworkProofUrl(): string;
  getLifecycle(): QualityLifecycle;
  getMetrics(): QualityMainMetrics;
  getRendererLogs(): unknown[];
  releaseBootstrap(): void;
  resetMetrics(): void;
};

declare global {
  var __coworkQualityGateMain: QualityMainControl | undefined;
}

const qualityMode = parseQualityMode(process.env.COWORK_QUALITY_MODE);
const qualityScenario = parseQualityScenario(process.env.COWORK_QUALITY_SCENARIO);
const contentWidth = parseDimension(process.env.COWORK_QUALITY_WIDTH, 1240);
const contentHeight = parseDimension(process.env.COWORK_QUALITY_HEIGHT, 820);
const startupDelayMs = parseDelay(process.env.COWORK_QUALITY_STARTUP_DELAY_MS);
const holdBootstrap = process.env.COWORK_QUALITY_HOLD_BOOTSTRAP === "1";
const captureReadyFile = process.env.COWORK_QUALITY_CAPTURE_READY_FILE?.trim() ?? "";
const userDataPath =
  process.env.COWORK_QUALITY_USER_DATA?.trim() ||
  path.join(app.getPath("temp"), `cowork-quality-gate-${process.pid}`);

app.setName("Cowork Quality Gate");
app.setPath("userData", userDataPath);
app.commandLine.appendSwitch("force-device-scale-factor", "1");
app.commandLine.appendSwitch("force-color-profile", "srgb");
app.commandLine.appendSwitch("disable-lcd-text");
app.commandLine.appendSwitch("disable-renderer-backgrounding");
process.env.COWORK_IS_PACKAGED = "false";
process.env.COWORK_DESKTOP_QUALITY_GATE = "1";
process.env.COWORK_CRASH_REPORTS_ENABLED = "false";
process.env.COWORK_PRODUCT_ANALYTICS_ENABLED = "false";
process.env.COWORK_ENABLE_TASKS = "true";

let persistedState = createPersistedState(qualityScenario);
let mainWindow: Electron.BrowserWindow | null = null;
let mockServer: Ws.WebSocketServer | null = null;
let mockServerUrl = "";
let rendererServer: HttpServer | null = null;
let rendererServerUrl = "";
let rendererLogs: unknown[] = [];
const researchRecords = new Map<string, ResearchRecord>();
const connectedSockets = new Set<Ws.WebSocket>();
const pendingDeltaBursts = new Map<string, { finalText: string; turnId: string }>();
let lifecycleSequence = 0;
let bootstrapReleased = !holdBootstrap;
let resolveBootstrap: (() => void) | null = null;
const bootstrapBarrier = new Promise<void>((resolve) => {
  resolveBootstrap = resolve;
});
const lifecycle: QualityLifecycle = {
  captureReady: 0,
  firstLoadStarted: 0,
  firstWindowCreated: 0,
  networkGuardInstalled: 0,
};
let metrics: QualityMainMetrics = {
  approvalResponses: 0,
  blockedRequests: [],
  clientRequestsByMethod: {},
  confirmationRequests: 0,
  filesystemRequests: 0,
  missingAssetRequests: 0,
  mobileForgetRequests: 0,
  rendererLogEntries: 0,
  stateSaves: 0,
  taskCancellationRequests: 0,
  turnInterruptRequests: 0,
  turnSteerRequests: 0,
  websocketRequests: 0,
};

globalThis.__coworkQualityGateMain = {
  completeDeltaBurst: (itemId) => {
    completeDeltaBurst(itemId);
  },
  emitCompletion: () => {
    emitCompletion();
  },
  emitDeltaBurst: (count, runId) => emitDeltaBurst(count, runId),
  emitLongTranscript: (count, runId) => emitLongTranscript(count, runId),
  emitStreamingActivity: () => {
    emitStreamingActivity();
  },
  getExternalNetworkProofUrl: () => EXTERNAL_NETWORK_PROOF_URL,
  getLifecycle: () => ({ ...lifecycle }),
  getMetrics: () => structuredClone(metrics),
  getRendererLogs: () => structuredClone(rendererLogs),
  releaseBootstrap: () => {
    if (bootstrapReleased) {
      return;
    }
    bootstrapReleased = true;
    resolveBootstrap?.();
    resolveBootstrap = null;
  },
  resetMetrics: () => {
    rendererLogs = [];
    metrics = {
      approvalResponses: 0,
      blockedRequests: [],
      clientRequestsByMethod: {},
      confirmationRequests: 0,
      filesystemRequests: 0,
      missingAssetRequests: 0,
      mobileForgetRequests: 0,
      rendererLogEntries: 0,
      stateSaves: 0,
      taskCancellationRequests: 0,
      turnInterruptRequests: 0,
      turnSteerRequests: 0,
      websocketRequests: 0,
    };
  },
};

function parseQualityMode(value: string | undefined): QualityMode {
  switch (value) {
    case "dark":
    case "reduced-motion":
    case "forced-colors":
      return value;
    default:
      return "light";
  }
}

function parseQualityScenario(value: string | undefined): QualityScenario {
  return value === "first-launch" ? value : "product";
}

function parseDimension(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 320 && parsed <= 4000 ? parsed : fallback;
}

function parseDelay(value: string | undefined): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= 10_000 ? Math.floor(parsed) : 0;
}

function createPersistedState(scenario: QualityScenario): PersistedState {
  if (scenario === "first-launch") {
    return {
      version: 2,
      workspaces: [],
      threads: [],
      onboarding: {
        status: "pending",
        completedAt: null,
        dismissedAt: null,
      },
    };
  }

  return {
    version: 2,
    workspaces: [
      {
        id: PROJECT_WORKSPACE_ID,
        name: "Quality Gates",
        path: "/quality/project",
        workspaceKind: "project",
        createdAt: "2026-07-01T12:00:00.000Z",
        lastOpenedAt: FIXED_NOW,
        wsProtocol: "jsonrpc",
        defaultEnableMcp: true,
        defaultBackupsEnabled: false,
        yolo: false,
      },
      {
        id: QUICK_WORKSPACE_ID,
        name: "Quick Chat",
        path: "/quality/quick-chat",
        workspaceKind: "oneOffChat",
        createdAt: "2026-07-01T12:00:00.000Z",
        lastOpenedAt: "2026-07-08T12:00:00.000Z",
        wsProtocol: "jsonrpc",
        defaultEnableMcp: true,
        defaultBackupsEnabled: false,
        yolo: false,
      },
    ],
    threads: [
      {
        id: PROJECT_THREAD_ID,
        workspaceId: PROJECT_WORKSPACE_ID,
        title: "Electron release review",
        titleSource: "manual",
        createdAt: "2026-07-01T12:00:00.000Z",
        lastMessageAt: FIXED_NOW,
        status: "active",
        sessionId: PROJECT_THREAD_ID,
        messageCount: 0,
        lastEventSeq: 0,
      },
      {
        id: "quality-draft-thread",
        workspaceId: PROJECT_WORKSPACE_ID,
        title: "Controlled fixture draft",
        titleSource: "manual",
        createdAt: "2026-07-05T12:00:00.000Z",
        lastMessageAt: "2026-07-08T16:00:00.000Z",
        status: "disconnected",
        sessionId: null,
        messageCount: 0,
        lastEventSeq: 0,
        draft: true,
      },
      {
        id: QUICK_THREAD_ID,
        workspaceId: QUICK_WORKSPACE_ID,
        title: "Quick release note",
        titleSource: "manual",
        createdAt: "2026-07-06T12:00:00.000Z",
        lastMessageAt: "2026-07-08T12:00:00.000Z",
        status: "active",
        sessionId: QUICK_THREAD_ID,
        messageCount: 0,
        lastEventSeq: 0,
      },
    ],
    developerMode: true,
    desktopFeatureFlagOverrides: {
      canvas: true,
      remoteAccess: true,
      tasks: true,
    },
    onboarding: {
      status: "completed",
      completedAt: "2026-07-01T12:00:00.000Z",
      dismissedAt: null,
    },
    providerState: {
      statusByName: {
        google: {
          provider: "google",
          authorized: true,
          verified: true,
          mode: "api_key",
          account: null,
          savedApiKeyMasks: { api_key: "quality-…-key" },
          message: "Deterministic quality-gate fixture",
          checkedAt: FIXED_NOW,
        },
      },
      statusLastUpdatedAt: FIXED_NOW,
    },
  };
}

function createAppearance(): SystemAppearance {
  const dark = qualityMode === "dark";
  const forcedColors = qualityMode === "forced-colors";
  return {
    platform: qualityPlatform,
    themeSource: dark ? "dark" : "light",
    shouldUseDarkColors: dark,
    shouldUseDarkColorsForSystemIntegratedUI: dark,
    shouldUseHighContrastColors: forcedColors,
    shouldUseInvertedColorScheme: false,
    prefersReducedTransparency: qualityMode === "reduced-motion",
    inForcedColorsMode: forcedColors,
  };
}

function createPlatformChrome(): PlatformChromeInfo {
  const chrome = getPlatformChrome(qualityPlatform);
  return {
    platform: chrome.platform,
    titlebarHeight: chrome.titlebarHeight,
    dragStripHeight: chrome.dragStripHeight,
    leftNativeReserve: chrome.leftNativeReserve,
    rightNativeReserve: chrome.rightNativeReserve,
    captionButtonReserve: chrome.captionButtonReserve,
    collapsedLeftRailWidth: chrome.collapsedLeftRailWidth,
    topbarToolbarGap: chrome.topbarToolbarGap,
    sidebarTitlebandMode: chrome.sidebarTitlebandMode,
    topbarControlPlacement: chrome.topbarControlPlacement,
    usesNativeGlass: chrome.usesNativeGlass,
    disableCssBlur: chrome.disableCssBlur,
  };
}

function createExplorerEntries(): ExplorerEntry[] {
  return Array.from({ length: 1_000 }, (_, index) => {
    const fileNumber = String(index + 1).padStart(4, "0");
    return {
      name: index === 0 ? "quality-gate-report.md" : `fixture-${fileNumber}.ts`,
      path:
        index === 0
          ? "/quality/project/quality-gate-report.md"
          : `/quality/project/fixture-${fileNumber}.ts`,
      isDirectory: false,
      isHidden: false,
      sizeBytes: 512 + index,
      modifiedAtMs: Date.parse(FIXED_NOW),
    };
  });
}

const explorerEntries = createExplorerEntries();
const hydratedTranscript = {
  feed: [
    {
      id: "fixture-user",
      kind: "message",
      role: "user",
      ts: "2026-07-09T11:55:00.000Z",
      text: "Prepare the desktop quality-gate release report.",
    },
    {
      id: "fixture-reasoning",
      kind: "reasoning",
      mode: "summary",
      ts: "2026-07-09T11:56:00.000Z",
      text: "Checking window layout, accessibility, and deterministic fixtures.",
    },
    {
      id: "fixture-tool",
      kind: "tool",
      ts: "2026-07-09T11:57:00.000Z",
      name: "read",
      state: "output-available",
      args: { path: "docs/ui-quality-audit-2026-07.md" },
      result: "Audit loaded successfully.",
      completedAt: "2026-07-09T11:57:01.000Z",
    },
    {
      id: "fixture-assistant",
      kind: "message",
      role: "assistant",
      ts: FIXED_NOW,
      text: "The deterministic Electron quality gates are ready for review.",
    },
  ],
  agents: [],
  sessionUsage: null,
  lastTurnUsage: null,
};

function defaultMobileRelayState() {
  return {
    status: "idle",
    workspaceId: null,
    workspacePath: null,
    relaySource: "unavailable",
    relaySourceMessage: null,
    relayServiceStatus: "unknown",
    relayServiceMessage: null,
    relayServiceUpdatedAt: null,
    relayUrl: null,
    sessionId: null,
    pairingPayload: null,
    trustedPhoneDeviceId: "quality-phone",
    trustedPhoneFingerprint: "SHA256:QUALITY",
    trustedPhoneDevices: [
      {
        deviceId: "quality-phone",
        fingerprint: "SHA256:QUALITY",
        displayName: "Quality Phone",
        lastPairedAt: FIXED_NOW,
        lastConnectedAt: FIXED_NOW,
        permissions: {
          turns: true,
          serverRequests: true,
          providerAuth: false,
          mcpAuth: false,
          workspaceSettings: false,
          backups: false,
          conversations: true,
        },
      },
    ],
    directUrl: null,
    ticketUrl: null,
    certSha256: null,
    spkiSha256: null,
    hostHints: [],
    lastError: null,
  };
}

function telemetryStatus() {
  const disabled = {
    label: "Disabled",
    status: "disabled",
    configured: false,
    enabled: false,
  } as const;
  return {
    globalKillSwitchActive: false,
    crashReports: disabled,
    productAnalytics: disabled,
    aiTraces: disabled,
    diagnosticsUpload: disabled,
    cloudSync: disabled,
  };
}

async function delay(ms: number): Promise<void> {
  if (ms <= 0) {
    return;
  }
  await new Promise<void>((resolve) => setTimeout(resolve, ms));
}

function qualityThreadRecord() {
  return {
    id: PROJECT_THREAD_ID,
    title: "Electron release review",
    createdAt: "2026-07-01T12:00:00.000Z",
    updatedAt: FIXED_NOW,
    modelProvider: "google",
    model: "quality-fixture",
    cwd: "/quality/project",
    messageCount: hydratedTranscript.feed.length,
    lastEventSeq: 0,
    status: { type: "idle" },
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

function inputText(value: unknown): string {
  if (!Array.isArray(value)) {
    return "";
  }
  return value
    .map((entry) => {
      const input = asRecord(entry);
      return input.type === "text" && typeof input.text === "string" ? input.text : "";
    })
    .join("");
}

function sendServerMessage(message: Record<string, unknown>): void {
  const serialized = JSON.stringify(message);
  for (const socket of connectedSockets) {
    if (socket.readyState === WebSocket.OPEN) {
      socket.send(serialized);
    }
  }
}

function sendNotification(method: string, params: Record<string, unknown>): void {
  sendServerMessage({ method, params });
}

function sendProjectedItem(
  method: "item/started" | "item/completed",
  item: Record<string, unknown>,
  turnId: string | null,
): void {
  sendNotification(method, {
    threadId: PROJECT_THREAD_ID,
    turnId,
    item,
  });
}

function emitStreamingActivity(): void {
  const turnId = "quality-turn";
  sendNotification("turn/started", {
    threadId: PROJECT_THREAD_ID,
    turn: { id: turnId, status: "inProgress" },
  });
  sendProjectedItem(
    "item/completed",
    {
      id: "quality-user",
      type: "userMessage",
      content: [
        {
          type: "text",
          text: "Audit the desktop experience and prepare a release-ready report.",
        },
      ],
    },
    turnId,
  );
  sendProjectedItem(
    "item/completed",
    {
      id: "quality-reasoning",
      type: "reasoning",
      mode: "summary",
      text: "Reviewing navigation, accessibility, and deterministic rendering.",
    },
    turnId,
  );
  sendProjectedItem(
    "item/completed",
    {
      id: "quality-tool",
      type: "toolCall",
      toolName: "read",
      state: "output-available",
      args: { path: "docs/ui-quality-audit-2026-07.md" },
      result: "Loaded the current audit and acceptance criteria.",
    },
    turnId,
  );
  sendProjectedItem(
    "item/started",
    {
      id: "quality-assistant",
      type: "agentMessage",
      text: "",
    },
    turnId,
  );
  sendNotification("item/agentMessage/delta", {
    threadId: PROJECT_THREAD_ID,
    turnId,
    itemId: "quality-assistant",
    delta: "The quality review is in progress.",
  });
  sendServerMessage({
    id: "approval-1",
    method: "item/commandExecution/requestApproval",
    params: {
      threadId: PROJECT_THREAD_ID,
      command: "bun run desktop:quality",
      detail: "The quality harness requested a controlled command.",
      category: "filesystem",
      reason: "sandbox_denied_escalation",
    },
  });
}

function emitCompletion(): void {
  const text = "The desktop quality review is complete and ready for release.";
  sendProjectedItem(
    "item/completed",
    {
      id: "quality-assistant",
      type: "agentMessage",
      text,
    },
    "quality-turn",
  );
  sendNotification("turn/completed", {
    threadId: PROJECT_THREAD_ID,
    turn: { id: "quality-turn", status: "completed" },
  });
}

function emitCancellation(): void {
  sendNotification("turn/completed", {
    threadId: PROJECT_THREAD_ID,
    turn: { id: "quality-turn", status: "interrupted" },
  });
}

function emitDeltaBurst(count: number, runId: number): string {
  const boundedCount = Math.max(1, Math.min(10_000, Math.floor(count)));
  const itemId = `quality-delta-${runId}`;
  const marker = `[delta-burst-complete-${runId}]`;
  const finalText = `${".".repeat(boundedCount - 1)}${marker}`;
  const turnId = "quality-performance-turn";
  pendingDeltaBursts.set(itemId, { finalText, turnId });
  sendNotification("turn/started", {
    threadId: PROJECT_THREAD_ID,
    turn: { id: turnId, status: "inProgress" },
  });
  sendProjectedItem(
    "item/started",
    {
      id: itemId,
      type: "agentMessage",
      text: "",
    },
    turnId,
  );
  for (let index = 1; index < boundedCount; index += 1) {
    sendNotification("item/agentMessage/delta", {
      threadId: PROJECT_THREAD_ID,
      turnId,
      itemId,
      delta: ".",
    });
  }
  sendNotification("item/agentMessage/delta", {
    threadId: PROJECT_THREAD_ID,
    turnId,
    itemId,
    delta: marker,
  });
  return itemId;
}

function completeDeltaBurst(itemId: string): void {
  const pending = pendingDeltaBursts.get(itemId);
  if (!pending) {
    throw new Error(`Unknown pending delta burst: ${itemId}`);
  }
  pendingDeltaBursts.delete(itemId);
  sendProjectedItem(
    "item/completed",
    {
      id: itemId,
      type: "agentMessage",
      text: pending.finalText,
    },
    pending.turnId,
  );
  sendNotification("turn/completed", {
    threadId: PROJECT_THREAD_ID,
    turn: { id: pending.turnId, status: "completed" },
  });
}

function emitLongTranscript(count: number, runId: number): string {
  const boundedCount = Math.max(1, Math.min(2_000, Math.floor(count)));
  for (let index = 0; index < boundedCount; index += 1) {
    sendProjectedItem(
      "item/completed",
      {
        id: `quality-long-${runId}-${index}`,
        type: index % 2 === 0 ? "userMessage" : "agentMessage",
        ...(index % 2 === 0
          ? {
              content: [
                {
                  type: "text",
                  text: `Deterministic transcript run ${runId} message ${index + 1}`,
                },
              ],
            }
          : { text: `Deterministic transcript run ${runId} message ${index + 1}` }),
      },
      null,
    );
  }
  return `quality-long-${runId}-${boundedCount - 1}`;
}

function qualityResearchRecord(
  id: string,
  opts: {
    parentResearchId?: string | null;
    prompt?: string;
    status?: ResearchRecord["status"];
    title?: string;
  } = {},
): ResearchRecord {
  const status = opts.status ?? "completed";
  const completed = status === "completed";
  return {
    id,
    workspacePath: "/quality/project",
    parentResearchId: opts.parentResearchId ?? null,
    title: opts.title ?? "Desktop quality research",
    prompt: opts.prompt ?? "Compare deterministic Electron testing strategies.",
    status,
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

function jsonRpcResult(method: string, rawParams: unknown): unknown {
  const params = asRecord(rawParams);
  switch (method) {
    case "initialize":
      return {
        protocolVersion: "0.1",
        serverInfo: { name: "cowork-quality-gate", version: "1.0.0" },
        capabilities: {},
      };
    case "thread/list":
      return { threads: [qualityThreadRecord()], total: 1 };
    case "thread/read":
      return { thread: qualityThreadRecord(), coworkSnapshot: null };
    case "thread/resume":
      return { thread: qualityThreadRecord() };
    case "research/list":
      return { research: [...researchRecords.values()] };
    case "research/get": {
      const researchId = typeof params.researchId === "string" ? params.researchId : "";
      return { research: researchRecords.get(researchId) ?? null };
    }
    case "research/start": {
      const record = qualityResearchRecord("quality-created-research", {
        prompt: typeof params.input === "string" ? params.input : undefined,
        status: "running",
        title: typeof params.title === "string" ? params.title : "Deterministic research run",
      });
      researchRecords.set(record.id, record);
      return { research: record };
    }
    case "research/subscribe": {
      const researchId = typeof params.researchId === "string" ? params.researchId : "";
      return { research: researchRecords.get(researchId) ?? null };
    }
    case "research/unsubscribe":
      return { status: "unsubscribed" };
    case "research/cancel": {
      const researchId = typeof params.researchId === "string" ? params.researchId : "";
      const existing = researchRecords.get(researchId);
      if (!existing) {
        return { research: null };
      }
      const record = { ...existing, status: "cancelled" as const, error: "cancelled" };
      researchRecords.set(researchId, record);
      return { research: record };
    }
    case "research/followup": {
      const parentResearchId =
        typeof params.parentResearchId === "string" ? params.parentResearchId : "";
      const record = qualityResearchRecord("quality-research-follow-up", {
        parentResearchId,
        prompt: typeof params.input === "string" ? params.input : undefined,
        title: typeof params.title === "string" ? params.title : "Quality audit follow-up",
      });
      researchRecords.set(record.id, record);
      return { research: record };
    }
    case "task/list":
      return { tasks: [createQualityTaskFixture()] };
    case "task/read":
      return { task: createQualityTaskFixture() };
    case "task/artifact/read":
      return { detail: createQualityTaskArtifactDetail() };
    case "task/cancel":
      metrics.taskCancellationRequests += 1;
      return { task: createQualityTaskFixture("cancelled") };
    case "turn/interrupt":
      metrics.turnInterruptRequests += 1;
      queueMicrotask(emitCancellation);
      return { status: "interrupting" };
    case "turn/steer":
      metrics.turnSteerRequests += 1;
      queueMicrotask(() => {
        sendNotification("cowork/session/steerAccepted", {
          type: "steer_accepted",
          threadId: PROJECT_THREAD_ID,
          sessionId: PROJECT_THREAD_ID,
          turnId: "quality-turn",
          text: inputText(params.input),
          ...(typeof params.clientMessageId === "string"
            ? { clientMessageId: params.clientMessageId }
            : {}),
        });
      });
      return { accepted: true };
    default:
      return {};
  }
}

async function startMockServer(): Promise<void> {
  mockServer = new WebSocketServer({
    host: "127.0.0.1",
    port: 0,
    handleProtocols: (protocols) =>
      protocols.has("cowork.jsonrpc.v1") ? "cowork.jsonrpc.v1" : false,
  });
  mockServer.on("connection", (socket) => {
    connectedSockets.add(socket);
    socket.on("close", () => {
      connectedSockets.delete(socket);
    });
    socket.on("message", (raw) => {
      let message: unknown;
      try {
        message = JSON.parse(raw.toString());
      } catch {
        socket.close(1003, "invalid_json");
        return;
      }
      if (typeof message !== "object" || message === null) {
        return;
      }
      if (
        "id" in message &&
        !("method" in message) &&
        (typeof message.id === "string" || typeof message.id === "number")
      ) {
        metrics.approvalResponses += 1;
        sendNotification("serverRequest/resolved", {
          threadId: PROJECT_THREAD_ID,
          requestId: String(message.id),
        });
        return;
      }
      if (!("method" in message) || typeof message.method !== "string") {
        return;
      }
      metrics.websocketRequests += 1;
      metrics.clientRequestsByMethod[message.method] =
        (metrics.clientRequestsByMethod[message.method] ?? 0) + 1;
      if (
        !("id" in message) ||
        (typeof message.id !== "string" && typeof message.id !== "number")
      ) {
        return;
      }
      socket.send(
        JSON.stringify({
          id: message.id,
          result: jsonRpcResult(message.method, "params" in message ? message.params : undefined),
        }),
      );
    });
  });
  await new Promise<void>((resolve, reject) => {
    mockServer?.once("listening", resolve);
    mockServer?.once("error", reject);
  });
  const address = mockServer.address();
  if (!address || typeof address === "string") {
    throw new Error("Quality-gate WebSocket server did not expose a TCP address");
  }
  mockServerUrl = `ws://127.0.0.1:${address.port}/ws`;
}

function contentType(filePath: string): string {
  switch (path.extname(filePath)) {
    case ".css":
      return "text/css; charset=utf-8";
    case ".html":
      return "text/html; charset=utf-8";
    case ".js":
      return "text/javascript; charset=utf-8";
    case ".json":
      return "application/json; charset=utf-8";
    case ".svg":
      return "image/svg+xml";
    case ".ttf":
      return "font/ttf";
    case ".wasm":
      return "application/wasm";
    default:
      return "application/octet-stream";
  }
}

async function startRendererServer(): Promise<void> {
  const rendererRoot = path.resolve(qualityGateDir, "../renderer");
  rendererServer = createServer(async (request, response) => {
    let pathname: string;
    try {
      pathname = decodeURIComponent(new URL(request.url ?? "/", "http://127.0.0.1").pathname);
    } catch {
      response.writeHead(400);
      response.end("Invalid request path");
      return;
    }
    const relativePath = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
    const filePath = path.resolve(rendererRoot, relativePath);
    if (filePath !== rendererRoot && !filePath.startsWith(`${rendererRoot}${path.sep}`)) {
      response.writeHead(403);
      response.end("Forbidden");
      return;
    }
    try {
      const file = await fs.stat(filePath);
      if (!file.isFile()) {
        throw new Error("not a file");
      }
    } catch {
      metrics.missingAssetRequests += 1;
      response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      response.end("Not found");
      return;
    }
    response.writeHead(200, {
      "Cache-Control":
        relativePath === "index.html" ? "no-store" : "public, max-age=31536000, immutable",
      "Content-Type": contentType(filePath),
    });
    const stream = createReadStream(filePath);
    stream.on("error", (error) => {
      console.error("[quality-gate-main] renderer asset stream failed", error);
      response.destroy(error);
    });
    stream.pipe(response);
  });
  await new Promise<void>((resolve, reject) => {
    rendererServer?.once("listening", resolve);
    rendererServer?.once("error", reject);
    rendererServer?.listen(0, "127.0.0.1");
  });
  const address = rendererServer.address();
  if (!address || typeof address === "string") {
    throw new Error("Quality-gate renderer server did not expose a TCP address");
  }
  rendererServerUrl = `http://127.0.0.1:${address.port}/index.html`;
}

function installNetworkGuard(): void {
  const allowedOrigins = new Set([
    new URL(rendererServerUrl).origin,
    new URL(mockServerUrl).origin,
  ]);
  session.defaultSession.webRequest.onBeforeRequest(
    { urls: ["<all_urls>"] },
    (details, callback) => {
      let allowed = false;
      try {
        const url = new URL(details.url);
        allowed = allowedOrigins.has(url.origin);
      } catch {
        allowed = false;
      }
      if (!allowed) {
        metrics.blockedRequests.push(details.url);
      }
      callback({ cancel: !allowed });
    },
  );
  lifecycle.networkGuardInstalled = ++lifecycleSequence;
}

async function verifyCaptureReady(): Promise<void> {
  if (!captureReadyFile) {
    throw new Error("Quality-gate capture readiness file was not configured");
  }
  await fs.access(captureReadyFile);
  lifecycle.captureReady = ++lifecycleSequence;
}

async function loadWindow(
  win: Electron.BrowserWindow,
  mode: "main" | "quick-chat" | "canvas",
  options?: { threadId?: string; path?: string },
): Promise<void> {
  const isMain = mode === "main";
  const query = {
    qualityMode,
    ...(mode === "main" ? {} : { window: mode }),
    ...(options?.threadId ? { threadId: options.threadId } : {}),
    ...(options?.path ? { path: options.path } : {}),
  };
  const rendererUrl = new URL(rendererServerUrl);
  rendererUrl.search = new URLSearchParams(query).toString();
  if (isMain) {
    lifecycle.firstLoadStarted = ++lifecycleSequence;
  }
  await win.loadURL(rendererUrl.toString());
  win.setContentSize(
    isMain ? contentWidth : mode === "quick-chat" ? 337 : 800,
    isMain ? contentHeight : mode === "quick-chat" ? 552 : 600,
  );
  win.show();
}

async function createWindow(
  mode: "main" | "quick-chat" | "canvas",
  options?: { threadId?: string; path?: string },
  deferLoad = false,
): Promise<Electron.BrowserWindow> {
  const isMain = mode === "main";
  const win = new BrowserWindow({
    title:
      mode === "quick-chat" ? "Cowork Quick Chat" : mode === "canvas" ? "Cowork Canvas" : "Cowork",
    width: isMain ? contentWidth : mode === "quick-chat" ? 337 : 800,
    height: isMain ? contentHeight : mode === "quick-chat" ? 552 : 600,
    useContentSize: true,
    show: false,
    frame: false,
    resizable: true,
    backgroundColor: qualityMode === "dark" ? "#1f1d1a" : "#f5f0e5",
    webPreferences: {
      preload: path.join(qualityGateDir, "../preload/preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      webviewTag: false,
      safeDialogs: true,
      devTools: false,
    },
  });

  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  win.webContents.on("will-navigate", (event, url) => {
    if (new URL(url).origin !== new URL(rendererServerUrl).origin) {
      event.preventDefault();
    }
  });
  if (isMain) {
    lifecycle.firstWindowCreated = ++lifecycleSequence;
  }
  if (!deferLoad) {
    await loadWindow(win, mode, options);
  }
  return win;
}

async function handleIpc(channel: string, input: unknown): Promise<unknown> {
  switch (channel) {
    case DESKTOP_IPC_CHANNELS.loadState:
      if (!bootstrapReleased) {
        await bootstrapBarrier;
      }
      await delay(startupDelayMs);
      return structuredClone(persistedState);
    case DESKTOP_IPC_CHANNELS.saveState:
      metrics.stateSaves += 1;
      persistedState = structuredClone(input as PersistedState);
      return undefined;
    case DESKTOP_IPC_CHANNELS.getUpdateState:
      return createDefaultUpdaterState("1.2.21", false);
    case DESKTOP_IPC_CHANNELS.getSystemAppearance:
    case DESKTOP_IPC_CHANNELS.setWindowAppearance:
      return createAppearance();
    case DESKTOP_IPC_CHANNELS.getPlatform:
      return qualityPlatform;
    case DESKTOP_IPC_CHANNELS.getPlatformChrome:
      return createPlatformChrome();
    case DESKTOP_IPC_CHANNELS.hydrateTranscript:
      return structuredClone(hydratedTranscript);
    case DESKTOP_IPC_CHANNELS.readTranscript:
      return [];
    case DESKTOP_IPC_CHANNELS.listDirectory:
      metrics.filesystemRequests += 1;
      return structuredClone(explorerEntries);
    case DESKTOP_IPC_CHANNELS.readFile:
      metrics.filesystemRequests += 1;
      return {
        content:
          "# Electron quality gates\n\nThis deterministic fixture is rendered through the shipping Canvas.",
      };
    case DESKTOP_IPC_CHANNELS.readFileForPreview: {
      metrics.filesystemRequests += 1;
      const bytes = new TextEncoder().encode(
        "# Electron quality gates\n\nThis deterministic fixture is rendered through the shipping Canvas.",
      );
      return {
        bytes,
        byteLength: bytes.byteLength,
        truncated: false,
      };
    }
    case DESKTOP_IPC_CHANNELS.confirmAction:
      metrics.confirmationRequests += 1;
      return true;
    case DESKTOP_IPC_CHANNELS.writeRendererLog:
      metrics.rendererLogEntries += 1;
      rendererLogs.push(structuredClone(input));
      return undefined;
    case DESKTOP_IPC_CHANNELS.getTelemetryStatus:
      return telemetryStatus();
    case DESKTOP_IPC_CHANNELS.createDiagnosticsBundle:
      return {
        path: path.join(userDataPath, "quality-diagnostics.json"),
        createdAt: FIXED_NOW,
        summary: "Deterministic quality-gate diagnostics",
        uploadConfigured: false,
        uploadEnabled: false,
      };
    case DESKTOP_IPC_CHANNELS.uploadDiagnosticsBundle:
      return {
        uploaded: false,
        path: path.join(userDataPath, "quality-diagnostics.json"),
        diagnosticId: null,
        url: null,
        message: "Diagnostics upload is disabled in the quality harness.",
      };
    case DESKTOP_IPC_CHANNELS.getPreferredFileApp:
    case DESKTOP_IPC_CHANNELS.pickDirectory:
    case DESKTOP_IPC_CHANNELS.pickWorkspaceDirectory:
    case DESKTOP_IPC_CHANNELS.saveExportedFile:
      return null;
    case DESKTOP_IPC_CHANNELS.showContextMenu:
      return null;
    case DESKTOP_IPC_CHANNELS.showNotification:
      return true;
    case DESKTOP_IPC_CHANNELS.createOneOffChatWorkspace:
      return { name: "Quality quick chat", path: "/quality/new-quick-chat" };
    case DESKTOP_IPC_CHANNELS.startWorkspaceServer:
      return { url: mockServerUrl };
    case DESKTOP_IPC_CHANNELS.getWorkspaceServerStatus:
      return {
        workspaceId:
          typeof input === "object" &&
          input !== null &&
          "workspaceId" in input &&
          typeof input.workspaceId === "string"
            ? input.workspaceId
            : PROJECT_WORKSPACE_ID,
        running: true,
        url: mockServerUrl,
        reason: "running",
      };
    case DESKTOP_IPC_CHANNELS.mobileRelayStart:
    case DESKTOP_IPC_CHANNELS.mobileRelayStop:
    case DESKTOP_IPC_CHANNELS.mobileRelayGetState:
    case DESKTOP_IPC_CHANNELS.mobileRelayRefreshTrustedPhones:
    case DESKTOP_IPC_CHANNELS.mobileRelayRotateSession:
    case DESKTOP_IPC_CHANNELS.mobileRelayUpdateTrustedPhonePermissions:
      return defaultMobileRelayState();
    case DESKTOP_IPC_CHANNELS.mobileRelayForgetTrustedPhone:
      metrics.mobileForgetRequests += 1;
      return {
        ...defaultMobileRelayState(),
        trustedPhoneDeviceId: null,
        trustedPhoneFingerprint: null,
        trustedPhoneDevices: [],
      };
    case DESKTOP_IPC_CHANNELS.showQuickChatWindow:
      await createWindow("quick-chat", { threadId: QUICK_THREAD_ID });
      return undefined;
    case DESKTOP_IPC_CHANNELS.showCanvasWindow:
      await createWindow("canvas", { path: "/quality/project/quality-gate-report.md" });
      return undefined;
    case DESKTOP_IPC_CHANNELS.showMainWindow:
      mainWindow?.show();
      mainWindow?.focus();
      return undefined;
    case DESKTOP_IPC_CHANNELS.windowMaximize:
      mainWindow?.maximize();
      return undefined;
    case DESKTOP_IPC_CHANNELS.windowMinimize:
      mainWindow?.minimize();
      return undefined;
    case DESKTOP_IPC_CHANNELS.windowClose:
      return undefined;
    default:
      return undefined;
  }
}

for (const channel of Object.values(DESKTOP_IPC_CHANNELS)) {
  ipcMain.handle(channel, async (_event, input: unknown) => await handleIpc(channel, input));
}

process.on("uncaughtException", (error) => {
  console.error("[quality-gate-main] uncaught exception", error);
  app.exit(1);
});
process.on("unhandledRejection", (error) => {
  console.error("[quality-gate-main] unhandled rejection", error);
  app.exit(1);
});

void app.whenReady().then(async () => {
  await startRendererServer();
  await startMockServer();
  installNetworkGuard();
  await verifyCaptureReady();
  mainWindow = await createWindow("main", undefined, true);
  await loadWindow(mainWindow, "main");
});

app.on("window-all-closed", () => {
  app.quit();
});

app.on("before-quit", () => {
  mockServer?.close();
  mockServer = null;
  rendererServer?.close();
  rendererServer = null;
});
