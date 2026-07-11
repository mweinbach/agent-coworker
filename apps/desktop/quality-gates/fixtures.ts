import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { test as base, _electron as electron, expect } from "@playwright/test";
import electronPath from "electron";
import type { ElectronApplication, Page, TestInfo } from "playwright";
import { hostPlatform } from "../../../src/platform/host";

export type QualityMode = "light" | "dark" | "system" | "reduced-motion" | "forced-colors";
export type QualityScenario = "first-launch" | "product";
export type QualityDeltaBurstPath = "legacy-chunk" | "legacy-raw" | "projected";

export type QualityDeltaBurstDescriptor = {
  count: number;
  expectedText: string;
  itemId: string;
  lookupPrefix: string;
  path: QualityDeltaBurstPath;
  runId: number;
};

export type QualityLaunchOptions = {
  appearanceDelayMs?: number;
  height: number;
  holdBootstrap?: boolean;
  mode: QualityMode;
  reconnectDelayMs?: number;
  scenario: QualityScenario;
  startupFailureCount?: number;
  startupDelayMs: number;
  width: number;
};

type QualityMainMetrics = {
  approvalResponses: number;
  blockedRequests: string[];
  clientRequestsByMethod: Record<string, number>;
  confirmationRequests: number;
  diagnosticBundles: number;
  diagnosticCopies: number;
  diagnosticReveals: number;
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

export type QualityHarness = {
  completeDeltaBurst(itemId: string): Promise<void>;
  electronApp: ElectronApplication;
  emitCompletion(): Promise<void>;
  emitDeltaBurst(
    count: number,
    runId: number,
    path: QualityDeltaBurstPath,
  ): Promise<QualityDeltaBurstDescriptor>;
  emitInteractionQueue(): Promise<void>;
  emitLongTranscript(count: number, runId: number): Promise<string>;
  emitStreamingActivity(): Promise<void>;
  getExternalNetworkProofUrl(): Promise<string>;
  getDeltaBurstProgress(itemId: string): Promise<{ count: number; emitted: number }>;
  getLifecycle(): Promise<QualityLifecycle>;
  getMainMetrics(): Promise<QualityMainMetrics>;
  openWindow(trigger: () => Promise<void>): Promise<Page>;
  page: Page;
  releaseBootstrap(): Promise<void>;
};

type QualityFixtures = {
  quality: QualityHarness;
  qualityOptions: QualityLaunchOptions;
};

type ScreenRecorder = {
  child: ChildProcessWithoutNullStreams;
  getStderr(): string;
  path: string;
};

const qualityGateRoot = path.dirname(fileURLToPath(import.meta.url));
const desktopRoot = path.resolve(qualityGateRoot, "..");
const repoRoot = path.resolve(desktopRoot, "../..");
const mainEntry = path.join(desktopRoot, "out-quality/main/qualityGateMain.js");
const ignoredRendererWarnings = [
  "Electron Security Warning (Insecure Content-Security-Policy)",
  "Autofocus processing was blocked",
  "Deterministic quality-gate renderer crash.",
];
const credentialEnvironmentName =
  /(?:API_KEY|API_TOKEN|ACCESS_KEY|ACCESS_TOKEN|AUTH_TOKEN|BEARER_TOKEN|PASSWORD|SECRET|SESSION_TOKEN)$/;
const tracingOptions = {
  screenshots: true,
  snapshots: false,
  sources: false,
} as const;
const fixedRendererNow = Date.parse("2026-07-09T21:00:00.000Z");
const externalNetworkProofUrl = "https://example.invalid/quality-gate-network-proof";
const blockedRequestConsoleError =
  "[renderer:error] Failed to load resource: net::ERR_BLOCKED_BY_CLIENT";
const expectedStartupFailureMessage = "Quality fixture could not restore the saved workspace.";

function processEnvironment(overrides: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (value !== undefined && !credentialEnvironmentName.test(name)) {
      env[name] = value;
    }
  }
  return { ...env, ...overrides };
}

function qualityColorScheme(mode: QualityMode): "light" | "dark" {
  return mode === "dark" || mode === "system" ? "dark" : "light";
}

function isLoopbackWebSocket(url: string): boolean {
  try {
    const parsed = new URL(url);
    return (
      (parsed.protocol === "ws:" || parsed.protocol === "wss:") &&
      (parsed.hostname === "127.0.0.1" ||
        parsed.hostname === "localhost" ||
        parsed.hostname === "::1")
    );
  } catch {
    return false;
  }
}

