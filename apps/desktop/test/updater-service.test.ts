import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import * as productAnalytics from "../../../src/telemetry/productAnalytics";
import type { UpdaterClient } from "../electron/services/updater";
import { createElectronMock, setElectronMockOverrides } from "./helpers/mockElectron";

let userDataDir = "";

setElectronMockOverrides({
  app: {
    getPath: (name: string) => (name === "userData" ? userDataDir : process.cwd()),
  },
});

mock.module("electron", () => createElectronMock());

const { __internal, DesktopUpdaterService } = await import("../electron/services/updater");
const { flushLocalLogWrites } = await import("../electron/services/localLogs");

type Handler = (...args: any[]) => void;

class FakeUpdater implements UpdaterClient {
  autoDownload = false;
  autoInstallOnAppQuit = true;
  allowPrerelease = true;
  disableDifferentialDownload = false;
  channel: string | null = null;
  private readonly handlers = new Map<string, Handler[]>();

  on(event: string, handler: Handler): this {
    const current = this.handlers.get(event) ?? [];
    current.push(handler);
    this.handlers.set(event, current);
    return this;
  }

  async checkForUpdates(): Promise<void> {}

  quitAndInstall(): void {}

  emit(event: string, ...args: any[]): void {
    for (const handler of this.handlers.get(event) ?? []) {
      handler(...args);
    }
  }
}

function createManualTimers() {
  let now = 0;
  const pending = new Set<{ callback: () => void; at: number }>();
  return {
    get pendingCount() {
      return pending.size;
    },
    advance(milliseconds: number) {
      now += milliseconds;
      for (const timer of [...pending]) {
        if (timer.at > now) continue;
        pending.delete(timer);
        timer.callback();
      }
    },
    options: {
      setTimeoutFn: ((callback: () => void, milliseconds = 0) => {
        const timer = { callback, at: now + milliseconds };
        pending.add(timer);
        return timer as unknown as ReturnType<typeof setTimeout>;
      }) as typeof setTimeout,
      clearTimeoutFn: ((timer: ReturnType<typeof setTimeout>) => {
        pending.delete(timer as unknown as { callback: () => void; at: number });
      }) as typeof clearTimeout,
    },
  };
}

function createFinalInstallHarness() {
  const timers = createManualTimers();
  const updater = new FakeUpdater();
  updater.quitAndInstall = mock(() => {});
  const fallback = mock(() => {});
  const pending: Array<(onFailure?: () => void) => void> = [];
  const service = new DesktopUpdaterService({
    currentVersion: "0.1.9",
    isPackaged: true,
    updater,
    ...timers.options,
    requestQuitAndInstall: (install) => pending.push(install),
  });
  updater.emit("update-downloaded", { version: "0.2.0" });
  service.quitAndInstall();
  return {
    service,
    updater,
    timers,
    fallback,
    executeAfterCleanup() {
      // The app disposes services before invoking the deferred native installer.
      service.dispose();
      pending[0]!(fallback);
    },
  };
}

