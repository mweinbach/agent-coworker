import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const PRIVATE_DIR_MODE = 0o700;

export const ONE_OFF_CHAT_WORKSPACE_KIND = "oneOffChat";
export const PROJECT_WORKSPACE_KIND = "project";

export type WorkspaceKind = typeof PROJECT_WORKSPACE_KIND | typeof ONE_OFF_CHAT_WORKSPACE_KIND;

export type OneOffChatWorkspace = {
  name: string;
  path: string;
};

export function normalizeWorkspaceKind(value: unknown): WorkspaceKind {
  return value === ONE_OFF_CHAT_WORKSPACE_KIND
    ? ONE_OFF_CHAT_WORKSPACE_KIND
    : PROJECT_WORKSPACE_KIND;
}

export function getOneOffChatsRoot(homedir = os.homedir()): string {
  return path.join(homedir, ".cowork", "chats");
}

function pathContains(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

export function isPathInsideOneOffChatsRoot(targetPath: string, homedir = os.homedir()): boolean {
  const root = path.resolve(getOneOffChatsRoot(homedir));
  const target = path.resolve(targetPath);
  return pathContains(root, target);
}

function slugifyTitle(value: string | undefined): string {
  const slug =
    value
      ?.trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "chat";
  return slug || "chat";
}

function timestampSegment(date: Date): string {
  return date
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}Z$/, "Z");
}

async function ensurePrivateDirectory(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true, mode: PRIVATE_DIR_MODE });
  try {
    await fs.chmod(dir, PRIVATE_DIR_MODE);
  } catch {
    // Best-effort hardening only. Some filesystems ignore POSIX mode updates.
  }
}

export async function ensureOneOffChatWorkspacePath(
  workspacePath: string,
  opts: { homedir?: string } = {},
): Promise<string> {
  const resolved = path.resolve(workspacePath);
  if (!isPathInsideOneOffChatsRoot(resolved, opts.homedir)) {
    throw new Error("One-off chat workspace path must live under ~/.cowork/chats");
  }

  await ensurePrivateDirectory(resolved);
  const realPath = await fs.realpath(resolved);
  if (!isPathInsideOneOffChatsRoot(realPath, opts.homedir)) {
    throw new Error("One-off chat workspace path must resolve under ~/.cowork/chats");
  }
  return realPath;
}

export async function createOneOffChatWorkspace(
  opts: { titleHint?: string; homedir?: string; now?: Date } = {},
): Promise<OneOffChatWorkspace> {
  const root = getOneOffChatsRoot(opts.homedir);
  await ensurePrivateDirectory(root);

  const timestamp = timestampSegment(opts.now ?? new Date());
  const slug = slugifyTitle(opts.titleHint);
  const id = crypto.randomUUID().replace(/-/g, "").slice(0, 10);
  const workspacePath = path.join(root, `${timestamp}-${slug}-${id}`);

  await ensurePrivateDirectory(workspacePath);
  return {
    name: "New chat",
    path: await fs.realpath(workspacePath),
  };
}
