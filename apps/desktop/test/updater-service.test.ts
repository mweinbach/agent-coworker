import { describe, expect, test } from "bun:test";

import { __internal, DesktopUpdaterService, type UpdaterClient } from "../electron/services/updater";

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

describe("desktop updater service", () => {
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
    expect(() => __internal.resolveAutoUpdaterClient({})).toThrow("autoUpdater export was not found");
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
      throw new Error("Cannot find latest-arm64.yml in the latest release artifacts: HttpError: 404");
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

    updater.emit("error", new Error("Cannot find latest.yml in the latest release artifacts: HttpError: 404"));

    const state = service.getState();
    expect(state.phase).toBe("disabled");
    expect(state.error).toBeNull();
    expect(state.message).toContain("no update feed is published");
  });
});
