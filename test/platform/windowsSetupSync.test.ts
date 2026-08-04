import { describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  CODEX_WINDOWS_SANDBOX_SETUP_VERSION,
  syncCodexWindowsSandboxSetupState,
} from "../../src/platform/sandbox/windowsSetupSync";

const VERSION = CODEX_WINDOWS_SANDBOX_SETUP_VERSION;

function markerJson(createdAt: string, version = VERSION): string {
  return JSON.stringify({
    version,
    offline_username: "CodexSandboxOffline",
    online_username: "CodexSandboxOnline",
    created_at: createdAt,
    proxy_ports: [],
    allow_local_binding: false,
  });
}

function usersJson(tag: string, version = VERSION): string {
  return JSON.stringify({
    version,
    offline: { username: "CodexSandboxOffline", password: `offline-${tag}` },
    online: { username: "CodexSandboxOnline", password: `online-${tag}` },
  });
}

async function writeState(
  home: string,
  opts: { createdAt: string; tag: string; version?: number },
): Promise<void> {
  await fs.mkdir(path.join(home, ".sandbox"), { recursive: true });
  await fs.mkdir(path.join(home, ".sandbox-secrets"), { recursive: true });
  await fs.writeFile(
    path.join(home, ".sandbox", "setup_marker.json"),
    markerJson(opts.createdAt, opts.version),
    "utf8",
  );
  await fs.writeFile(
    path.join(home, ".sandbox-secrets", "sandbox_users.json"),
    usersJson(opts.tag, opts.version),
    "utf8",
  );
}

async function readUsers(home: string): Promise<string | null> {
  try {
    return await fs.readFile(path.join(home, ".sandbox-secrets", "sandbox_users.json"), "utf8");
  } catch {
    return null;
  }
}

async function makeHomes(): Promise<{
  root: string;
  coworkHome: string;
  appServerHome: string;
  env: NodeJS.ProcessEnv;
}> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-sbx-sync-test-"));
  const coworkHome = path.join(root, ".cowork");
  const appServerHome = path.join(root, ".cowork", "auth", "codex-cli");
  return { root, coworkHome, appServerHome, env: { COWORK_HOME_OVERRIDE: root } };
}

