import { describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import path from "node:path";

import {
  classifyWorkspaceKind,
  listWorkspaceSummaries,
  switchWorkspaceSummary,
} from "../src/server/jsonrpc/workspaceCatalog";
import type { WebDesktopServiceLike } from "../src/server/webDesktopService";
import { getOneOffChatsRoot, withWorkspaceKindSource } from "../src/utils/oneOffChats";

async function withTempHome<T>(run: (homedir: string) => Promise<T>): Promise<T> {
  const homedir = await fs.mkdtemp(path.join(process.cwd(), "cowork-classify-kind-"));
  try {
    return await run(homedir);
  } finally {
    await fs.rm(homedir, { recursive: true, force: true });
  }
}

describe("classifyWorkspaceKind", () => {
  test("keeps an explicit project even when the path sits under ~/.cowork/chats", async () => {
    await withTempHome(async (homedir) => {
      const chatPath = path.join(getOneOffChatsRoot(homedir), "promoted-project");
      await fs.mkdir(chatPath, { recursive: true });
      const record = withWorkspaceKindSource(
        { path: chatPath, workspaceKind: "project" },
        "explicit",
      );

      expect(classifyWorkspaceKind(record, homedir)).toBe("project");
    });
  });

  test("demotes a default-source project under ~/.cowork/chats to oneOffChat", async () => {
    await withTempHome(async (homedir) => {
      const chatPath = path.join(getOneOffChatsRoot(homedir), "fallback-chat");
      await fs.mkdir(chatPath, { recursive: true });
      const record = withWorkspaceKindSource(
        { path: chatPath, workspaceKind: "project" },
        "default",
      );

      expect(classifyWorkspaceKind(record, homedir)).toBe("oneOffChat");
    });
  });

  test("keeps a default-source project on an ordinary path", async () => {
    await withTempHome(async (homedir) => {
      const projectPath = path.join(homedir, "repo");
      await fs.mkdir(projectPath, { recursive: true });
      const record = withWorkspaceKindSource(
        { path: projectPath, workspaceKind: "project" },
        "default",
      );

      expect(classifyWorkspaceKind(record, homedir)).toBe("project");
    });
  });

  test("classifies missing kind from the chats-root path, otherwise as project", async () => {
    await withTempHome(async (homedir) => {
      const chatPath = path.join(getOneOffChatsRoot(homedir), "legacy-chat");
      const projectPath = path.join(homedir, "ordinary");
      await fs.mkdir(chatPath, { recursive: true });
      await fs.mkdir(projectPath, { recursive: true });

      expect(classifyWorkspaceKind({ path: chatPath }, homedir)).toBe("oneOffChat");
      expect(classifyWorkspaceKind({ path: projectPath }, homedir)).toBe("project");
      expect(classifyWorkspaceKind({ path: projectPath, workspaceKind: "unknown" }, homedir)).toBe(
        "project",
      );
      expect(
        classifyWorkspaceKind({ path: projectPath, workspaceKind: "oneOffChat" }, homedir),
      ).toBe("oneOffChat");
    });
  });
});

describe("switchWorkspaceSummary", () => {
  test("accepts the no-desktop fallback id and rejects every other id", async () => {
    const listed = await listWorkspaceSummaries({
      workingDirectory: "/workspace/fallback-project",
    });
    const fallbackId = listed.workspaces[0]?.id;
    expect(fallbackId).toMatch(/^server-/);

    const switched = await switchWorkspaceSummary({
      workspaceId: fallbackId ?? "",
      workingDirectory: "/workspace/fallback-project",
    });
    expect(switched).toEqual({
      workspaceId: fallbackId,
      name: "fallback-project",
      path: "/workspace/fallback-project",
    });

    await expect(
      switchWorkspaceSummary({
        workspaceId: "server-deadbeef",
        workingDirectory: "/workspace/fallback-project",
      }),
    ).rejects.toThrow("Unknown workspace: server-deadbeef");
  });

  test("resolves a catalog workspace and rejects unknown catalog ids", async () => {
    const desktopService = {
      loadState: async () => ({
        version: 2,
        workspaces: [
          {
            id: "ws-project",
            name: "Project",
            path: "/workspace/project-a",
            workspaceKind: "project",
            createdAt: "2026-01-01T00:00:00.000Z",
            lastOpenedAt: "2026-01-02T00:00:00.000Z",
            defaultEnableMcp: true,
            defaultBackupsEnabled: false,
            yolo: false,
          },
        ],
        threads: [],
        developerMode: false,
        showHiddenFiles: false,
        perWorkspaceSettings: false,
        desktopSettings: {
          quickChat: {
            shortcutEnabled: false,
            shortcutAccelerator: "CommandOrControl+Shift+C",
          },
        },
        desktopFeatureFlagOverrides: {},
      }),
    } as WebDesktopServiceLike;

    await expect(
      switchWorkspaceSummary({
        workspaceId: "ws-project",
        workingDirectory: "/workspace/other",
        desktopService,
      }),
    ).resolves.toEqual({
      workspaceId: "ws-project",
      name: "Project",
      path: "/workspace/project-a",
    });

    await expect(
      switchWorkspaceSummary({
        workspaceId: "ws-missing",
        workingDirectory: "/workspace/other",
        desktopService,
      }),
    ).rejects.toThrow("Unknown workspace: ws-missing");
  });
});
