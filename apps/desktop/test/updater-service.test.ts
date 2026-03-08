import { describe, expect, test } from "bun:test";

import { __internal, DesktopUpdaterService, type UpdaterClient } from "../electron/services/updater";

type Handler = (...args: any[]) => void;

class FakeUpdater implements UpdaterClient {
  autoDownload = false;
  autoInstallOnAppQuit = true;
  allowPrerelease = true;
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
      currentVersion: "0.1.2",
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
      currentVersion: "0.1.2",
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

  test("records updater errors without throwing", async () => {
    const updater = new FakeUpdater();
    updater.checkForUpdates = async () => {
      throw new Error("network down");
    };
    const service = new DesktopUpdaterService({
      currentVersion: "0.1.2",
      isPackaged: true,
      updater,
      now: () => "2026-03-07T12:00:00.000Z",
    });

    await service.checkForUpdates();

    const state = service.getState();
    expect(state.phase).toBe("error");
    expect(state.error).toBe("network down");
  });
});
