import { createRequire } from "node:module";

import type { ProgressInfo, UpdateDownloadedEvent, UpdateInfo } from "electron-updater";

import { createDefaultUpdaterState, type UpdaterReleaseInfo, type UpdaterState } from "../../src/lib/desktopApi";
import { applyUpdaterPlatformDefaults } from "./updaterPlatform";

const AUTOMATIC_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
const STARTUP_CHECK_DELAY_MS = 10 * 1000;
const RELEASE_NOTES_URL = "https://github.com/mweinbach/agent-coworker/releases/latest";
const UNAVAILABLE_RELEASE_FEED_MESSAGE = "Updates are unavailable for this platform because no update feed is published.";
const require = createRequire(import.meta.url);

type UpdaterEventHandler = (...args: any[]) => void;

export interface UpdaterClient {
  autoDownload: boolean;
  autoInstallOnAppQuit: boolean;
  allowPrerelease: boolean;
  disableDifferentialDownload?: boolean;
  channel?: string | null;
  on(event: string, handler: UpdaterEventHandler): this;
  checkForUpdates(): Promise<unknown>;
  quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): void;
}

function isUpdaterClient(value: unknown): value is UpdaterClient {
  if (!value || typeof value !== "object") {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.on === "function" &&
    typeof candidate.checkForUpdates === "function" &&
    typeof candidate.quitAndInstall === "function"
  );
}

function resolveAutoUpdaterClient(moduleValue: unknown): UpdaterClient {
  if (!moduleValue || typeof moduleValue !== "object") {
    throw new Error("electron-updater module did not expose an autoUpdater client");
  }

  const record = moduleValue as Record<string, unknown>;
  const directClient = record.autoUpdater;
  if (isUpdaterClient(directClient)) {
    return directClient;
  }

  const defaultExport = record.default;
  if (defaultExport && typeof defaultExport === "object") {
    const nestedClient = (defaultExport as Record<string, unknown>).autoUpdater;
    if (isUpdaterClient(nestedClient)) {
      return nestedClient;
    }
  }

  throw new Error("electron-updater autoUpdater export was not found");
}

let cachedDefaultUpdater: UpdaterClient | null = null;

function getDefaultUpdaterClient(): UpdaterClient {
  if (cachedDefaultUpdater) {
    return cachedDefaultUpdater;
  }
  cachedDefaultUpdater = resolveAutoUpdaterClient(require("electron-updater"));
  return cachedDefaultUpdater;
}

type DesktopUpdaterServiceOptions = {
  currentVersion: string;
  isPackaged: boolean;
  onStateChange?: (state: UpdaterState) => void;
  notifyUpdateReady?: (state: UpdaterState) => void;
  updater?: UpdaterClient;
  platform?: NodeJS.Platform;
  arch?: string;
  now?: () => string;
  setIntervalFn?: typeof setInterval;
  clearIntervalFn?: typeof clearInterval;
  setTimeoutFn?: typeof setTimeout;
  clearTimeoutFn?: typeof clearTimeout;
};

function toMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function isMissingReleaseFeedMessage(message: string): boolean {
  const normalized = message.toLowerCase();
  return /latest(?:-[a-z0-9-]+)?\.yml/.test(normalized) && (normalized.includes("404") || normalized.includes("cannot find"));
}

function normalizeReleaseNotes(value: unknown): string | undefined {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed || undefined;
  }
  if (!Array.isArray(value)) {
    return undefined;
  }

  const parts = value
    .map((entry) => {
      if (!entry || typeof entry !== "object") {
        return null;
      }
      const record = entry as Record<string, unknown>;
      const versionValue = record.version;
      const noteValue = record.note;
      const version = typeof versionValue === "string"
        ? versionValue.trim()
        : "";
      const note = typeof noteValue === "string"
        ? noteValue.trim()
        : "";
      const merged = [version ? `${version}:` : "", note].filter(Boolean).join(" ");
      return merged || null;
    })
    .filter((entry): entry is string => Boolean(entry));

  return parts.length > 0 ? parts.join("\n\n") : undefined;
}

