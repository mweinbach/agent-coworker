import { describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import path from "node:path";

import { scratchRoots } from "../src/platform/sandbox";
import { ensureOneOffChatWorkspacePath, getOneOffChatsRoot } from "../src/utils/oneOffChats";
import { symlinkOrJunction } from "./helpers/platform";

async function makeHome(): Promise<string> {
  const [scratchRoot] = scratchRoots();
  if (!scratchRoot) throw new Error("scratch root is required");
  return fs.mkdtemp(path.join(scratchRoot, "oneoff-chat-home-"));
}

describe("one-off chat workspace containment", () => {
  test("rejects a chat path that resolves outside ~/.cowork/chats through a directory symlink", async () => {
    const homedir = await makeHome();
    try {
      const outside = path.join(homedir, "outside");
      const chatsRoot = getOneOffChatsRoot(homedir);
      const link = path.join(chatsRoot, "linked");
      const target = path.join(link, "session");
      await fs.mkdir(outside, { recursive: true });
      await fs.mkdir(chatsRoot, { recursive: true });
      await fs.writeFile(path.join(outside, "secret.txt"), "secret");
      await symlinkOrJunction(outside, link, { type: "dir" });

      await expect(ensureOneOffChatWorkspacePath(target, { homedir })).rejects.toThrow(
        /One-off chat workspace path must (?:live|resolve) under ~\/\.cowork\/chats/,
      );
      expect(await fs.readdir(outside)).toEqual(["secret.txt"]);
    } finally {
      await fs.rm(homedir, { recursive: true, force: true });
    }
  });

  test("rejects a lexically outside path and accepts an in-root .. segment", async () => {
    const homedir = await makeHome();
    try {
      const chatsRoot = getOneOffChatsRoot(homedir);
      const outside = path.resolve(chatsRoot, "..", "..", "outside-session");
      await expect(ensureOneOffChatWorkspacePath(outside, { homedir })).rejects.toThrow(
        "One-off chat workspace path must live under ~/.cowork/chats",
      );
      await expect(ensureOneOffChatWorkspacePath("", { homedir })).rejects.toThrow(
        "One-off chat workspace path must live under ~/.cowork/chats",
      );

      const nested = path.join(chatsRoot, "draft", "..", "kept");
      const created = await ensureOneOffChatWorkspacePath(nested, { homedir });
      expect(created).toBe(await fs.realpath(path.join(chatsRoot, "kept")));
      expect(created.startsWith(`${await fs.realpath(chatsRoot)}${path.sep}`)).toBe(true);
    } finally {
      await fs.rm(homedir, { recursive: true, force: true });
    }
  });

  test("returns the canonical directory for an alias that stays inside the chats root", async () => {
    const homedir = await makeHome();
    try {
      const chatsRoot = getOneOffChatsRoot(homedir);
      const realDir = path.join(chatsRoot, "real-session");
      const alias = path.join(chatsRoot, "alias-session");
      const created = await ensureOneOffChatWorkspacePath(realDir, { homedir });
      await symlinkOrJunction(created, alias, { type: "dir" });

      expect(await ensureOneOffChatWorkspacePath(alias, { homedir })).toBe(created);
      expect(created).not.toBe(alias);
    } finally {
      await fs.rm(homedir, { recursive: true, force: true });
    }
  });
});
