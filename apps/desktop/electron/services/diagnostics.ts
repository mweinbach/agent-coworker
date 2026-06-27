import fs from "node:fs/promises";
import path from "node:path";

import { app, shell } from "electron";

import {
  type DiagnosticsRedactionContext,
  redactDiagnosticText,
  sanitizeLogMeta,
} from "../../../../src/diagnostics/redaction";
import { isNetworkTelemetryGloballyDisabled } from "../../../../src/telemetry/config";
import { getRecentCrashReportIds } from "../../../../src/telemetry/crashReporting";
import { normalizePrivacyTelemetrySettings, type PersistedState } from "../../src/app/types";
import type {
  CreateDiagnosticsBundleOutput,
  UploadDiagnosticsBundleOutput,
} from "../../src/lib/desktopApi";
import { getLocalLogPath, getLogsDir, logError, logInfo, logWarn, tailLog } from "./localLogs";
import type { PersistenceService } from "./persistence";
import type { DesktopUpdaterService } from "./updater";
import {
  readWindowsSandboxReadiness,
  type WindowsSandboxReadiness,
} from "./windowsSandboxReadiness";

const DIAGNOSTICS_DIR_NAME = "diagnostics";
const DIAGNOSTICS_FILE_PREFIX = "cowork-diagnostics-";
const LOG_TAIL_BYTES = 64 * 1024;
const MAX_BUNDLE_BYTES = 5 * 1024 * 1024;

type DiagnosticsServiceOptions = {
  persistence: PersistenceService;
  updater: DesktopUpdaterService;
  env?: NodeJS.ProcessEnv;
  now?: () => Date;
  fetchImpl?: typeof fetch;
  appVersion?: () => string;
  isPackaged?: () => boolean;
  platform?: NodeJS.Platform;
  arch?: string;
};

type DiagnosticsBundle = {
  schemaVersion: 1;
  createdAt: string;
  app: {
    version: string;
    platform: NodeJS.Platform;
    arch: string;
    packaged: boolean;
  };
  toggles: ReturnType<typeof normalizePrivacyTelemetrySettings>;
  featureFlagOverrides: unknown;
  counts: {
    workspaceCount: number;
    threadCount: number;
  };
  crashReports: {
    enabled: boolean;
    recentReportIds: string[];
  };
  observabilityHealth: {
    status: "unavailable";
    reason: "not_collected_by_desktop";
  };
  updateState: unknown;
  windowsSandbox: WindowsSandboxReadiness | { state: "not-applicable" } | null;
  logs: Partial<Record<"server.log" | "desktop-main.log" | "updater.log" | "renderer.log", string>>;
};

function timestampForFile(date: Date): string {
  return date.toISOString().replace(/[:.]/g, "-");
}

function isPathInside(root: string, target: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  return Boolean(relative) && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function readUploadUrl(env: NodeJS.ProcessEnv): string | null {
  if (isNetworkTelemetryGloballyDisabled(env)) return null;
  const raw = env.COWORK_DIAGNOSTICS_UPLOAD_URL?.trim();
  if (!raw) return null;
  try {
    const parsed = new URL(raw);
    return parsed.protocol === "https:" || parsed.protocol === "http:" ? parsed.toString() : null;
  } catch {
    return null;
  }
}

function sanitizeLogTail(tail: string, context: DiagnosticsRedactionContext): string {
  return tail
    .split(/\r?\n/)
    .map((line) => redactDiagnosticText(line, { ...context, maxStringLength: 4096 }))
    .join("\n")
    .trim();
}

function buildSummary(input: {
  createdAt: string;
  appVersion: string;
  platform: NodeJS.Platform;
  arch: string;
  packaged: boolean;
  workspaceCount: number;
  threadCount: number;
  uploadConfigured: boolean;
  uploadEnabled: boolean;
  includedLogs: string[];
}): string {
  const upload = input.uploadConfigured
    ? input.uploadEnabled
      ? "configured and allowed"
      : "configured but disabled"
    : "not configured";
  return [
    "Cowork diagnostics bundle",
    `Created: ${input.createdAt}`,
    `Version: ${input.appVersion}`,
    `Platform: ${input.platform}/${input.arch}`,
    `Packaged: ${input.packaged ? "yes" : "no"}`,
    `Workspaces: ${input.workspaceCount}`,
    `Threads: ${input.threadCount}`,
    `Upload: ${upload}`,
    `Logs: ${input.includedLogs.length > 0 ? input.includedLogs.join(", ") : "none"}`,
  ].join("\n");
}

function extractUploadResult(value: unknown): { id: string | null; url: string | null } {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { id: null, url: null };
  }
  const record = value as Record<string, unknown>;
  const id =
    typeof record.diagnosticId === "string"
      ? record.diagnosticId
      : typeof record.id === "string"
        ? record.id
        : null;
  const url = typeof record.url === "string" ? record.url : null;
  return {
    id: id?.trim() || null,
    url: url?.trim() || null,
  };
}