async function attachIfPresent(testInfo: TestInfo, name: string, filePath: string): Promise<void> {
  try {
    await fs.access(filePath);
    await testInfo.attach(name, { path: filePath });
  } catch {
    // A process may fail before an artifact is initialized. Other diagnostics remain attached.
  }
}

async function startScreenRecorder(
  runtimeDir: string,
  options: QualityLaunchOptions,
): Promise<ScreenRecorder> {
  if (hostPlatform() !== "linux") {
    throw new Error(
      "Electron quality-gate diagnostic recording is Linux-only; run the pinned CI container",
    );
  }
  const display = process.env.DISPLAY?.trim();
  if (!display) {
    throw new Error("Electron quality gates require DISPLAY for diagnostic video capture");
  }

  const videoPath = path.join(runtimeDir, "quality-gate.webm");
  const child = spawn(
    "ffmpeg",
    [
      "-hide_banner",
      "-loglevel",
      "error",
      "-y",
      "-f",
      "x11grab",
      "-draw_mouse",
      "0",
      "-framerate",
      "15",
      "-video_size",
      `${options.width}x${options.height}`,
      "-i",
      `${display}+0,0`,
      "-an",
      "-c:v",
      "libvpx-vp9",
      "-deadline",
      "realtime",
      "-cpu-used",
      "8",
      "-pix_fmt",
      "yuv420p",
      videoPath,
    ],
    {
      cwd: repoRoot,
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });
  await new Promise<void>((resolve, reject) => {
    child.once("spawn", resolve);
    child.once("error", reject);
  });
  await new Promise<void>((resolve) => setTimeout(resolve, 200));
  if (child.exitCode !== null) {
    throw new Error(`ffmpeg screen recorder exited early (${child.exitCode}): ${stderr.trim()}`);
  }
  return {
    child,
    getStderr: () => stderr,
    path: videoPath,
  };
}

async function stopScreenRecorder(recorder: ScreenRecorder): Promise<void> {
  if (recorder.child.exitCode === null) {
    const exited = new Promise<void>((resolve) => {
      recorder.child.once("exit", () => resolve());
    });
    recorder.child.stdin.end("q\n");
    await Promise.race([
      exited,
      new Promise<void>((resolve) => {
        setTimeout(resolve, 3_000);
      }),
    ]);
    if (recorder.child.exitCode === null) {
      recorder.child.kill("SIGTERM");
      await exited;
    }
  }
  if (recorder.child.exitCode !== 0) {
    throw new Error(
      `ffmpeg screen recorder exited with ${recorder.child.exitCode}: ${recorder
        .getStderr()
        .trim()}`,
    );
  }
}

