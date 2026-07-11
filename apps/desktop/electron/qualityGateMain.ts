import { createReadStream, promises as fs } from "node:fs";
import { createServer, type Server as HttpServer } from "node:http";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type * as Electron from "electron";
import type * as Ws from "ws";
import { hostPlatform } from "../../../src/platform/host";
import type { ResearchRecord } from "../../../src/server/research/types";
import type {
  CanvasDocumentRevision,
  CanvasDocumentSnapshot,
} from "../../../src/shared/canvasDocument";
import {
  createQualityTaskArtifactDetail,
  createQualityTaskFixture,
  PROJECT_THREAD_ID,
} from "../quality-gates/fixtureData";
import type { PersistedState } from "../src/app/types";
import {
  getCanvasCaptionSymbolTone,
  getCanvasNativeBackgroundColor,
} from "../src/lib/canvasAppearance";
import {
  createDefaultUpdaterState,
  DESKTOP_EVENT_CHANNELS,
  DESKTOP_IPC_CHANNELS,
  type ExplorerEntry,
  type PlatformChromeInfo,
  type SystemAppearance,
} from "../src/lib/desktopApi";
import { NATIVE_THEME_TOKENS } from "../src/styles/tokens/native";
import {
  applySystemAppearanceToWindow,
  registerWindowAppearanceProfile,
} from "./services/appearance";
import { desktopShellBackgroundColor } from "./services/windowAppearancePaint";
import { getPlatformChrome } from "./services/windowChrome/platformChrome";

const nodeRequire = createRequire(import.meta.url);
const { app, BrowserWindow, ipcMain, nativeTheme, session } = nodeRequire(
  "electron",
) as typeof Electron;
const { WebSocket, WebSocketServer } = nodeRequire("ws") as typeof Ws;
const qualityGateDir = path.dirname(fileURLToPath(import.meta.url));
const FIXED_NOW = "2026-07-09T12:00:00.000Z";
const PROJECT_WORKSPACE_ID = "quality-project";
const QUICK_WORKSPACE_ID = "quality-quick";
const QUICK_THREAD_ID = "quality-quick-thread";
const qualityPlatform = hostPlatform();
const EXTERNAL_NETWORK_PROOF_URL = "https://example.invalid/quality-gate-network-proof";
const PRESENTATION_SLIDE_DATA_URL = `data:image/svg+xml;base64,${Buffer.from(
  `<svg xmlns="http://www.w3.org/2000/svg" width="960" height="540"><rect width="960" height="540" fill="${NATIVE_THEME_TOKENS.canvasDocument.light.background}"/><text x="80" y="190" fill="${NATIVE_THEME_TOKENS.canvasDocument.light.foreground}" font-family="sans-serif" font-size="56" font-weight="700">Canvas presentation</text><text x="80" y="270" fill="${NATIVE_THEME_TOKENS.canvasDocument.light.mutedForeground}" font-family="sans-serif" font-size="28">Theme-aware Electron preview</text></svg>`,
).toString("base64")}`;

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

type QualityDeltaBurstPath = "legacy-chunk" | "legacy-raw" | "projected";

type QualityDeltaBurstDescriptor = {
  count: number;
  expectedText: string;
  itemId: string;
  lookupPrefix: string;
  path: QualityDeltaBurstPath;
  runId: number;
};

type QualityMainControl = {
  completeDeltaBurst(itemId: string): void;
  emitCompletion(): void;
  emitDeltaBurst(
    count: number,
    runId: number,
    path: QualityDeltaBurstPath,
  ): QualityDeltaBurstDescriptor;
  emitFileChange(runId: number): void;
  emitInteractionQueue(): void;
  emitLongTranscript(count: number, runId: number): string;
  emitStreamingActivity(): void;
  getExternalNetworkProofUrl(): string;
  getLifecycle(): QualityLifecycle;
  getMetrics(): QualityMainMetrics;
  getDeltaBurstProgress(itemId: string): { count: number; emitted: number };
  getRendererLogs(): unknown[];
  openCanvas(path: string): Promise<void>;
  releaseBootstrap(): void;
  resetMetrics(): void;
  setTheme(theme: "light" | "dark"): void;
};

