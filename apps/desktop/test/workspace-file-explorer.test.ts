import { describe, expect, test } from "bun:test";

import type { ExplorerEntry } from "../src/app/types";
import {
  buildDirectoryFingerprint,
  buildExplorerRows,
  normalizeExplorerPath,
} from "../src/ui/file-explorer/WorkspaceFileExplorer";

function entry(partial: Partial<ExplorerEntry> & Pick<ExplorerEntry, "name" | "path" | "isDirectory">): ExplorerEntry {
  return {
    isHidden: false,
    sizeBytes: partial.isDirectory ? null : 100,
    modifiedAtMs: 1700000000000,
    ...partial,
  };
}

function snapshot(entries: ExplorerEntry[]) {
  return {
    entries,
    loading: false,
    error: null,
    updatedAt: 1700000000000,
    fingerprint: "",
  };
}

describe("workspace file explorer helpers", () => {
  test("normalizes separators and trailing slash", () => {
    expect(normalizeExplorerPath("C:\\Users\\me\\project\\")).toBe("C:/Users/me/project");
    expect(normalizeExplorerPath("/tmp/workspace/")).toBe("/tmp/workspace");
    expect(normalizeExplorerPath("/")).toBe("/");
  });

  test("buildDirectoryFingerprint is stable regardless entry order", () => {
    const first = [
      entry({ name: "a.txt", path: "/tmp/a.txt", isDirectory: false, sizeBytes: 1 }),
      entry({ name: "b", path: "/tmp/b", isDirectory: true }),
    ];
    const second = [...first].reverse();

    expect(buildDirectoryFingerprint(first)).toBe(buildDirectoryFingerprint(second));
  });

  test("buildExplorerRows nests expanded directory entries", () => {
    const root = "/workspace";
    const srcPath = "/workspace/src";
    const readmePath = "/workspace/README.md";

    const rows = buildExplorerRows(
      root,
      new Set([root, srcPath]),
      {
        [root]: snapshot([
          entry({ name: "src", path: srcPath, isDirectory: true }),
          entry({ name: "README.md", path: readmePath, isDirectory: false }),
        ]),
        [srcPath]: snapshot([entry({ name: "index.ts", path: `${srcPath}/index.ts`, isDirectory: false })]),
      }
    );

    expect(rows).toHaveLength(3);
    expect(rows[0]).toMatchObject({ kind: "entry", depth: 0, expanded: true });
    expect(rows[0].kind === "entry" ? rows[0].entry.name : "").toBe("src");
    expect(rows[1]).toMatchObject({ kind: "entry", depth: 1 });
    expect(rows[1].kind === "entry" ? rows[1].entry.name : "").toBe("index.ts");
    expect(rows[2]).toMatchObject({ kind: "entry", depth: 0 });
    expect(rows[2].kind === "entry" ? rows[2].entry.name : "").toBe("README.md");
  });

  test("buildExplorerRows emits loading placeholder for expanded directories without children snapshot", () => {
    const root = "/workspace";
    const srcPath = "/workspace/src";

    const rows = buildExplorerRows(
      root,
      new Set([root, srcPath]),
      {
        [root]: snapshot([entry({ name: "src", path: srcPath, isDirectory: true })]),
      }
    );

    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ kind: "entry", depth: 0, expanded: true });
    expect(rows[1]).toMatchObject({
      kind: "status",
      depth: 1,
      path: srcPath,
      status: "loading",
    });
  });
});