async function launchQualityHarness(
  options: QualityLaunchOptions,
  testInfo: TestInfo,
): Promise<{
  errors: string[];
  harness: QualityHarness;
  mainLogs: string[];
  pages: Page[];
  recorder: ScreenRecorder;
  runtimeDir: string;
  userDataDir: string;
}> {
  const runtimeDir = testInfo.outputPath("runtime");
  const userDataDir = testInfo.outputPath("user-data");
  await fs.mkdir(runtimeDir, { recursive: true });

  const errors: string[] = [];
  const mainLogs: string[] = [];
  const pages: Page[] = [];
  const recorder = await startScreenRecorder(runtimeDir, options);
  const captureReadyPath = path.join(runtimeDir, "capture-ready");
  await fs.writeFile(captureReadyPath, "recorder-ready\n", "utf8");
  const launchArgs = [mainEntry, "--disable-dev-shm-usage", "--disable-gpu"];
  if (typeof process.geteuid === "function" && process.geteuid() === 0) {
    launchArgs.push("--no-sandbox");
  }
  let electronApp: ElectronApplication;
  try {
    electronApp = await electron.launch({
      executablePath: electronPath,
      args: launchArgs,
      cwd: repoRoot,
      artifactsDir: runtimeDir,
      tracesDir: runtimeDir,
      colorScheme: qualityColorScheme(options.mode),
      forcedColors: options.mode === "forced-colors" ? "active" : "none",
      locale: "en-US",
      reducedMotion: options.mode === "reduced-motion" ? "reduce" : "no-preference",
      timezoneId: "UTC",
      env: processEnvironment({
        COWORK_QUALITY_CAPTURE_READY_FILE: captureReadyPath,
        COWORK_QUALITY_APPEARANCE_DELAY_MS: String(options.appearanceDelayMs ?? 0),
        COWORK_QUALITY_HEIGHT: String(options.height),
        COWORK_QUALITY_HOLD_BOOTSTRAP: options.holdBootstrap ? "1" : "0",
        COWORK_QUALITY_MODE: options.mode,
        COWORK_QUALITY_RECONNECT_DELAY_MS: String(options.reconnectDelayMs ?? 0),
        COWORK_QUALITY_SCENARIO: options.scenario,
        COWORK_QUALITY_STARTUP_FAILURES: String(options.startupFailureCount ?? 0),
        COWORK_QUALITY_STARTUP_DELAY_MS: String(options.startupDelayMs),
        COWORK_QUALITY_USER_DATA: userDataDir,
        COWORK_QUALITY_WIDTH: String(options.width),
        LANG: "en_US.UTF-8",
        LC_ALL: "en_US.UTF-8",
        TZ: "UTC",
      }),
    });
  } catch (error) {
    await stopScreenRecorder(recorder);
    throw error;
  }

  electronApp.on("console", (message) => {
    const entry = `[main:${message.type()}] ${message.text()}`;
    mainLogs.push(entry);
    if (message.type() === "error") {
      errors.push(entry);
    }
  });

  const configurePage = (page: Page): void => {
    if (pages.includes(page)) {
      return;
    }
    pages.push(page);
    page.on("console", (message) => {
      const text = message.text();
      const entry = `[renderer:${message.type()}] ${text}`;
      mainLogs.push(entry);
      if (
        message.type() === "error" &&
        !ignoredRendererWarnings.some((allowed) => text.includes(allowed))
      ) {
        errors.push(entry);
      }
    });
    page.on("pageerror", (error) => {
      errors.push(`[renderer:pageerror] ${error.stack ?? error.message}`);
    });
    page.on("requestfailed", (request) => {
      const failure = request.failure()?.errorText ?? "unknown failure";
      if (request.url() !== externalNetworkProofUrl) {
        errors.push(`[renderer:requestfailed] ${failure}: ${request.url()}`);
      }
    });
    page.on("websocket", (socket) => {
      if (!isLoopbackWebSocket(socket.url())) {
        errors.push(`[renderer:websocket] External WebSocket blocked: ${socket.url()}`);
      }
    });
  };

  electronApp.on("window", (page) => {
    configurePage(page);
  });
  const context = electronApp.context();
  await context.addInitScript((now) => {
    const NativeDate = Date;
    class FixedDate extends NativeDate {
      constructor(...args: ConstructorParameters<DateConstructor>) {
        if (args.length === 0) {
          super(now);
          return;
        }
        super(...args);
      }

      static override now(): number {
        return now;
      }
    }
    Object.defineProperty(globalThis, "Date", {
      configurable: true,
      value: FixedDate,
      writable: true,
    });
  }, fixedRendererNow);
  context.on("request", (request) => {
    const url = request.url();
    const parsed = new URL(url);
    if (
      (parsed.protocol === "http:" || parsed.protocol === "https:") &&
      parsed.hostname !== "127.0.0.1" &&
      parsed.hostname !== "localhost" &&
      parsed.hostname !== "::1" &&
      url !== externalNetworkProofUrl
    ) {
      errors.push(`[renderer:network] External request detected: ${url}`);
    }
  });
  await context.tracing.start(tracingOptions);
  const page = await electronApp.firstWindow();
  configurePage(page);
  await page.waitForURL((url) => url.protocol === "http:");
  try {
    await page.waitForFunction(() => Boolean(window.__coworkQualityGate));
  } catch (error) {
    throw new Error(
      `Quality renderer did not install its runtime:\n${mainLogs.join("\n") || "(no logs captured)"}`,
      { cause: error },
    );
  }
  if (!options.holdBootstrap) {
    await electronApp.evaluate(() => {
      globalThis.__coworkQualityGateMain?.releaseBootstrap();
    });
  }
  await page.emulateMedia({
    colorScheme: qualityColorScheme(options.mode),
    forcedColors: options.mode === "forced-colors" ? "active" : "none",
    reducedMotion: options.mode === "reduced-motion" ? "reduce" : "no-preference",
  });
  await page.addStyleTag({
    content: `
      *, *::before, *::after {
        animation-delay: 0s !important;
        animation-duration: 0s !important;
        caret-color: transparent !important;
        transition-delay: 0s !important;
        transition-duration: 0s !important;
      }
      html { scroll-behavior: auto !important; }
    `,
  });
  await page.evaluate(async () => {
    await document.fonts.ready;
  });
  await page.waitForLoadState("networkidle");
  if (!options.holdBootstrap && !options.startupFailureCount) {
    await page.waitForFunction(() => window.__coworkQualityGate?.isReady() === true);
  }
  const viewport = await page.evaluate(() => ({
    height: window.innerHeight,
    width: window.innerWidth,
  }));
  if (viewport.width !== options.width || viewport.height !== options.height) {
    const contentSize = await electronApp.evaluate(({ BrowserWindow }) => {
      const [width, height] = BrowserWindow.getAllWindows()[0]?.getContentSize() ?? [0, 0];
      return { height, width };
    });
    throw new Error(
      `Electron quality-gate viewport is ${viewport.width}x${viewport.height} with ${contentSize.width}x${contentSize.height} content bounds; expected ${options.width}x${options.height}`,
    );
  }
  const observedLifecycle = await electronApp.evaluate(() => {
    const control = globalThis.__coworkQualityGateMain;
    if (!control) {
      throw new Error("Quality-gate main lifecycle is unavailable");
    }
    return control.getLifecycle();
  });
  if (
    !(
      observedLifecycle.networkGuardInstalled < observedLifecycle.captureReady &&
      observedLifecycle.captureReady < observedLifecycle.firstWindowCreated &&
      observedLifecycle.firstWindowCreated < observedLifecycle.firstLoadStarted
    )
  ) {
    throw new Error(`Invalid first-load lifecycle ordering: ${JSON.stringify(observedLifecycle)}`);
  }

  return {
    errors,
    mainLogs,
    pages,
    recorder,
    runtimeDir,
    userDataDir,
    harness: {
      completeDeltaBurst: async (itemId) => {
        await electronApp.evaluate((_electron, id) => {
          const control = globalThis.__coworkQualityGateMain;
          if (!control) {
            throw new Error("Quality-gate main control is unavailable");
          }
          control.completeDeltaBurst(id);
        }, itemId);
      },
      electronApp,
      emitCompletion: async () => {
        await electronApp.evaluate(() => {
          globalThis.__coworkQualityGateMain?.emitCompletion();
        });
      },
      emitDeltaBurst: async (count, runId, path) =>
        await electronApp.evaluate(
          (_electron, input) => {
            const control = globalThis.__coworkQualityGateMain;
            if (!control) {
              throw new Error("Quality-gate main control is unavailable");
            }
            return control.emitDeltaBurst(input.count, input.runId, input.path);
          },
          { count, path, runId },
        ),
      emitInteractionQueue: async () => {
        await electronApp.evaluate(() => {
          globalThis.__coworkQualityGateMain?.emitInteractionQueue();
        });
      },
      emitLongTranscript: async (count, runId) =>
        await electronApp.evaluate(
          (_electron, input) => {
            const control = globalThis.__coworkQualityGateMain;
            if (!control) {
              throw new Error("Quality-gate main control is unavailable");
            }
            return control.emitLongTranscript(input.count, input.runId);
          },
          { count, runId },
        ),
      emitStreamingActivity: async () => {
        await electronApp.evaluate(() => {
          globalThis.__coworkQualityGateMain?.emitStreamingActivity();
        });
      },
      getExternalNetworkProofUrl: async () =>
        await electronApp.evaluate(() => {
          const control = globalThis.__coworkQualityGateMain;
          if (!control) {
            throw new Error("Quality-gate main control is unavailable");
          }
          return control.getExternalNetworkProofUrl();
        }),
      getDeltaBurstProgress: async (itemId) =>
        await electronApp.evaluate((_electron, id) => {
          const control = globalThis.__coworkQualityGateMain;
          if (!control) {
            throw new Error("Quality-gate main control is unavailable");
          }
          return control.getDeltaBurstProgress(id);
        }, itemId),
      getLifecycle: async () =>
        await electronApp.evaluate(() => {
          const control = globalThis.__coworkQualityGateMain;
          if (!control) {
            throw new Error("Quality-gate main control is unavailable");
          }
          return control.getLifecycle();
        }),
      page,
      getMainMetrics: async () =>
        await electronApp.evaluate(() => {
          const control = globalThis.__coworkQualityGateMain;
          if (!control) {
            throw new Error("Quality-gate main metrics are unavailable");
          }
          return control.getMetrics();
        }),
      openWindow: async (trigger) => {
        const nextWindow = electronApp.waitForEvent("window");
        await trigger();
        const window = await nextWindow;
        configurePage(window);
        await window.waitForFunction(() => Boolean(window.__coworkQualityGate));
        return window;
      },
      releaseBootstrap: async () => {
        await electronApp.evaluate(() => {
          globalThis.__coworkQualityGateMain?.releaseBootstrap();
        });
      },
    },
  };
}

