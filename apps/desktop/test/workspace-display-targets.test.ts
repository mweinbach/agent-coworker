import { describe, expect, test } from "bun:test";

import type { WorkspaceRecord } from "../src/app/types";
import {
  CHATS_WORKSPACE_TARGET_ID,
  parentDirectoryPath,
  resolveProjectWorkspaceId,
  resolveWorkspaceDisplayTargets,
  workspaceDisplayLabel,
  workspaceLabelForThread,
} from "../src/app/workspaceDisplayTargets";

function workspace(record: {
  id: string;
  name: string;
  path: string;
  workspaceKind?: WorkspaceRecord["workspaceKind"];
}): WorkspaceRecord {
  return {
    ...record,
    createdAt: "2026-06-02T00:00:00.000Z",
    lastOpenedAt: "2026-06-02T00:00:00.000Z",
    defaultEnableMcp: true,
    defaultBackupsEnabled: false,
    yolo: false,
  };
}

describe("workspace display targets", () => {
  test("collapse one-off chat workspaces into one Chats target", () => {
    const chatsRoot = "/tmp/home/.cowork/chats";
    const { targets, activeTarget } = resolveWorkspaceDisplayTargets(
      [
        workspace({
          id: "chat-1",
          name: "New chat",
          path: `${chatsRoot}/chat-1`,
          workspaceKind: "oneOffChat",
        }),
        workspace({
          id: "chat-2",
          name: "New chat",
          path: `${chatsRoot}/chat-2`,
          workspaceKind: "oneOffChat",
        }),
        workspace({ id: "project-1", name: "Cowork", path: "/Users/me/Projects/Cowork" }),
      ],
      "chat-2",
    );

    expect(targets.map((target) => target.label)).toEqual(["Chats", "Cowork"]);
    expect(activeTarget).toEqual({
      id: CHATS_WORKSPACE_TARGET_ID,
      label: "Chats",
      kind: "chats",
      workspaceId: "chat-2",
      targetPath: chatsRoot,
    });
  });

  test("keeps project workspaces as individual targets", () => {
    const { targets, activeTarget } = resolveWorkspaceDisplayTargets(
      [
        workspace({
          id: "chat-1",
          name: "New chat",
          path: "/tmp/home/.cowork/chats/chat-1",
          workspaceKind: "oneOffChat",
        }),
        workspace({ id: "project-1", name: "Cowork", path: "/Users/me/Projects/Cowork" }),
        workspace({ id: "project-2", name: "GoogleIO", path: "/Users/me/Projects/GoogleIO" }),
      ],
      "project-2",
    );

    expect(targets.map((target) => target.label)).toEqual(["Chats", "Cowork", "GoogleIO"]);
    expect(activeTarget?.id).toBe("project-2");
    expect(activeTarget?.targetPath).toBe("/Users/me/Projects/GoogleIO");
  });

  test("resolves project workspaces for management surfaces", () => {
    const workspaces = [
      workspace({
        id: "chat-1",
        name: "New chat",
        path: "/tmp/home/.cowork/chats/chat-1",
        workspaceKind: "oneOffChat",
      }),
      workspace({ id: "project-1", name: "Cowork", path: "/Users/me/Projects/Cowork" }),
      workspace({ id: "project-2", name: "GoogleIO", path: "/Users/me/Projects/GoogleIO" }),
    ];

    expect(resolveProjectWorkspaceId(workspaces, "project-2")).toBe("project-2");
    expect(resolveProjectWorkspaceId(workspaces, "chat-1")).toBeNull();
    expect(resolveProjectWorkspaceId([workspaces[0]], "chat-1")).toBeNull();
    expect(resolveProjectWorkspaceId([workspaces[0], workspaces[1]], "chat-1")).toBe("project-1");
  });

  test("labels one-off chat metadata as Chats", () => {
    const chat = workspace({
      id: "chat-1",
      name: "New chat",
      path: "/tmp/home/.cowork/chats/chat-1",
      workspaceKind: "oneOffChat",
    });
    const project = workspace({ id: "project-1", name: "Cowork", path: "/Users/me/Cowork" });

    expect(workspaceDisplayLabel(chat)).toBe("Chats");
    expect(workspaceDisplayLabel(project)).toBe("Cowork");
    expect(workspaceLabelForThread([chat, project], "chat-1", "Unknown workspace")).toBe("Chats");
    expect(workspaceLabelForThread([chat, project], "missing", "Unknown workspace")).toBe(
      "Unknown workspace",
    );
  });

  test("parent directory resolver handles slash styles used by chat paths", () => {
    expect(parentDirectoryPath("/tmp/.cowork/chats/chat-1")).toBe("/tmp/.cowork/chats");
    expect(parentDirectoryPath(String.raw`C:\Users\me\.cowork\chats\chat-1`)).toBe(
      String.raw`C:\Users\me\.cowork\chats`,
    );
  });
});