describe("syncCodexWindowsSandboxSetupState", () => {
  test("propagates complete setup state from the cowork home to the app-server home", async () => {
    const { coworkHome, appServerHome, env } = await makeHomes();
    await writeState(coworkHome, { createdAt: "2026-07-01T00:00:00Z", tag: "cowork" });

    const result = await syncCodexWindowsSandboxSetupState(appServerHome, {
      platform: "win32",
      env,
    });

    expect(result.sourceHome).toBe(coworkHome);
    expect(result.updatedHomes).toEqual([appServerHome]);
    expect(await readUsers(appServerHome)).toBe(usersJson("cowork"));
    const marker = JSON.parse(
      await fs.readFile(path.join(appServerHome, ".sandbox", "setup_marker.json"), "utf8"),
    );
    expect(marker.created_at).toBe("2026-07-01T00:00:00Z");
  });

  test("propagates the newest state in either direction", async () => {
    const { coworkHome, appServerHome, env } = await makeHomes();
    await writeState(coworkHome, { createdAt: "2026-07-01T00:00:00Z", tag: "old" });
    await writeState(appServerHome, { createdAt: "2026-07-20T00:00:00Z", tag: "new" });

    const result = await syncCodexWindowsSandboxSetupState(appServerHome, {
      platform: "win32",
      env,
    });

    expect(result.sourceHome).toBe(appServerHome);
    expect(result.updatedHomes).toEqual([coworkHome]);
    expect(await readUsers(coworkHome)).toBe(usersJson("new"));
    expect(await readUsers(appServerHome)).toBe(usersJson("new"));
  });

  test("falls back to marker mtime when created_at is missing or invalid", async () => {
    const { coworkHome, appServerHome, env } = await makeHomes();
    await writeState(coworkHome, { createdAt: "not-a-timestamp", tag: "stale" });
    await writeState(appServerHome, { createdAt: "", tag: "fresh" });

    const older = new Date("2026-07-01T00:00:00Z");
    const newer = new Date("2026-07-20T00:00:00Z");
    await fs.utimes(path.join(coworkHome, ".sandbox", "setup_marker.json"), older, older);
    await fs.utimes(path.join(appServerHome, ".sandbox", "setup_marker.json"), newer, newer);

    const result = await syncCodexWindowsSandboxSetupState(appServerHome, {
      platform: "win32",
      env,
    });

    expect(result.sourceHome).toBe(appServerHome);
    expect(result.updatedHomes).toEqual([coworkHome]);
    expect(await readUsers(coworkHome)).toBe(usersJson("fresh"));
    expect(await readUsers(appServerHome)).toBe(usersJson("fresh"));
  });

  test("never consults the native Codex home, even when it holds newer state", async () => {
    const { root, coworkHome, appServerHome, env } = await makeHomes();
    // A native Codex install next to Cowork's homes with the freshest state
    // must be ignored entirely: foreign state never leaks into Cowork's
    // runtime, and Cowork never writes into ~/.codex.
    const nativeHome = path.join(root, ".codex");
    await writeState(nativeHome, { createdAt: "2026-07-25T00:00:00Z", tag: "native" });
    await writeState(coworkHome, { createdAt: "2026-07-01T00:00:00Z", tag: "cowork" });

    const result = await syncCodexWindowsSandboxSetupState(appServerHome, {
      platform: "win32",
      env,
    });

    expect(result.sourceHome).toBe(coworkHome);
    expect(result.updatedHomes).toEqual([appServerHome]);
    expect(await readUsers(appServerHome)).toBe(usersJson("cowork"));
    expect(await readUsers(nativeHome)).toBe(usersJson("native"));
  });

  test("ignores incomplete state and does not propagate it", async () => {
    const { coworkHome, appServerHome, env } = await makeHomes();
    // Marker without a users file: not a consumable setup state.
    await fs.mkdir(path.join(coworkHome, ".sandbox"), { recursive: true });
    await fs.writeFile(
      path.join(coworkHome, ".sandbox", "setup_marker.json"),
      markerJson("2026-07-01T00:00:00Z"),
      "utf8",
    );

    const result = await syncCodexWindowsSandboxSetupState(appServerHome, {
      platform: "win32",
      env,
    });

    expect(result.sourceHome).toBeUndefined();
    expect(result.updatedHomes).toEqual([]);
    expect(await readUsers(appServerHome)).toBeNull();
  });

  test("does not propagate incompatible setup versions", async () => {
    const { coworkHome, appServerHome, env } = await makeHomes();
    await writeState(coworkHome, { createdAt: "2026-07-01T00:00:00Z", tag: "future", version: 6 });

    const result = await syncCodexWindowsSandboxSetupState(appServerHome, {
      platform: "win32",
      env,
    });

    expect(result.sourceHome).toBeUndefined();
    expect(result.updatedHomes).toEqual([]);
    expect(await readUsers(appServerHome)).toBeNull();
  });

  test("is a no-op off Windows", async () => {
    const { coworkHome, appServerHome, env } = await makeHomes();
    await writeState(coworkHome, { createdAt: "2026-07-01T00:00:00Z", tag: "cowork" });

    const result = await syncCodexWindowsSandboxSetupState(appServerHome, {
      platform: "linux",
      env,
    });

    expect(result.updatedHomes).toEqual([]);
    expect(await readUsers(appServerHome)).toBeNull();
  });

  test("is idempotent once every writable home carries the newest state", async () => {
    const { coworkHome, appServerHome, env } = await makeHomes();
    await writeState(coworkHome, { createdAt: "2026-07-01T00:00:00Z", tag: "cowork" });
    const sync = () =>
      syncCodexWindowsSandboxSetupState(appServerHome, {
        platform: "win32",
        env,
      });

    const first = await sync();
    expect(first.updatedHomes).toEqual([appServerHome]);
    const second = await sync();
    expect(second.updatedHomes).toEqual([]);
  });

  test("never throws when homes are missing or unreadable", async () => {
    const { appServerHome, env } = await makeHomes();

    const result = await syncCodexWindowsSandboxSetupState(appServerHome, {
      platform: "win32",
      env,
      log: () => {},
    });

    expect(result.sourceHome).toBeUndefined();
    expect(result.updatedHomes).toEqual([]);
  });
});
