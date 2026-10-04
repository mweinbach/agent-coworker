import { describe, expect, test } from "bun:test";
import path from "node:path";
import { classifyWorkspaceKind } from "../src/server/jsonrpc/workspaceCatalog";
import { withWorkspaceKindSource } from "../src/utils/oneOffChats";

const home = path.join("/home", "tester");
const chatPath = path.join(home, ".cowork", "chats", "draft");
const projectPath = path.join(home, "repo");

describe("classifyWorkspaceKind", () => {
  test("classifies explicit, default, and stored workspace kinds accurately", () => {
    for (const source of ["explicit", "path"] as const) {
      expect(
        classifyWorkspaceKind(
          withWorkspaceKindSource({ path: chatPath, workspaceKind: "project" as const }, source),
          home,
        ),
      ).toBe("project");
    }
    expect(
      classifyWorkspaceKind(
        withWorkspaceKindSource({ path: chatPath, workspaceKind: "project" as const }, "default"),
        home,
      ),
    ).toBe("oneOffChat");
    expect(classifyWorkspaceKind({ path: projectPath, workspaceKind: "oneOffChat" }, home)).toBe(
      "oneOffChat",
    );
    expect(classifyWorkspaceKind({ path: chatPath }, home)).toBe("oneOffChat");
    expect(classifyWorkspaceKind({ path: projectPath, workspaceKind: "nope" }, home)).toBe(
      "project",
    );
  });
});