export const test = base.extend<QualityFixtures>({
  qualityOptions: [
    {
      height: 820,
      mode: "light",
      scenario: "product",
      startupDelayMs: 0,
      width: 1_240,
    },
    { option: true },
  ],
  quality: async ({ qualityOptions }, use, testInfo) => {
    const { errors, harness, mainLogs, pages, recorder, runtimeDir, userDataDir } =
      await launchQualityHarness(qualityOptions, testInfo);
    await use(harness);

    let rendererLogs: unknown[] = [];
    let mainMetrics: QualityMainMetrics | null = null;
    try {
      rendererLogs = await harness.electronApp.evaluate(
        () => globalThis.__coworkQualityGateMain?.getRendererLogs() ?? [],
      );
      mainMetrics = await harness.getMainMetrics();
      if (mainMetrics.missingAssetRequests > 0) {
        errors.push(
          `[renderer:assets] ${mainMetrics.missingAssetRequests} built renderer asset request(s) returned 404`,
        );
      }
    } catch (error) {
      errors.push(`[main:evaluate] ${error instanceof Error ? error.message : String(error)}`);
    }

    const tracePath = path.join(runtimeDir, "trace.zip");
    for (const [index, page] of pages.entries()) {
      if (!page.isClosed()) {
        await page
          .screenshot({
            path: path.join(runtimeDir, `failure-window-${index + 1}.png`),
          })
          .catch(() => {});
      }
    }
    await harness.electronApp
      .context()
      .tracing.stop({ path: tracePath })
      .catch((error) => {
        errors.push(`[trace] ${error instanceof Error ? error.message : String(error)}`);
      });

    await stopScreenRecorder(recorder).catch((error) => {
      errors.push(`[video] ${error instanceof Error ? error.message : String(error)}`);
    });
    await harness.electronApp.close().catch((error) => {
      errors.push(`[electron:close] ${error instanceof Error ? error.message : String(error)}`);
    });

    let ignoredBlockedRequestConsoleError = false;
    const effectiveErrors = errors.filter((entry) => {
      if (qualityOptions.startupFailureCount && entry.includes(expectedStartupFailureMessage)) {
        return false;
      }
      if (
        !ignoredBlockedRequestConsoleError &&
        entry === blockedRequestConsoleError &&
        mainMetrics?.blockedRequests.includes(externalNetworkProofUrl)
      ) {
        ignoredBlockedRequestConsoleError = true;
        return false;
      }
      return true;
    });
    const keepArtifacts =
      effectiveErrors.length > 0 ||
      testInfo.status !== testInfo.expectedStatus ||
      testInfo.retry > 0;
    if (keepArtifacts) {
      const diagnostics = {
        errors: effectiveErrors,
        mainLogs,
        mainMetrics,
        rendererLogs,
        test: testInfo.titlePath,
      };
      const diagnosticsPath = path.join(runtimeDir, "diagnostics.json");
      await fs.writeFile(diagnosticsPath, `${JSON.stringify(diagnostics, null, 2)}\n`, "utf8");
      await attachIfPresent(testInfo, "quality-gate-diagnostics", diagnosticsPath);
      await attachIfPresent(testInfo, "quality-gate-trace", tracePath);
      await attachIfPresent(testInfo, "quality-gate-video", recorder.path);
      for (const [index] of pages.entries()) {
        await attachIfPresent(
          testInfo,
          `quality-gate-failure-window-${index + 1}`,
          path.join(runtimeDir, `failure-window-${index + 1}.png`),
        );
      }
    }
    await Promise.all([
      fs.rm(runtimeDir, { force: true, recursive: true }),
      fs.rm(userDataDir, { force: true, recursive: true }),
    ]);

    expect(effectiveErrors, "Electron emitted unexpected main/renderer/network errors").toEqual([]);
  },
});

export { expect };