function normalizeReleaseInfo(info: Partial<UpdateInfo> | UpdateDownloadedEvent | null | undefined): UpdaterReleaseInfo | null {
  const version = typeof info?.version === "string" ? info.version.trim() : "";
  if (!version) {
    return null;
  }

  return {
    version,
    releaseName: typeof info?.releaseName === "string" && info.releaseName.trim() ? info.releaseName.trim() : undefined,
    releaseDate: typeof info?.releaseDate === "string" && info.releaseDate.trim() ? info.releaseDate.trim() : undefined,
    releaseNotes: normalizeReleaseNotes(info?.releaseNotes),
    releasePageUrl: RELEASE_NOTES_URL,
  };
}

function normalizeProgress(progress: ProgressInfo): UpdaterState["progress"] {
  const finite = (value: number) => (Number.isFinite(value) ? value : 0);
  return {
    percent: Math.max(0, Math.min(100, finite(progress.percent))),
    transferred: Math.max(0, finite(progress.transferred)),
    total: Math.max(0, finite(progress.total)),
    bytesPerSecond: Math.max(0, finite(progress.bytesPerSecond)),
  };
}

export class DesktopUpdaterService {
  private readonly currentVersion: string;
  private readonly isPackaged: boolean;
  private readonly onStateChange?: (state: UpdaterState) => void;
  private readonly notifyUpdateReady?: (state: UpdaterState) => void;
  private readonly updater: UpdaterClient;
  private readonly platform: NodeJS.Platform;
  private readonly arch: string;
  private readonly now: () => string;
  private readonly setIntervalFn: typeof setInterval;
  private readonly clearIntervalFn: typeof clearInterval;
  private readonly setTimeoutFn: typeof setTimeout;
  private readonly clearTimeoutFn: typeof clearTimeout;

  private intervalHandle: ReturnType<typeof setInterval> | null = null;
  private startupHandle: ReturnType<typeof setTimeout> | null = null;
  private started = false;
  private state: UpdaterState;

  constructor(options: DesktopUpdaterServiceOptions) {
    this.currentVersion = options.currentVersion;
    this.isPackaged = options.isPackaged;
    this.onStateChange = options.onStateChange;
    this.notifyUpdateReady = options.notifyUpdateReady;
    this.updater = options.updater ?? getDefaultUpdaterClient();
    this.platform = options.platform ?? process.platform;
    this.arch = options.arch ?? process.arch;
    this.now = options.now ?? (() => new Date().toISOString());
    this.setIntervalFn = options.setIntervalFn ?? setInterval;
    this.clearIntervalFn = options.clearIntervalFn ?? clearInterval;
    this.setTimeoutFn = options.setTimeoutFn ?? setTimeout;
    this.clearTimeoutFn = options.clearTimeoutFn ?? clearTimeout;
    this.state = createDefaultUpdaterState(this.currentVersion, this.isPackaged);

    if (this.isPackaged) {
      this.updater.autoDownload = true;
      this.updater.autoInstallOnAppQuit = false;
      this.updater.allowPrerelease = false;
      applyUpdaterPlatformDefaults(this.updater, this.platform, this.arch);
      this.registerListeners();
    }
  }

  start(): void {
    if (!this.isPackaged || this.started) {
      return;
    }
    this.started = true;
    this.startupHandle = this.setTimeoutFn(() => {
      void this.checkForUpdates();
    }, STARTUP_CHECK_DELAY_MS);
    this.intervalHandle = this.setIntervalFn(() => {
      void this.checkForUpdates();
    }, AUTOMATIC_CHECK_INTERVAL_MS);
  }

  dispose(): void {
    if (this.startupHandle) {
      this.clearTimeoutFn(this.startupHandle);
      this.startupHandle = null;
    }
    if (this.intervalHandle) {
      this.clearIntervalFn(this.intervalHandle);
      this.intervalHandle = null;
    }
  }

  getState(): UpdaterState {
    return { ...this.state, progress: this.state.progress ? { ...this.state.progress } : null, release: this.state.release ? { ...this.state.release } : null };
  }