export class DiagnosticsService {
  private readonly persistence: PersistenceService;
  private readonly updater: DesktopUpdaterService;
  private readonly env: NodeJS.ProcessEnv;
  private readonly now: () => Date;
  private readonly fetchImpl: typeof fetch;
  private readonly appVersion: () => string;
  private readonly isPackaged: () => boolean;
  private readonly platform: NodeJS.Platform;
  private readonly arch: string;

  constructor(options: DiagnosticsServiceOptions) {
    this.persistence = options.persistence;
    this.updater = options.updater;
    this.env = options.env ?? process.env;
    this.now = options.now ?? (() => new Date());
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.appVersion = options.appVersion ?? (() => app.getVersion().trim() || "unknown");
    this.isPackaged = options.isPackaged ?? (() => app.isPackaged);
    this.platform = options.platform ?? process.platform;
    this.arch = options.arch ?? process.arch;
  }

  getDiagnosticsDir(): string {
    return path.join(app.getPath("userData"), DIAGNOSTICS_DIR_NAME);
  }

  async createBundle(): Promise<CreateDiagnosticsBundleOutput> {
    const state = await this.persistence.loadState();
    const createdAt = this.now().toISOString();
    const settings = normalizePrivacyTelemetrySettings(state.privacyTelemetrySettings);
    const uploadEnabled =
      !isNetworkTelemetryGloballyDisabled(this.env) && settings.diagnosticsUploadEnabled;
    const uploadConfigured = Boolean(readUploadUrl(this.env));
    const context = this.buildRedactionContext(state);
    const logs = await this.collectLogTails(context);
    const includedLogs = Object.keys(logs).sort();
    const bundle: DiagnosticsBundle = {
      schemaVersion: 1,
      createdAt,
      app: {
        version: this.appVersion(),
        platform: this.platform,
        arch: this.arch,
        packaged: this.isPackaged(),
      },
      toggles: settings,
      featureFlagOverrides: sanitizeLogMeta(state.desktopFeatureFlagOverrides ?? {}, context),
      counts: {
        workspaceCount: state.workspaces.length,
        threadCount: state.threads.length,
      },
      crashReports: {
        enabled: settings.crashReportsEnabled,
        recentReportIds: getRecentCrashReportIds(),
      },
      observabilityHealth: {
        status: "unavailable",
        reason: "not_collected_by_desktop",
      },
      updateState: sanitizeLogMeta(this.updater.getState(), context),
      windowsSandbox:
        this.platform === "win32"
          ? await readWindowsSandboxReadiness(app.getPath("userData"))
          : { state: "not-applicable" },
      logs,
    };

    const diagnosticsDir = this.getDiagnosticsDir();
    await fs.mkdir(diagnosticsDir, { recursive: true, mode: 0o700 });
    const bundlePath = path.join(
      diagnosticsDir,
      `${DIAGNOSTICS_FILE_PREFIX}${timestampForFile(new Date(createdAt))}.json`,
    );
    const payload = JSON.stringify(bundle, null, 2);
    await fs.writeFile(bundlePath, payload, { encoding: "utf8", mode: 0o600 });

    const summary = buildSummary({
      createdAt,
      appVersion: bundle.app.version,
      platform: bundle.app.platform,
      arch: bundle.app.arch,
      packaged: bundle.app.packaged,
      workspaceCount: bundle.counts.workspaceCount,
      threadCount: bundle.counts.threadCount,
      uploadConfigured,
      uploadEnabled,
      includedLogs,
    });
    logInfo("diagnostics", "created diagnostics bundle", {
      uploadConfigured,
      uploadEnabled,
      workspaceCount: bundle.counts.workspaceCount,
      threadCount: bundle.counts.threadCount,
      includedLogs,
    });
    return {
      path: bundlePath,
      createdAt,
      summary,
      uploadConfigured,
      uploadEnabled,
    };
  }

  async revealBundle(bundlePath: string): Promise<void> {
    shell.showItemInFolder(await this.resolveBundlePath(bundlePath));
  }