declare global {
  var __coworkQualityGateMain: QualityMainControl | undefined;
}

let qualityMode = parseQualityMode(process.env.COWORK_QUALITY_MODE);
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
nativeTheme.themeSource = qualityMode === "dark" ? "dark" : "light";
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
let explorerRevision = 0;
const researchRecords = new Map<string, ResearchRecord>();
const canvasDocumentSessions = new Map<string, CanvasDocumentSnapshot>();
const connectedSockets = new Set<Ws.WebSocket>();
const pendingDeltaBursts = new Map<
  string,
  {
    descriptor: QualityDeltaBurstDescriptor;
    emitted: number;
    streamId: string;
    timer: ReturnType<typeof setTimeout> | null;
    turnId: string;
  }
>();
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
  emitDeltaBurst: (count, runId, path) => emitDeltaBurst(count, runId, path),
  emitFileChange: (runId) => {
    explorerRevision = runId;
    mainWindow?.webContents.send(DESKTOP_EVENT_CHANNELS.workspaceFileChanged, {
      workspaceId: PROJECT_WORKSPACE_ID,
      rootPath: "/quality/project",
      kind: "modify",
      changedPaths: ["/quality/project/fixture-0002.ts"],
      affectedDirectoryPaths: ["/quality/project"],
      invalidatedSubtreePaths: [],
    });
  },
  emitInteractionQueue: () => {
    emitInteractionQueue();
  },
  emitLongTranscript: (count, runId) => emitLongTranscript(count, runId),
  emitStreamingActivity: () => {
    emitStreamingActivity();
  },
  getExternalNetworkProofUrl: () => EXTERNAL_NETWORK_PROOF_URL,
  getLifecycle: () => ({ ...lifecycle }),
  getMetrics: () => structuredClone(metrics),
  getDeltaBurstProgress: (itemId) => {
    const pending = pendingDeltaBursts.get(itemId);
    if (!pending) {
      throw new Error(`Unknown pending delta burst: ${itemId}`);
    }
    return { count: pending.descriptor.count, emitted: pending.emitted };
  },
  getRendererLogs: () => structuredClone(rendererLogs),
  openCanvas: async (path) => {
    await createWindow("canvas", { path });
  },
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
  setTheme: (theme) => {
    setQualityTheme(theme);
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

function setQualityTheme(theme: "light" | "dark"): void {
  qualityMode = theme;
  nativeTheme.themeSource = theme;
  const appearance = createAppearance();
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) {
      continue;
    }
    applySystemAppearanceToWindow(win, appearance);
    win.webContents.send(DESKTOP_EVENT_CHANNELS.systemAppearanceChanged, appearance);
  }
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

function createExplorerEntries(revision = 0): ExplorerEntry[] {
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
      sizeBytes: 512 + index + (index === 1 ? revision : 0),
      modifiedAtMs: Date.parse(FIXED_NOW),
    };
  });
}

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
  const activeBurst = pendingDeltaBursts.values().next().value;
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
    status: activeBurst ? { type: "running", turnId: activeBurst.turnId } : { type: "idle" },
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