describe("desktop updater service", () => {
  beforeEach(async () => {
    userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-updater-test-"));
  });

  afterEach(async () => {
    if (!userDataDir) {
      return;
    }
    await flushLocalLogWrites("updater.log");
    await fs.rm(userDataDir, { recursive: true, force: true });
    userDataDir = "";
  });

  test("resolves autoUpdater from direct CommonJS export shape", () => {
    const updater = new FakeUpdater();

    const resolved = __internal.resolveAutoUpdaterClient({
      autoUpdater: updater,
    });

    expect(resolved).toBe(updater);
  });

  test("resolves autoUpdater from default-wrapped interop shape", () => {
    const updater = new FakeUpdater();

    const resolved = __internal.resolveAutoUpdaterClient({
      default: {
        autoUpdater: updater,
      },
    });

    expect(resolved).toBe(updater);
  });

  test("throws when autoUpdater export is unavailable", () => {
    expect(() => __internal.resolveAutoUpdaterClient({})).toThrow(
      "autoUpdater export was not found",
    );
  });

  test("stays disabled for unpackaged builds", async () => {
    const updater = new FakeUpdater();
    const service = new DesktopUpdaterService({
      currentVersion: "0.1.9",
      isPackaged: false,
      updater,
    });

    await service.checkForUpdates();

    expect(service.getState().phase).toBe("disabled");
    expect(service.getState().message).toContain("packaged builds");
  });

  test("tracks available, downloading, and downloaded phases", () => {
    const updater = new FakeUpdater();
    const states: string[] = [];
    const service = new DesktopUpdaterService({
      currentVersion: "0.1.9",
      isPackaged: true,
      updater,
      onStateChange: (state) => {
        states.push(state.phase);
      },
      now: () => "2026-03-07T12:00:00.000Z",
    });

    updater.emit("update-available", {
      version: "0.2.0",
      releaseName: "Cowork 0.2.0",
      releaseDate: "2026-03-07T10:00:00.000Z",
      releaseNotes: "Bug fixes",
    });
    updater.emit("download-progress", {
      percent: 55,
      transferred: 550,
      total: 1000,
      bytesPerSecond: 128,
    });
    updater.emit("update-downloaded", {
      version: "0.2.0",
      releaseName: "Cowork 0.2.0",
      releaseDate: "2026-03-07T10:00:00.000Z",
      releaseNotes: "Bug fixes",
    });

    const state = service.getState();
    expect(states).toEqual(["available", "downloading", "downloaded"]);
    expect(state.phase).toBe("downloaded");
    expect(state.release?.version).toBe("0.2.0");
    expect(state.progress?.percent).toBe(100);
    expect(state.message).toContain("Restart Cowork");
  });

  test("disables differential downloads for packaged macOS builds", () => {
    const updater = new FakeUpdater();

    new DesktopUpdaterService({
      currentVersion: "0.1.20",
      isPackaged: true,
      updater,
      platform: "darwin",
    });

    expect(updater.disableDifferentialDownload).toBe(true);
  });

  test("keeps a downloaded update installable when another check is requested", async () => {
    const updater = new FakeUpdater();
    updater.checkForUpdates = mock(async () => {
      throw new Error("Network is offline");
    });
    updater.quitAndInstall = mock(() => {});
    const service = new DesktopUpdaterService({
      currentVersion: "0.1.9",
      isPackaged: true,
      updater,
    });
    updater.emit("update-downloaded", { version: "0.2.0" });

    await service.checkForUpdates();
    service.quitAndInstall();

    expect(service.getState()).toMatchObject({
      phase: "downloaded",
      release: { version: "0.2.0" },
      error: null,
    });
    expect(updater.quitAndInstall).toHaveBeenCalledTimes(1);
  });

  test("defers native installation and analytics until the quit coordinator executes it", () => {
    const updater = new FakeUpdater();
    updater.quitAndInstall = mock(() => {});
    const pending: Array<() => void> = [];
    const requestQuitAndInstall = mock((install: () => void) => {
      pending.push(install);
    });
    const capture = spyOn(productAnalytics, "captureProductEvent").mockImplementation(() => {});
    try {
      const service = new DesktopUpdaterService({
        currentVersion: "0.1.9",
        isPackaged: true,
        updater,
        requestQuitAndInstall,
      });
      updater.emit("update-downloaded", { version: "0.2.0" });
      capture.mockClear();

      service.quitAndInstall();

      expect(requestQuitAndInstall).toHaveBeenCalledTimes(1);
      expect(updater.quitAndInstall).not.toHaveBeenCalled();
      expect(capture).not.toHaveBeenCalled();
      pending[0]!();
      expect(updater.quitAndInstall).toHaveBeenCalledWith(false, true);
      expect(capture).toHaveBeenCalledWith("update_install_started", {
        eventSource: "main",
        status: "started",
      });
    } finally {
      capture.mockRestore();
    }
  });

  test("a cancelled quit request neither installs nor records installation and remains retryable", () => {
    const updater = new FakeUpdater();
    updater.quitAndInstall = mock(() => {});
    const requestQuitAndInstall = mock((_install: () => void) => {});
    const capture = spyOn(productAnalytics, "captureProductEvent").mockImplementation(() => {});
    try {
      const service = new DesktopUpdaterService({
        currentVersion: "0.1.9",
        isPackaged: true,
        updater,
        requestQuitAndInstall,
      });
      updater.emit("update-downloaded", { version: "0.2.0" });
      capture.mockClear();

      service.quitAndInstall();

      expect(requestQuitAndInstall).toHaveBeenCalledTimes(1);
      expect(updater.quitAndInstall).not.toHaveBeenCalled();
      expect(capture).not.toHaveBeenCalled();
      expect(service.getState().phase).toBe("downloaded");

      requestQuitAndInstall.mockImplementation((install) => install());
      service.quitAndInstall();
      expect(updater.quitAndInstall).toHaveBeenCalledTimes(1);
      expect(capture).toHaveBeenCalledTimes(1);
    } finally {
      capture.mockRestore();
    }
  });

  test("final install falls back once when the native updater emits an error and returns", () => {
    const harness = createFinalInstallHarness();
    harness.updater.quitAndInstall = mock(() => {
      harness.updater.emit("error", new Error("native install failed"));
    });

    harness.executeAfterCleanup();

    expect(harness.fallback).toHaveBeenCalledTimes(1);
    expect(harness.timers.pendingCount).toBe(0);
    harness.updater.emit("error", new Error("duplicate install error"));
    harness.timers.advance(60_000);
    expect(harness.fallback).toHaveBeenCalledTimes(1);
  });

  test("final install handles a late native error after the install call returns", () => {
    const harness = createFinalInstallHarness();
    harness.executeAfterCleanup();
    harness.timers.advance(1_000);
    expect(harness.fallback).not.toHaveBeenCalled();

    harness.updater.emit("error", new Error("native check failed asynchronously"));

    expect(harness.fallback).toHaveBeenCalledTimes(1);
    expect(harness.timers.pendingCount).toBe(0);
  });

  test("final install allows a healthy handoff until the bounded watchdog expires", () => {
    const harness = createFinalInstallHarness();
    harness.executeAfterCleanup();
    harness.timers.advance(59_999);
    expect(harness.fallback).not.toHaveBeenCalled();
    expect(harness.updater.quitAndInstall).toHaveBeenCalledTimes(1);

    harness.timers.advance(1);

    expect(harness.fallback).toHaveBeenCalledTimes(1);
    expect(harness.timers.pendingCount).toBe(0);
    harness.updater.emit("error", new Error("late error after timeout"));
    expect(harness.fallback).toHaveBeenCalledTimes(1);
  });

  test("final install does not arm a fallback or timer for a cancelled preflight", () => {
    const harness = createFinalInstallHarness();
    harness.timers.advance(120_000);

    expect(harness.updater.quitAndInstall).not.toHaveBeenCalled();
    expect(harness.fallback).not.toHaveBeenCalled();
    expect(harness.timers.pendingCount).toBe(0);
  });

  test("disposing after a final install clears its pending fallback and watchdog", () => {
    const harness = createFinalInstallHarness();
    harness.executeAfterCleanup();
    expect(harness.timers.pendingCount).toBe(1);

    harness.service.dispose();
    harness.timers.advance(60_000);
    harness.updater.emit("error", new Error("error after disposal"));

    expect(harness.fallback).not.toHaveBeenCalled();
    expect(harness.timers.pendingCount).toBe(0);
  });

  test("a thrown native final install failure releases the watchdog and calls fallback", () => {
    const harness = createFinalInstallHarness();
    harness.updater.quitAndInstall = mock(() => {
      throw new Error("native updater threw");
    });

    expect(() => harness.executeAfterCleanup()).toThrow("native updater threw");
    expect(harness.fallback).toHaveBeenCalledTimes(1);
    expect(harness.timers.pendingCount).toBe(0);
  });

  test("direct installation errors retain normal error state without a final-quit watchdog", () => {
    const timers = createManualTimers();
    const updater = new FakeUpdater();
    updater.quitAndInstall = mock(() => updater.emit("error", new Error("direct install failed")));
    const service = new DesktopUpdaterService({
      currentVersion: "0.1.9",
      isPackaged: true,
      updater,
      ...timers.options,
    });
    updater.emit("update-downloaded", { version: "0.2.0" });

    service.quitAndInstall();
    timers.advance(120_000);

    expect(service.getState()).toMatchObject({ phase: "error", error: "direct install failed" });
    expect(updater.quitAndInstall).toHaveBeenCalledTimes(1);
    expect(timers.pendingCount).toBe(0);
  });

  test.each(["unpackaged", "packaged"] as const)(
    "does not request installation before a download in %s builds",
    (mode) => {
      const updater = new FakeUpdater();
      updater.quitAndInstall = mock(() => {});
      const requestQuitAndInstall = mock((_install: () => void) => {});
      const service = new DesktopUpdaterService({
        currentVersion: "0.1.9",
        isPackaged: mode === "packaged",
        updater,
        requestQuitAndInstall,
      });

      service.quitAndInstall();

      expect(requestQuitAndInstall).not.toHaveBeenCalled();
      expect(updater.quitAndInstall).not.toHaveBeenCalled();
    },
  );

  test("leaves differential downloads unchanged on non-mac packaged builds", () => {
    const updater = new FakeUpdater();

    new DesktopUpdaterService({
      currentVersion: "0.1.20",
      isPackaged: true,
      updater,
      platform: "win32",
    });

    expect(updater.disableDifferentialDownload).toBe(false);
  });

  test("selects the dedicated Windows ARM64 update channel", () => {
    const updater = new FakeUpdater();

    new DesktopUpdaterService({
      currentVersion: "0.1.20",
      isPackaged: true,
      updater,
      platform: "win32",
      arch: "arm64",
    });

    expect(updater.channel).toBe("latest-arm64");
  });

  test("keeps Linux updater defaults isolated from macOS settings", () => {
    const updater = new FakeUpdater();

    new DesktopUpdaterService({
      currentVersion: "0.1.20",
      isPackaged: true,
      updater,
      platform: "linux",
    });

    expect(updater.disableDifferentialDownload).toBe(false);
  });

  test("records updater errors without throwing", async () => {
    const updater = new FakeUpdater();
    updater.checkForUpdates = async () => {
      throw new Error("network down");
    };
    const service = new DesktopUpdaterService({
      currentVersion: "0.1.9",
      isPackaged: true,
      updater,
      now: () => "2026-03-07T12:00:00.000Z",
    });

    await service.checkForUpdates();

    const state = service.getState();
    expect(state.phase).toBe("error");
    expect(state.error).toBe("network down");
  });

  test("treats missing latest.yml checks as unavailable instead of an error", async () => {
    const updater = new FakeUpdater();
    updater.checkForUpdates = async () => {
      throw new Error("Cannot find latest.yml in the latest release artifacts: HttpError: 404");
    };
    const service = new DesktopUpdaterService({
      currentVersion: "0.1.9",
      isPackaged: true,
      updater,
      now: () => "2026-03-08T15:39:19.000Z",
    });

    await service.checkForUpdates();

    const state = service.getState();
    expect(state.phase).toBe("disabled");
    expect(state.error).toBeNull();
    expect(state.message).toContain("no update feed is published");
  });

  test("treats missing latest-mac.yml checks as unavailable instead of an error", async () => {
    const updater = new FakeUpdater();
    updater.checkForUpdates = async () => {
      throw new Error("Cannot find latest-mac.yml in the latest release artifacts: HttpError: 404");
    };
    const service = new DesktopUpdaterService({
      currentVersion: "0.1.9",
      isPackaged: true,
      updater,
      now: () => "2026-03-08T15:39:19.000Z",
    });

    await service.checkForUpdates();

    const state = service.getState();
    expect(state.phase).toBe("disabled");
    expect(state.error).toBeNull();
    expect(state.message).toContain("no update feed is published");
  });

  test("treats missing latest-arm64.yml checks as unavailable instead of an error", async () => {
    const updater = new FakeUpdater();
    updater.checkForUpdates = async () => {
      throw new Error(
        "Cannot find latest-arm64.yml in the latest release artifacts: HttpError: 404",
      );
    };
    const service = new DesktopUpdaterService({
      currentVersion: "0.1.9",
      isPackaged: true,
      updater,
      now: () => "2026-03-08T15:39:19.000Z",
    });

    await service.checkForUpdates();

    const state = service.getState();
    expect(state.phase).toBe("disabled");
    expect(state.error).toBeNull();
    expect(state.message).toContain("no update feed is published");
  });

  test("treats missing latest.yml error events as unavailable instead of an error", () => {
    const updater = new FakeUpdater();
    const service = new DesktopUpdaterService({
      currentVersion: "0.1.9",
      isPackaged: true,
      updater,
      now: () => "2026-03-08T15:39:19.000Z",
    });

    updater.emit(
      "error",
      new Error("Cannot find latest.yml in the latest release artifacts: HttpError: 404"),
    );

    const state = service.getState();
    expect(state.phase).toBe("disabled");
    expect(state.error).toBeNull();
    expect(state.message).toContain("no update feed is published");
  });
});
