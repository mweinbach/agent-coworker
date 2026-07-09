import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { test as base, _electron as electron, expect } from "@playwright/test";
import electronPath from "electron";
import type { ElectronApplication, Page, TestInfo } from "playwright";

export type QualityMode = "light" | "dark" | "reduced-motion" | "forced-colors";
export type QualityScenario = "first-launch" | "product";

export type QualityLaunchOptions = {
  height: number;
  mode: QualityMode;
  scenario: QualityScenario;
  startupDelayMs: number;
  width: number;
};

type QualityMainMetrics = {
  confirmationRequests: number;
  filesystemRequests: number;
  mobileForgetRequests: number;
  rendererLogEntries: number;
  stateSaves: number;
  websocketRequests: number;
};

export type QualityHarness = {
  electronApp: ElectronApplication;
  getMainMetrics(): Promise<QualityMainMetrics>;
  openWindow(trigger: () => Promise<void>): Promise<Page>;
  page: Page;
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
const mainEntry = path.join(desktopRoot, "out/main/qualityGateMain.js");
const ignoredRendererWarnings = [
  "Electron Security Warning (Insecure Content-Security-Policy)",
  "Autofocus processing was blocked",
];
const credentialEnvironmentName =
  /(?:API_KEY|API_TOKEN|ACCESS_KEY|ACCESS_TOKEN|AUTH_TOKEN|BEARER_TOKEN|PASSWORD|SECRET|SESSION_TOKEN)$/;
const tracingOptions = {
  screenshots: true,
  snapshots: false,
  sources: false,
} as const;
const fixedRendererNow = Date.parse("2026-07-09T21:00:00.000Z");

function processEnvironment(overrides: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (value !== undefined && !credentialEnvironmentName.test(name)) {
      env[name] = value;
    }
  }
  return { ...env, ...overrides };
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
}> {
  const runtimeDir = testInfo.outputPath("runtime");
  const userDataDir = testInfo.outputPath("user-data");
  await fs.mkdir(runtimeDir, { recursive: true });

  const errors: string[] = [];
  const mainLogs: string[] = [];
  const pages: Page[] = [];
  const electronApp = await electron.launch({
    executablePath: electronPath,
    args: [mainEntry, "--disable-dev-shm-usage", "--disable-gpu"],
    cwd: repoRoot,
    artifactsDir: runtimeDir,
    tracesDir: runtimeDir,
    colorScheme: options.mode === "dark" ? "dark" : "light",
    locale: "en-US",
    timezoneId: "UTC",
    env: processEnvironment({
      COWORK_QUALITY_HEIGHT: String(options.height),
      COWORK_QUALITY_MODE: options.mode,
      COWORK_QUALITY_SCENARIO: options.scenario,
      COWORK_QUALITY_STARTUP_DELAY_MS: String(options.startupDelayMs),
      COWORK_QUALITY_USER_DATA: userDataDir,
      COWORK_QUALITY_WIDTH: String(options.width),
      LANG: "en_US.UTF-8",
      LC_ALL: "en_US.UTF-8",
      TZ: "UTC",
    }),
  });

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
      errors.push(`[renderer:requestfailed] ${failure}: ${request.url()}`);
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
      parsed.hostname !== "::1"
    ) {
      errors.push(`[renderer:network] External request detected: ${url}`);
    }
  });
  const page = await electronApp.firstWindow();
  configurePage(page);
  await page.waitForFunction(() => Boolean(window.__coworkQualityGate));
  await page.emulateMedia({
    colorScheme: options.mode === "dark" ? "dark" : "light",
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
  await context.tracing.start(tracingOptions);
  const recorder = await startScreenRecorder(runtimeDir, options);

  return {
    errors,
    mainLogs,
    pages,
    recorder,
    runtimeDir,
    harness: {
      electronApp,
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
        await context.tracing.stop();
        const nextWindow = electronApp.waitForEvent("window");
        await trigger();
        const window = await nextWindow;
        configurePage(window);
        await window.waitForFunction(() => Boolean(window.__coworkQualityGate));
        await context.tracing.start(tracingOptions);
        return window;
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
    const { errors, harness, mainLogs, pages, recorder, runtimeDir } = await launchQualityHarness(
      qualityOptions,
      testInfo,
    );
    await use(harness);

    let rendererLogs: unknown[] = [];
    try {
      rendererLogs = await harness.electronApp.evaluate(
        () => globalThis.__coworkQualityGateMain?.getRendererLogs() ?? [],
      );
    } catch (error) {
      errors.push(`[main:evaluate] ${error instanceof Error ? error.message : String(error)}`);
    }

    const diagnostics = {
      errors,
      mainLogs,
      mainMetrics: await harness.getMainMetrics().catch(() => null),
      rendererLogs,
      test: testInfo.titlePath,
    };
    const diagnosticsPath = path.join(runtimeDir, "diagnostics.json");
    await fs.writeFile(diagnosticsPath, `${JSON.stringify(diagnostics, null, 2)}\n`, "utf8");

    const keepArtifacts =
      errors.length > 0 || testInfo.status !== testInfo.expectedStatus || testInfo.retry > 0;
    const tracePath = path.join(runtimeDir, "trace.zip");
    if (keepArtifacts) {
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
        .catch(() => {});
    } else {
      await harness.electronApp
        .context()
        .tracing.stop()
        .catch(() => {});
    }

    await stopScreenRecorder(recorder).catch((error) => {
      errors.push(`[video] ${error instanceof Error ? error.message : String(error)}`);
    });
    await harness.electronApp.close().catch(() => {});

    if (keepArtifacts) {
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

    expect(errors, "Electron emitted unexpected main/renderer/network errors").toEqual([]);
  },
});

export { expect };
