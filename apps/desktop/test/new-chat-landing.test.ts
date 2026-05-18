import { describe, expect, test } from "bun:test";
import type { WorkspaceRecord } from "../src/app/types";
import {
  resolveDefaultNewChatTarget,
  resolveNewChatLandingProjectWorkspaceId,
  resolveNewChatLandingTarget,
} from "../src/lib/newChatLanding";

const projectWorkspace = (id: string, name: string): WorkspaceRecord => ({
  id,
  name,
  path: `/tmp/${id}`,
  workspaceKind: "project",
  createdAt: "2026-03-12T00:00:00.000Z",
  lastOpenedAt: "2026-03-12T00:00:00.000Z",
  defaultEnableMcp: true,
  defaultBackupsEnabled: true,
  defaultProvider: "google",
  defaultModel: "gemini-2.5-flash",
  yolo: false,
});

describe("new chat landing target helpers", () => {
  test("defaults to the selected project workspace", () => {
    const workspaces = [projectWorkspace("ws-1", "Cowork"), projectWorkspace("ws-2", "Other")];

    expect(resolveDefaultNewChatTarget(workspaces, "ws-2")).toEqual({
      kind: "project",
      workspaceId: "ws-2",
    });
  });

  test("resolves one-off landing targets to no project highlight", () => {
    const workspaces = [projectWorkspace("ws-1", "Cowork")];

    expect(
      resolveNewChatLandingProjectWorkspaceId({ kind: "oneOff" }, workspaces, "ws-1"),
    ).toBeNull();
  });

  test("falls back when a stored project target no longer exists", () => {
    const workspaces = [projectWorkspace("ws-1", "Cowork")];

    expect(
      resolveNewChatLandingTarget({ kind: "project", workspaceId: "missing" }, workspaces, "ws-1"),
    ).toEqual({
      kind: "project",
      workspaceId: "ws-1",
    });
  });
});
