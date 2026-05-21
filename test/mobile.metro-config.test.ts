import { describe, expect, mock, test } from "bun:test";
import { EventEmitter } from "node:events";
import path from "node:path";

const mobileRoot = path.resolve(import.meta.dir, "../apps/mobile");

mock.module("nativewind/metro", () => ({
  withNativewind: (config: unknown) => config,
}));

describe("mobile Metro config", () => {
  test("normalizes NativeWind CSS watcher events for Metro change listeners", () => {
    const previousCwd = process.cwd();
    let metroConfig: {
      server: {
        enhanceMiddleware: (middleware: unknown, metroServer: unknown) => unknown;
      };
    } | null = null;
    try {
      process.chdir(mobileRoot);
      metroConfig = require("../apps/mobile/metro.config.js");
    } finally {
      process.chdir(previousCwd);
    }
    if (!metroConfig) {
      throw new Error("Mobile Metro config did not load");
    }

    const watcher = new EventEmitter();
    const emittedChangeEvents: unknown[] = [];

    watcher.on("change", (event) => emittedChangeEvents.push(event));

    const bundler = {
      getWatcher: () => watcher,
      transformFile: async () => ({
        output: [{ data: { css: { code: "" } } }],
      }),
    };
    const metroServer = {
      getBundler: () => ({
        getBundler: () => bundler,
      }),
    };

    metroConfig.server.enhanceMiddleware(
      (_request: unknown, _response: unknown, next: () => void) => next(),
      metroServer,
    );

    watcher.emit("change", {
      eventsQueue: [
        {
          filePath: path.join(
            mobileRoot,
            "node_modules/react-native-css/dist/commonjs/runtime/native/metro.js",
          ),
          metadata: { modifiedTime: 123 },
          type: "change",
        },
      ],
    });

    expect(emittedChangeEvents).toHaveLength(1);

    const changeEvent = emittedChangeEvents[0] as {
      changes: {
        addedFiles: Map<string, unknown>;
        modifiedFiles: Map<string, { isSymlink: boolean; modifiedTime: number }>;
        removedFiles: Map<string, unknown>;
      };
      logger: null;
      rootDir: string;
    };

    expect(changeEvent.rootDir).toBe(mobileRoot);
    expect(changeEvent.logger).toBeNull();
    expect(changeEvent.changes.addedFiles.size).toBe(0);
    expect(changeEvent.changes.removedFiles.size).toBe(0);
    expect([...changeEvent.changes.modifiedFiles.entries()]).toEqual([
      [
        "node_modules/react-native-css/dist/commonjs/runtime/native/metro.js",
        { isSymlink: false, modifiedTime: 123 },
      ],
    ]);
  });
});
