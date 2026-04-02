import { describe, expect, test } from "bun:test";

import { resolvePluginCatalogWorkspaceSelection } from "../src/app/pluginManagement";
import type { WorkspaceRecord } from "../src/app/types";

function workspace(id: string, name: string): WorkspaceRecord {
  return {
    id,
    name,
    path: `/tmp/${id}`,
    createdAt: "2026-04-01T00:00:00.000Z",
    lastOpenedAt: "2026-04-01T00:00:00.000Z",
    defaultEnableMcp: true,
    defaultBackupsEnabled: true,
    yolo: false,
  };
}

describe("plugin management selection", () => {
  test("auto mode defaults the catalog to the selected workspace", () => {
    const selection = resolvePluginCatalogWorkspaceSelection({
      workspaces: [workspace("ws-1", "Workspace One")],
      selectedWorkspaceId: "ws-1",
      pluginManagementWorkspaceId: null,
      pluginManagementMode: "auto",
    });

    expect(selection.pluginManagementWorkspaceId).toBeNull();
    expect(selection.pluginManagementMode).toBe("auto");
    expect(selection.displayWorkspaceId).toBe("ws-1");
    expect(selection.catalogWorkspaceId).toBe("ws-1");
    expect(selection.managementScope).toBe("workspace");
  });

  test("global mode preserves the global filter while keeping the selected workspace runtime", () => {
    const selection = resolvePluginCatalogWorkspaceSelection({
      workspaces: [workspace("ws-1", "Workspace One")],
      selectedWorkspaceId: "ws-1",
      pluginManagementWorkspaceId: null,
      pluginManagementMode: "global",
    });

    expect(selection.pluginManagementWorkspaceId).toBeNull();
    expect(selection.displayWorkspaceId).toBeNull();
    expect(selection.catalogWorkspaceId).toBe("ws-1");
    expect(selection.managementScope).toBe("global");
  });
});