function emitInteractionQueue(): void {
  sendServerMessage({
    id: "quality-ask-theme",
    method: "item/tool/requestUserInput",
    params: {
      threadId: PROJECT_THREAD_ID,
      question: "Which theme should the release walkthrough use?",
      options: ["Light", "Dark"],
    },
  });
  sendServerMessage({
    id: "quality-approval-docs",
    method: "item/commandExecution/requestApproval",
    params: {
      threadId: PROJECT_THREAD_ID,
      command: "bun run docs:check",
      dangerous: false,
      reason: "requires_manual_review",
    },
  });
  sendServerMessage({
    id: "quality-ask-reviewer",
    method: "item/tool/requestUserInput",
    params: {
      threadId: PROJECT_THREAD_ID,
      question: "Who should review the release notes?",
    },
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

function deltaBurstToken(path: QualityDeltaBurstPath, runId: number, index: number): string {
  return `[${path}:${runId}:${String(index).padStart(4, "0")}]`;
}

function sendLegacyStreamEvent(
  path: Exclude<QualityDeltaBurstPath, "projected">,
  event: Record<string, unknown>,
): void {
  sendNotification(path === "legacy-chunk" ? "model_stream_chunk" : "model_stream_raw", {
    threadId: PROJECT_THREAD_ID,
    ...event,
  });
}

function emitNextDeltaBurstBatch(itemId: string): void {
  const pending = pendingDeltaBursts.get(itemId);
  if (!pending || pending.emitted >= pending.descriptor.count) {
    if (pending) pending.timer = null;
    return;
  }
  const batchEnd = Math.min(pending.emitted + 2, pending.descriptor.count);
  while (pending.emitted < batchEnd) {
    const index = pending.emitted;
    const delta = deltaBurstToken(pending.descriptor.path, pending.descriptor.runId, index);
    if (pending.descriptor.path === "projected") {
      sendNotification("item/agentMessage/delta", {
        threadId: PROJECT_THREAD_ID,
        turnId: pending.turnId,
        itemId,
        delta,
      });
    } else if (pending.descriptor.path === "legacy-chunk") {
      sendLegacyStreamEvent("legacy-chunk", {
        type: "model_stream_chunk",
        sessionId: PROJECT_THREAD_ID,
        turnId: pending.turnId,
        index: index + 1,
        provider: "openai",
        model: "gpt-5.2",
        normalizerVersion: 1,
        partType: "text_delta",
        part: { id: pending.streamId, text: delta },
      });
    } else {
      sendLegacyStreamEvent("legacy-raw", {
        type: "model_stream_raw",
        sessionId: PROJECT_THREAD_ID,
        turnId: pending.turnId,
        index: index + 2,
        provider: "codex-cli",
        model: "gpt-5.4",
        format: "openai-responses-v1",
        normalizerVersion: 1,
        event: {
          type: "response.output_text.delta",
          output_index: 0,
          content_index: 0,
          item_id: pending.streamId,
          delta,
        },
      });
    }
    pending.emitted += 1;
  }
  pending.timer =
    pending.emitted < pending.descriptor.count
      ? setTimeout(() => emitNextDeltaBurstBatch(itemId), 8)
      : null;
}

function emitDeltaBurst(
  count: number,
  runId: number,
  path: QualityDeltaBurstPath,
): QualityDeltaBurstDescriptor {
  const boundedCount = Math.max(1, Math.min(10_000, Math.floor(count)));
  const itemId = `quality-delta-${path}-${runId}`;
  const turnId = `quality-performance-turn-${path}-${runId}`;
  const streamId = `quality-performance-stream-${path}-${runId}`;
  const expectedText = Array.from({ length: boundedCount }, (_, index) =>
    deltaBurstToken(path, runId, index),
  ).join("");
  const descriptor: QualityDeltaBurstDescriptor = {
    count: boundedCount,
    expectedText,
    itemId,
    lookupPrefix: deltaBurstToken(path, runId, 0),
    path,
    runId,
  };
  pendingDeltaBursts.set(itemId, {
    descriptor,
    emitted: 0,
    streamId,
    timer: null,
    turnId,
  });
  sendNotification("turn/started", {
    threadId: PROJECT_THREAD_ID,
    turn: { id: turnId, status: "inProgress" },
  });
  if (path === "projected") {
    sendProjectedItem(
      "item/started",
      {
        id: itemId,
        type: "agentMessage",
        text: "",
      },
      turnId,
    );
  } else if (path === "legacy-chunk") {
    sendLegacyStreamEvent("legacy-chunk", {
      type: "model_stream_chunk",
      sessionId: PROJECT_THREAD_ID,
      turnId,
      index: 0,
      provider: "openai",
      model: "gpt-5.2",
      normalizerVersion: 1,
      partType: "text_start",
      part: { id: streamId },
    });
  } else {
    sendLegacyStreamEvent("legacy-raw", {
      type: "model_stream_raw",
      sessionId: PROJECT_THREAD_ID,
      turnId,
      index: 0,
      provider: "codex-cli",
      model: "gpt-5.4",
      format: "openai-responses-v1",
      normalizerVersion: 1,
      event: {
        type: "response.output_item.added",
        output_index: 0,
        item: { id: streamId, type: "message", role: "assistant", content: [] },
      },
    });
    sendLegacyStreamEvent("legacy-raw", {
      type: "model_stream_raw",
      sessionId: PROJECT_THREAD_ID,
      turnId,
      index: 1,
      provider: "codex-cli",
      model: "gpt-5.4",
      format: "openai-responses-v1",
      normalizerVersion: 1,
      event: {
        type: "response.content_part.added",
        output_index: 0,
        content_index: 0,
        item_id: streamId,
        part: { type: "output_text", text: "", annotations: [] },
      },
    });
  }
  const pending = pendingDeltaBursts.get(itemId);
  if (pending) {
    pending.timer = setTimeout(() => emitNextDeltaBurstBatch(itemId), 0);
  }
  return descriptor;
}

function completeDeltaBurst(itemId: string): void {
  const pending = pendingDeltaBursts.get(itemId);
  if (!pending) {
    throw new Error(`Unknown pending delta burst: ${itemId}`);
  }
  if (pending.emitted !== pending.descriptor.count) {
    throw new Error(
      `Delta burst ${itemId} is incomplete (${pending.emitted}/${pending.descriptor.count})`,
    );
  }
  pendingDeltaBursts.delete(itemId);
  if (pending.descriptor.path === "projected") {
    sendProjectedItem(
      "item/completed",
      {
        id: itemId,
        type: "agentMessage",
        text: pending.descriptor.expectedText,
      },
      pending.turnId,
    );
  } else if (pending.descriptor.path === "legacy-chunk") {
    sendLegacyStreamEvent("legacy-chunk", {
      type: "model_stream_chunk",
      sessionId: PROJECT_THREAD_ID,
      turnId: pending.turnId,
      index: pending.descriptor.count + 1,
      provider: "openai",
      model: "gpt-5.2",
      normalizerVersion: 1,
      partType: "text_end",
      part: { id: pending.streamId },
    });
  } else {
    sendLegacyStreamEvent("legacy-raw", {
      type: "model_stream_raw",
      sessionId: PROJECT_THREAD_ID,
      turnId: pending.turnId,
      index: pending.descriptor.count + 2,
      provider: "codex-cli",
      model: "gpt-5.4",
      format: "openai-responses-v1",
      normalizerVersion: 1,
      event: {
        type: "response.output_text.done",
        output_index: 0,
        content_index: 0,
        item_id: pending.streamId,
        text: pending.descriptor.expectedText,
      },
    });
  }
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

function canvasDocumentSessionKey(documentId: string, generation: number): string {
  return `${documentId}:${generation}`;
}

function qualityCanvasRevision(content: string): CanvasDocumentRevision {
  return {
    modifiedAtMs: Date.parse(FIXED_NOW),
    changeTimeMs: Date.parse(FIXED_NOW),
    size: new TextEncoder().encode(content).byteLength,
    fingerprint: `quality:${content.length}`,
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
    case "cowork/workspace/document/open": {
      const filePath =
        typeof params.path === "string" ? params.path : "/quality/project/quality-gate-report.md";
      if (filePath.endsWith("/canvas-error.md")) {
        return {
          ok: false,
          documentId:
            typeof params.documentId === "string" ? params.documentId : "quality-document-error",
          generation: typeof params.generation === "number" ? params.generation : 1,
          path: filePath,
          error: {
            kind: "read_error",
            message: "Quality fixture could not read this document.",
          },
        };
      }
      const isMarkdown = filePath.toLowerCase().endsWith(".md");
      const content = isMarkdown
        ? "# Electron Canvas\n\nSemantic surfaces stay readable while the system theme changes."
        : "Electron Canvas\n\nTheme-aware plain text editor";
      const documentId =
        typeof params.documentId === "string" ? params.documentId : "quality-document";
      const generation = typeof params.generation === "number" ? params.generation : 1;
      const document: CanvasDocumentSnapshot = {
        documentId,
        generation,
        path: filePath,
        content,
        truncated: false,
        revision: {
          modifiedAtMs: Date.parse(FIXED_NOW),
          changeTimeMs: Date.parse(FIXED_NOW),
          size: content.length,
          fingerprint: `sha256:${path.basename(filePath)}`,
        },
      };
      canvasDocumentSessions.set(canvasDocumentSessionKey(documentId, generation), document);
      return { ok: true, document };
    }
    case "cowork/workspace/document/revision": {
      const documentId = typeof params.documentId === "string" ? params.documentId : "";
      const generation = typeof params.generation === "number" ? params.generation : 0;
      const document = canvasDocumentSessions.get(canvasDocumentSessionKey(documentId, generation));
      return document
        ? {
            ok: true,
            documentId,
            generation,
            path: document.path,
            revision: document.revision,
          }
        : {
            ok: false,
            documentId,
            generation,
            error: {
              kind: "session_not_found",
              message: "Quality-gate Canvas session was not found.",
            },
          };
    }
    case "cowork/workspace/document/save":
    case "cowork/workspace/document/saveAs": {
      const documentId = typeof params.documentId === "string" ? params.documentId : "";
      const generation = typeof params.generation === "number" ? params.generation : 0;
      const key = canvasDocumentSessionKey(documentId, generation);
      const current = canvasDocumentSessions.get(key);
      const content = typeof params.content === "string" ? params.content : "";
      const editRevision = typeof params.editRevision === "number" ? params.editRevision : 0;
      if (!current) {
        return {
          ok: false,
          documentId,
          generation,
          editRevision,
          error: {
            kind: "session_not_found",
            message: "Quality-gate Canvas session was not found.",
          },
        };
      }
      const next = {
        ...current,
        path: typeof params.path === "string" ? params.path : current.path,
        content,
        revision: qualityCanvasRevision(content),
      };
      canvasDocumentSessions.set(key, next);
      return {
        ok: true,
        documentId,
        generation,
        editRevision,
        path: next.path,
        revision: next.revision,
        status: "saved",
      };
    }
    case "cowork/workspace/document/close": {
      const documentId = typeof params.documentId === "string" ? params.documentId : "";
      const generation = typeof params.generation === "number" ? params.generation : 0;
      canvasDocumentSessions.delete(canvasDocumentSessionKey(documentId, generation));
      return { ok: true, documentId, generation };
    }
    case "cowork/workspace/spreadsheet/workbook": {
      const filePath =
        typeof params.path === "string" ? params.path : "/quality/project/report.csv";
      const filename = path.basename(filePath);
      return {
        ok: true,
        workbook: {
          kind: filePath.toLowerCase().endsWith(".xlsx") ? "xlsx" : "csv",
          path: filePath,
          filename,
          fileVersion: {
            modifiedAtMs: Date.parse(FIXED_NOW),
            changeTimeMs: Date.parse(FIXED_NOW),
            size: 128,
            fingerprint: "sha256:quality-spreadsheet",
          },
          sheets: [
            {
              id: "quality-sheet",
              name: "Summary",
              rowCount: 4,
              colCount: 3,
              cells: [
                { row: 0, col: 0, address: "A1", value: "Metric", rawValue: "Metric" },
                { row: 0, col: 1, address: "B1", value: "Light", rawValue: "Light" },
                { row: 0, col: 2, address: "C1", value: "Dark", rawValue: "Dark" },
                { row: 1, col: 0, address: "A2", value: "Contrast", rawValue: "Contrast" },
                { row: 1, col: 1, address: "B2", value: "13.6", rawValue: 13.6 },
                { row: 1, col: 2, address: "C2", value: "12.9", rawValue: 12.9 },
              ],
              mergedCells: [],
              columnWidths: [
                { col: 0, widthPx: 180 },
                { col: 1, widthPx: 120 },
                { col: 2, widthPx: 120 },
              ],
              tables: [],
              charts: [],
            },
          ],
          activeSheetName: "Summary",
          warnings: [],
        },
      };
    }
    case "cowork/workspace/spreadsheet/version":
      return {
        ok: true,
        version: {
          modifiedAtMs: Date.parse(FIXED_NOW),
          changeTimeMs: Date.parse(FIXED_NOW),
          size: 128,
          fingerprint: "sha256:quality-spreadsheet",
        },
      };
    case "cowork/workspace/presentation/preview":
      return {
        ok: true,
        slides: [
          {
            slideIndex: 0,
            slideId: "quality-slide-1",
            title: "Canvas presentation",
            pngBase64: PRESENTATION_SLIDE_DATA_URL,
          },
        ],
      };
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
    case "turn/steer": {
      metrics.turnSteerRequests += 1;
      const steerRequestId =
        typeof params.clientMessageId === "string"
          ? `quality-steer:${params.clientMessageId}`
          : `quality-steer:${crypto.randomUUID()}`;
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
          steerRequestId,
        });
      });
      return { turnId: "quality-turn", steerRequestId };
    }
    default:
      return {};
  }
}