  async openLogsFolder(): Promise<void> {
    const logsDir = getLogsDir();
    await fs.mkdir(logsDir, { recursive: true, mode: 0o700 });
    const result = await shell.openPath(logsDir);
    if (result) {
      throw new Error(result);
    }
  }

  async uploadBundle(
    bundlePath: string,
    confirmed: boolean,
  ): Promise<UploadDiagnosticsBundleOutput> {
    const safeBundlePath = await this.resolveBundlePath(bundlePath);
    const state = await this.persistence.loadState();
    const settings = normalizePrivacyTelemetrySettings(state.privacyTelemetrySettings);
    if (isNetworkTelemetryGloballyDisabled(this.env)) {
      throw new Error("Diagnostic log uploads are disabled by COWORK_DISABLE_NETWORK_TELEMETRY.");
    }
    if (!settings.diagnosticsUploadEnabled) {
      throw new Error("Diagnostic log uploads are disabled.");
    }
    if (!confirmed) {
      throw new Error("Diagnostic upload requires explicit confirmation.");
    }

    const endpoint = readUploadUrl(this.env);
    if (!endpoint) {
      logWarn("diagnostics", "diagnostics upload skipped because no endpoint is configured");
      return {
        uploaded: false,
        path: safeBundlePath,
        diagnosticId: null,
        url: null,
        message: "No diagnostics upload endpoint is configured. The local bundle is ready.",
      };
    }

    const stat = await fs.stat(safeBundlePath);
    if (!stat.isFile()) {
      throw new Error("Diagnostics bundle path is not a file.");
    }
    if (stat.size > MAX_BUNDLE_BYTES) {
      throw new Error("Diagnostics bundle is too large to upload.");
    }

    const payload = await fs.readFile(safeBundlePath, "utf8");
    try {
      const response = await this.fetchImpl(endpoint, {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: payload,
      });
      if (!response.ok) {
        throw new Error(`Diagnostics upload failed with HTTP ${response.status}.`);
      }
      const resultText = await response.text();
      let parsed: unknown = null;
      if (resultText.trim()) {
        try {
          parsed = JSON.parse(resultText);
        } catch {
          parsed = null;
        }
      }
      const uploadResult = extractUploadResult(parsed);
      logInfo("diagnostics", "uploaded diagnostics bundle", {
        diagnosticId: uploadResult.id,
        hasUrl: Boolean(uploadResult.url),
      });
      return {
        uploaded: true,
        path: safeBundlePath,
        diagnosticId: uploadResult.id,
        url: uploadResult.url,
        message: uploadResult.url ?? uploadResult.id ?? "Diagnostics bundle uploaded.",
      };
    } catch (error) {
      logError("diagnostics", error, { operation: "upload" });
      throw error;
    }
  }

  private buildRedactionContext(state: PersistedState): DiagnosticsRedactionContext {
    return {
      homeDir: app.getPath("home"),
      workspacePaths: state.workspaces.map((workspace) => workspace.path),
      maxStringLength: 64 * 1024,
    };
  }

  private async collectLogTails(
    context: DiagnosticsRedactionContext,
  ): Promise<DiagnosticsBundle["logs"]> {
    const logs: DiagnosticsBundle["logs"] = {};
    for (const fileName of [
      "server.log",
      "desktop-main.log",
      "updater.log",
      "renderer.log",
    ] as const) {
      const tail = await tailLog(getLocalLogPath(fileName), LOG_TAIL_BYTES);
      if (!tail.trim()) continue;
      logs[fileName] = sanitizeLogTail(tail, context);
    }
    return logs;
  }

  private async resolveBundlePath(bundlePath: string): Promise<string> {
    const diagnosticsDir = this.getDiagnosticsDir();
    const resolved = path.resolve(bundlePath);
    if (!isPathInside(diagnosticsDir, resolved)) {
      throw new Error("Diagnostics bundle must be inside the diagnostics folder.");
    }
    if (
      !path.basename(resolved).startsWith(DIAGNOSTICS_FILE_PREFIX) ||
      path.extname(resolved) !== ".json"
    ) {
      throw new Error("Invalid diagnostics bundle path.");
    }
    const stat = await fs.stat(resolved);
    if (!stat.isFile()) {
      throw new Error("Diagnostics bundle path is not a file.");
    }
    return resolved;
  }
}

export const __internal = {
  DIAGNOSTICS_FILE_PREFIX,
  buildSummary,
  extractUploadResult,
  readUploadUrl,
  sanitizeLogTail,
};
