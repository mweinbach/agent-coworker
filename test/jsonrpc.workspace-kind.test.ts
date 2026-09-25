import { describe, expect, test } from "bun:test";
import path from "node:path";
import { classifyWorkspaceKind } from "../src/server/jsonrpc/workspaceCatalog";
import { withWorkspaceKindSource } from "../src/utils/oneOffChats";

const home = path.join("/home", "tester");
const chatPath = path.join(home, ".cowork", "chats", "draft");
const projectPath = path.join(home, "repo");

describe("classifyWorkspaceKind", () => {
  test("keeps an explicit or path-sourced project even under the one-off chats root", () => {
    for (const source of ["explicit", "path"] as const) {
      const record = withWorkspaceKindSource(
        { path: chatPath, workspaceKind: "project" as const },
        source,
      );
      expect(classifyWorkspaceKind(record, home)).toBe("project");
    }
  });

  test("reclassifies a default project label when the directory is a one-off chat", () => {
    const record = withWorkspaceKindSource(
      { path: chatPath, workspaceKind: "project" as const },
      "default",
    );
    expect(classifyWorkspaceKind(record, home)).toBe("oneOffChat");
  });

  test("uses the stored one-off kind outside the chats root and the path when kind is absent", () => {
    expect(classifyWorkspaceKind({ path: projectPath, workspaceKind: "oneOffChat" }, home)).toBe(
      "oneOffChat",
    );
    expect(classifyWorkspaceKind({ path: chatPath }, home)).toBe("oneOffChat");
    expect(classifyWorkspaceKind({ path: projectPath, workspaceKind: "nope" }, home)).toBe(
      "project",
    );
  });
});