function shouldHoldCanvasLoadingResponse(method: string, rawParams: unknown): boolean {
  if (method !== "cowork/workspace/document/open") {
    return false;
  }
  return asRecord(rawParams).path === "/quality/project/canvas-loading.md";
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
      const params = "params" in message ? message.params : undefined;
      if (shouldHoldCanvasLoadingResponse(message.method, params)) {
        return;
      }
      socket.send(
        JSON.stringify({
          id: message.id,
          result: jsonRpcResult(message.method, params),
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
  const backgroundColor =
    mode === "canvas"
      ? getCanvasNativeBackgroundColor(options?.path ?? "", qualityMode === "dark")
      : desktopShellBackgroundColor(qualityMode === "dark");
  const win = new BrowserWindow({
    title:
      mode === "quick-chat" ? "Cowork Quick Chat" : mode === "canvas" ? "Cowork Canvas" : "Cowork",
    width: isMain ? contentWidth : mode === "quick-chat" ? 337 : 800,
    height: isMain ? contentHeight : mode === "quick-chat" ? 552 : 600,
    useContentSize: true,
    show: false,
    frame: false,
    resizable: true,
    backgroundColor,
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

  if (mode === "canvas") {
    const canvasPath = options?.path ?? "";
    registerWindowAppearanceProfile(win, {
      backgroundColor: (useDarkColors) => getCanvasNativeBackgroundColor(canvasPath, useDarkColors),
      captionSymbolTone: (useDarkColors) => getCanvasCaptionSymbolTone(canvasPath, useDarkColors),
      useMacosNativeGlass: false,
      ...(qualityPlatform === "win32" ? { backgroundMaterial: "none" } : {}),
    });
    applySystemAppearanceToWindow(win, createAppearance());
  }

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

async function handleIpc(
  channel: string,
  input: unknown,
  sourceWindow: Electron.BrowserWindow | null,
): Promise<unknown> {
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
      return createExplorerEntries(explorerRevision);
    case DESKTOP_IPC_CHANNELS.watchWorkspaceDirectory:
      return true;
    case DESKTOP_IPC_CHANNELS.unwatchWorkspaceDirectory:
      return undefined;
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
    case DESKTOP_IPC_CHANNELS.pickCanvasSavePath:
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
    case DESKTOP_IPC_CHANNELS.showCanvasWindow: {
      const params = asRecord(input);
      const canvasPath =
        typeof params.path === "string" ? params.path : "/quality/project/quality-gate-report.md";
      await createWindow("canvas", { path: canvasPath });
      return undefined;
    }
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
      sourceWindow?.close();
      return undefined;
    default:
      return undefined;
  }
}

for (const channel of Object.values(DESKTOP_IPC_CHANNELS)) {
  ipcMain.handle(
    channel,
    async (event, input: unknown) =>
      await handleIpc(channel, input, BrowserWindow.fromWebContents(event.sender)),
  );
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
