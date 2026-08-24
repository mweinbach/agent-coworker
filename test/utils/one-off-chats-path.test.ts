import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import path from "node:path";

import { removeWithRetry } from "../../src/platform/fs";
import { scratchRoots } from "../../src/platform/sandbox";
import {
  createOneOffChatWorkspace,
  ensureOneOffChatWorkspacePath,
  getOneOffChatsRoot,
  isPathInsideOneOffChatsRoot,
} from "../../src/utils/oneOffChats";
import { symlinkOrJunction } from "../helpers/platform";

const temporaryDirectories: string[] = [];

async function makeHome(): Promise<string> {
  const directory = await fs.mkdtemp(
    path.join(scratchRoots()[0] ?? "/tmp", "cowork-one-off-home-"),
  );
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  while (temporaryDirectories.length > 0) {
    const directory = temporaryDirectories.pop();
    if (directory) await removeWithRetry(directory, { recursive: true, bestEffort: true });
  }
});

describe("one-off chat path containment", () => {
  test("rejects workspace paths that do not live under ~/.cowork/chats", async () => {
    const home = await makeHome();
    const outside = path.join(home, "outside");
    await fs.mkdir(outside, { recursive: true });

    expect(isPathInsideOneOffChatsRoot(outside, home)).toBe(false);
    await expect(ensureOneOffChatWorkspacePath(outside, { homedir: home })).rejects.toThrow(
      "One-off chat workspace path must live under ~/.cowork/chats",
    );
    expect(await fs.readdir(path.join(home, ".cowork", "chats")).catch(() => [])).toEqual([]);
  });

  test("rejects a chats-relative path that resolves outside the root", async () => {
    const home = await makeHome();
    const escaped = path.join(getOneOffChatsRoot(home), "..", "escape");

    expect(isPathInsideOneOffChatsRoot(escaped, home)).toBe(false);
    await expect(ensureOneOffChatWorkspacePath(escaped, { homedir: home })).rejects.toThrow(
      "One-off chat workspace path must live under ~/.cowork/chats",
    );
  });

  test("creates an in-root workspace and returns its real path", async () => {
    const home = await makeHome();
    const workspace = path.join(getOneOffChatsRoot(home), "chat-1");

    const resolved = await ensureOneOffChatWorkspacePath(workspace, { homedir: home });
    expect(resolved).toBe(await fs.realpath(workspace));
    expect(isPathInsideOneOffChatsRoot(resolved, home)).toBe(true);
  });

  test("rejects a chats-root symlink that resolves outside the root", async () => {
    const home = await makeHome();
    const outside = path.join(home, "escaped-target");
    const chatsRoot = getOneOffChatsRoot(home);
    await fs.mkdir(outside, { recursive: true });
    await fs.mkdir(chatsRoot, { recursive: true });
    const link = path.join(chatsRoot, "alias");
    const linked = await symlinkOrJunction(outside, link, { type: "dir" });
    if (!linked.created) return;

    await expect(ensureOneOffChatWorkspacePath(link, { homedir: home })).rejects.toThrow(
      /must (live|resolve) under ~\/\.cowork\/chats/,
    );
    expect(await fs.readdir(outside)).toEqual([]);
  });

  test("createOneOffChatWorkspace stays under the chats root and slugifies the title", async () => {
    const home = await makeHome();
    const now = new Date("2026-01-02T03:04:05.000Z");

    const created = await createOneOffChatWorkspace({
      titleHint: "Hello, World!!!",
      homedir: home,
      now,
    });

    expect(created.name).toBe("New chat");
    expect(isPathInsideOneOffChatsRoot(created.path, home)).toBe(true);
    expect(path.basename(created.path)).toMatch(/^20260102T030405Z-hello-world-[0-9a-f]{10}$/);
  });
});
