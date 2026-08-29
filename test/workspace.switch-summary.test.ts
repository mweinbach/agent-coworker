import { describe, expect, test } from "bun:test";

import {
  listWorkspaceSummaries,
  switchWorkspaceSummary,
} from "../src/server/jsonrpc/workspaceCatalog";
import type { WebDesktopServiceLike } from "../src/server/webDesktopService";

function desktopService(workspaces: Array<{ id: string; name: string; path: string }>) {
  return {
    loadState: async () => ({
      version: 2,
      workspaces: workspaces.map((workspace) => ({
        ...workspace,
        createdAt: "2026-01-01T00:00:00.000Z",
        lastOpenedAt: "2026-01-02T00:00:00.000Z",
        defaultEnableMcp: true,
        defaultBackupsEnabled: false,
        yolo: false,
      })),
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
  } as unknown as WebDesktopServiceLike;
}

describe("switchWorkspaceSummary", () => {
  test("no-desktop fallback accepts only the hashed cwd workspace id", async () => {
    const workingDirectory = "/tmp/coverage-workspace";
    const listed = await listWorkspaceSummaries({ workingDirectory });
    const fallbackId = listed.workspaces[0]?.id;
    expect(fallbackId).toMatch(/^server-[0-9a-f]{8}$/);

    await expect(
      switchWorkspaceSummary({
        workspaceId: fallbackId!,
        workingDirectory,
      }),
    ).resolves.toEqual({
      workspaceId: fallbackId,
      name: "coverage-workspace",
      path: workingDirectory,
    });

    await expect(
      switchWorkspaceSummary({
        workspaceId: "server-deadbeef",
        workingDirectory,
      }),
    ).rejects.toThrow("Unknown workspace: server-deadbeef");
  });

  test("desktop catalog rejects unknown ids and returns the matched record", async () => {
    const service = desktopService([
      { id: "project-1", name: "Project A", path: "/tmp/project-a" },
      { id: "chat-1", name: "Chat One", path: "/tmp/chats/chat-1" },
    ]);

    await expect(
      switchWorkspaceSummary({
        workspaceId: "chat-1",
        workingDirectory: "/tmp/project-a",
        desktopService: service,
      }),
    ).resolves.toEqual({
      workspaceId: "chat-1",
      name: "Chat One",
      path: "/tmp/chats/chat-1",
    });

    await expect(
      switchWorkspaceSummary({
        workspaceId: "missing",
        workingDirectory: "/tmp/project-a",
        desktopService: service,
      }),
    ).rejects.toThrow("Unknown workspace: missing");
  });
});
