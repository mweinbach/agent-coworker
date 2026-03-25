import { describe, expect, test } from "bun:test";

import type { ExplorerEntry } from "../src/app/types";
import {
  buildDirectoryFingerprint,
  buildExplorerRows,
  explorerRowDomKey,
  normalizeExplorerPath,
  isTreeRowControlTarget,
  shouldAutoRefreshExplorer,
  shouldReuseBackgroundDirectorySnapshot,
} from "../src/ui/file-explorer/WorkspaceFileExplorer";
import { setupJsdom } from "./jsdomHarness";

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
  test("explorerRowDomKey is stable for entry and status rows", () => {
    const entryRow = {
      kind: "entry" as const,
      depth: 0,
      expanded: false,
      entry: entry({ name: "a.ts", path: "/w/a.ts", isDirectory: false }),
    };
    const statusRow = {
      kind: "status" as const,
      depth: 1,
      path: "/w/src",
      status: "empty" as const,
      message: "Empty folder",
    };
    expect(explorerRowDomKey(entryRow)).toBe("/w/a.ts");
    expect(explorerRowDomKey(statusRow)).toBe("/w/src:empty");
  });

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

  test("skips unchanged background snapshot updates", () => {
    const entries = [
      entry({ name: "a.txt", path: "/tmp/a.txt", isDirectory: false, sizeBytes: 1 }),
      entry({ name: "b", path: "/tmp/b", isDirectory: true }),
    ];
    const fingerprint = buildDirectoryFingerprint(entries);

    expect(
      shouldReuseBackgroundDirectorySnapshot(
        { error: null, fingerprint },
        fingerprint,
        null,
      )
    ).toBe(true);
    expect(
      shouldReuseBackgroundDirectorySnapshot(
        { error: null, fingerprint },
        `${fingerprint}:changed`,
        null,
      )
    ).toBe(false);
    expect(
      shouldReuseBackgroundDirectorySnapshot(
        { error: "old error", fingerprint },
        fingerprint,
        null,
      )
    ).toBe(false);
  });

  test("auto refresh polling only runs while visible and focused", () => {
    expect(shouldAutoRefreshExplorer("visible", true)).toBe(true);
    expect(shouldAutoRefreshExplorer("hidden", true)).toBe(false);
    expect(shouldAutoRefreshExplorer("visible", false)).toBe(false);
  });

  test("treats SVG descendants inside control buttons as control targets", () => {
    const harness = setupJsdom();

    try {
      const button = harness.dom.window.document.createElement("button");
      button.setAttribute("data-file-explorer-control", "true");
      const svg = harness.dom.window.document.createElementNS("http://www.w3.org/2000/svg", "svg");
      button.appendChild(svg);

      expect(isTreeRowControlTarget(svg)).toBe(true);
    } finally {
      harness.restore();
    }
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

  test("buildExplorerRows still nests children while a directory refresh is in flight if entries are cached", () => {
    const root = "/workspace";
    const srcPath = "/workspace/src";

    const rows = buildExplorerRows(
      root,
      new Set([root, srcPath]),
      {
        [root]: snapshot([entry({ name: "src", path: srcPath, isDirectory: true })]),
        [srcPath]: {
          entries: [entry({ name: "a.ts", path: `${srcPath}/a.ts`, isDirectory: false })],
          loading: true,
          error: null,
          updatedAt: 1700000000000,
          fingerprint: "fp",
        },
      }
    );

    expect(rows).toHaveLength(2);
    expect(rows[0].kind === "entry" && rows[0].entry.name).toBe("src");
    expect(rows[1].kind === "entry" && rows[1].entry.name).toBe("a.ts");
  });

  test("buildExplorerRows omits children while expanded directory is still loading (no loading row)", () => {
    const root = "/workspace";
    const srcPath = "/workspace/src";

    const rows = buildExplorerRows(
      root,
      new Set([root, srcPath]),
      {
        [root]: snapshot([entry({ name: "src", path: srcPath, isDirectory: true })]),
      }
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: "entry", depth: 0, expanded: true });
  });
});