  async checkForUpdates(): Promise<void> {
    if (!this.isPackaged) {
      this.setState({
        ...createDefaultUpdaterState(this.currentVersion, false),
      });
      return;
    }

    if (this.state.phase === "checking" || this.state.phase === "downloading") {
      return;
    }

    this.setState({
      phase: "checking",
      lastCheckStartedAt: this.now(),
      message: "Checking for updates…",
      error: null,
      progress: null,
    });

    try {
      await this.updater.checkForUpdates();
    } catch (error) {
      const message = toMessage(error);
      if (isMissingReleaseFeedMessage(message)) {
        console.warn(`[desktop] Auto updater feed unavailable: ${message}`);
        this.setState({
          phase: "disabled",
          lastCheckedAt: this.now(),
          message: UNAVAILABLE_RELEASE_FEED_MESSAGE,
          error: null,
          progress: null,
          release: null,
          downloadedAt: null,
        });
        return;
      }

      console.warn(`[desktop] Auto updater check failed: ${message}`);
      this.setState({
        phase: "error",
        lastCheckedAt: this.now(),
        message: "Unable to check for updates.",
        error: message,
        progress: null,
      });
    }
  }

  quitAndInstall(): void {
    if (!this.isPackaged || this.state.phase !== "downloaded") {
      return;
    }
    this.updater.quitAndInstall(false, true);
  }

  private registerListeners(): void {
    this.updater.on("checking-for-update", () => {
      this.setState({
        phase: "checking",
        lastCheckStartedAt: this.state.lastCheckStartedAt ?? this.now(),
        message: "Checking for updates…",
        error: null,
        progress: null,
      });
    });

    this.updater.on("update-available", (info: UpdateInfo) => {
      const release = normalizeReleaseInfo(info);
      this.setState({
        phase: "available",
        lastCheckedAt: this.now(),
        message: release ? `Update ${release.version} is available. Downloading now…` : "Update available. Downloading now…",
        error: null,
        release,
        progress: null,
        downloadedAt: null,
      });
    });

    this.updater.on("update-not-available", () => {
      this.setState({
        phase: "up-to-date",
        lastCheckedAt: this.now(),
        message: "Cowork is up to date.",
        error: null,
        progress: null,
        release: null,
        downloadedAt: null,
      });
    });

    this.updater.on("download-progress", (progress: ProgressInfo) => {
      this.setState({
        phase: "downloading",
        lastCheckedAt: this.now(),
        message: this.state.release
          ? `Downloading ${this.state.release.version}…`
          : "Downloading update…",
        error: null,
        progress: normalizeProgress(progress),
      });
    });

    this.updater.on("update-downloaded", (info: UpdateDownloadedEvent) => {
      const release = normalizeReleaseInfo(info) ?? this.state.release;
      const nextState = {
        phase: "downloaded" as const,
        lastCheckedAt: this.now(),
        downloadedAt: this.now(),
        message: release ? `Restart Cowork to install ${release.version}.` : "Restart Cowork to install the update.",
        error: null,
        progress: {
          percent: 100,
          transferred: this.state.progress?.total ?? 0,
          total: this.state.progress?.total ?? 0,
          bytesPerSecond: 0,
        },
        release,
      };
      this.setState(nextState);
      this.notifyUpdateReady?.(this.getState());
    });

    this.updater.on("error", (error: unknown) => {
      const message = toMessage(error);
      if (isMissingReleaseFeedMessage(message)) {
        console.warn(`[desktop] Auto updater feed unavailable: ${message}`);
        this.setState({
          phase: "disabled",
          lastCheckedAt: this.now(),
          message: UNAVAILABLE_RELEASE_FEED_MESSAGE,
          error: null,
          progress: null,
          release: null,
          downloadedAt: null,
        });
        return;
      }

      console.warn(`[desktop] Auto updater error: ${message}`);
      this.setState({
        phase: "error",
        lastCheckedAt: this.now(),
        message: "Unable to check for updates.",
        error: message,
        progress: null,
      });
    });
  }

  private setState(patch: Partial<UpdaterState>): void {
    this.state = {
      ...this.state,
      ...patch,
      currentVersion: this.currentVersion,
      packaged: this.isPackaged,
    };
    this.onStateChange?.(this.getState());
  }
}

export const __internal = {
  getDefaultUpdaterClient,
  isMissingReleaseFeedMessage,
  resolveAutoUpdaterClient,
};
