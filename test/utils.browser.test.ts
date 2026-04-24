import { afterEach, describe, expect, test } from "bun:test";

import { __internal, openExternalUrl } from "../src/utils/browser";

type SpawnCall = {
  cmd: string;
  args: string[];
  opts: Record<string, unknown>;
};

function createMockChild(options: { closeCode?: number | null; error?: Error | null }) {
  const listeners: {
    close: Array<(code: number | null) => void>;
    error: Array<(err: Error) => void>;
  } = { close: [], error: [] };

  const child = {
    once(event: string, cb: (value: unknown) => void) {
      if (event === "close") listeners.close.push(cb as (code: number | null) => void);
      if (event === "error") listeners.error.push(cb as (err: Error) => void);
    },
    unref() {},
    emitClose() {
      listeners.close.forEach((cb) => cb(options.closeCode ?? 0));
    },
    emitError() {
      const err = options.error ?? new Error("mock spawn error");
      listeners.error.forEach((cb) => cb(err));
    },
  };

  setTimeout(() => {
    if (options.error) {
      child.emitError();
    } else {
      child.emitClose();
    }
  }, 0);

  return child;
}

function createMockSpawn(
  options: { closeCode?: number | null; error?: Error | null },
  calls: SpawnCall[],
) {
  return (cmd: string, args: string[], opts: Record<string, unknown>) => {
    calls.push({ cmd, args, opts });
    return createMockChild(options) as any;
  };
}

describe("utils/browser", () => {
  afterEach(() => {
    __internal.resetSpawnImpl();
  });

  test("builds darwin, win32, and linux commands", () => {
    expect(__internal.buildOpenExternalCommand("darwin", "http://example.com")).toMatchObject({
      cmd: "open",
      args: ["http://example.com"],
      detached: true,
    });
    expect(__internal.buildOpenExternalCommand("win32", "https://auth")).toMatchObject({
      cmd: "rundll32.exe",
      args: ["url.dll,FileProtocolHandler", "https://auth"],
      detached: false,
    });
    expect(__internal.buildOpenExternalCommand("linux", "https://foo")).toMatchObject({
      cmd: "xdg-open",
      args: ["https://foo"],
      detached: true,
    });
  });

  test("openExternalUrl resolves true on exit 0", async () => {
    const calls: SpawnCall[] = [];
    __internal.setSpawnImpl(createMockSpawn({ closeCode: 0 }, calls));

    await expect(openExternalUrl("https://example.com")).resolves.toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0].cmd).toMatch(/xdg-open|open|rundll32\.exe/);
  });

  test("openExternalUrl resolves false on nonzero exit", async () => {
    const calls: SpawnCall[] = [];
    __internal.setSpawnImpl(createMockSpawn({ closeCode: 5 }, calls));

    await expect(openExternalUrl("https://example.com")).resolves.toBe(false);
    expect(calls[0].opts.detached).toBeDefined();
  });

  test("openExternalUrl resolves false when spawn errors", async () => {
    const calls: SpawnCall[] = [];
    __internal.setSpawnImpl(createMockSpawn({ error: new Error("boom") }, calls));

    await expect(openExternalUrl("https://example.com")).resolves.toBe(false);
    expect(calls).toHaveLength(1);
  });
});
