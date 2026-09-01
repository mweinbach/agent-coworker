import { describe, expect, spyOn, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { scratchRoots } from "../src/platform/sandbox/policy";

import {
  __internal,
  directoriesFromGitRootToWorkspace,
  loadProjectAgentsFiles,
  loadProjectInstructionsSection,
  PROJECT_INSTRUCTIONS_MAX_BYTES,
} from "../src/projectInstructions";

describe("directoriesFromGitRootToWorkspace", () => {
  test("returns only workspace when no git root", () => {
    const ws = path.join("/repo", "apps", "web");
    expect(directoriesFromGitRootToWorkspace(ws, undefined)).toEqual([path.resolve(ws)]);
  });

  test("walks from git root to workspace when nested", () => {
    const git = path.join("/tmp", "mono");
    const ws = path.join(git, "apps", "web");
    expect(directoriesFromGitRootToWorkspace(ws, git)).toEqual([
      path.resolve(git),
      path.resolve(git, "apps"),
      path.resolve(ws),
    ]);
  });

  test("when workspace is git root, single directory", () => {
    const git = path.join("/tmp", "repo");
    expect(directoriesFromGitRootToWorkspace(git, git)).toEqual([path.resolve(git)]);
  });

  test("when git root is not an ancestor of workspace, only workspace", () => {
    const ws = path.join("/other", "proj");
    expect(directoriesFromGitRootToWorkspace(ws, "/tmp/unrelated")).toEqual([path.resolve(ws)]);
  });

  test("keeps ancestor instructions for directory names beginning with two dots", () => {
    const git = path.resolve("/repo");
    const ws = path.join(git, "..cache", "app");
    expect(directoriesFromGitRootToWorkspace(ws, git)).toEqual([
      git,
      path.join(git, "..cache"),
      ws,
    ]);
  });
});

describe("loadProjectAgentsFiles and section", () => {
  test("bounds instruction file reads before rendering an oversized UTF-8 file", async () => {
    const tmp = await fs.mkdtemp(path.join(scratchRoots()[0], "agents-read-cap-"));
    let totalBytesRead = 0;
    let openHandles = 0;
    try {
      await fs.mkdir(path.join(tmp, ".git"));
      const workspace = path.join(tmp, "workspace");
      await fs.mkdir(workspace);
      await fs.writeFile(path.join(tmp, "AGENTS.md"), "ROOT MUST NOT DISPLACE THE LEAF");
      await fs.writeFile(
        path.join(workspace, "AGENTS.md"),
        "界".repeat(PROJECT_INSTRUCTIONS_MAX_BYTES),
      );
      const io = {
        stat: fs.stat,
        readFile: async (filePath: string) => {
          const value = await fs.readFile(filePath, "utf8");
          totalBytesRead += Buffer.byteLength(value, "utf8");
          return value;
        },
        open: async (filePath: string, flags: string) => {
          const handle = await fs.open(filePath, flags);
          openHandles += 1;
          const originalRead = handle.read.bind(handle);
          const originalClose = handle.close.bind(handle);
          spyOn(handle, "read").mockImplementation(async (...args: any[]) => {
            const result = await (originalRead as (...args: any[]) => Promise<any>)(...args);
            totalBytesRead += result.bytesRead;
            return result;
          });
          spyOn(handle, "close").mockImplementation(async () => {
            openHandles -= 1;
            await originalClose();
          });
          return handle;
        },
      };

      const section = await loadProjectInstructionsSection(workspace, io);
      expect(section).toContain("界");
      expect(section).toContain("truncated");
      expect(section).not.toContain("\uFFFD");
      expect(section).not.toContain("ROOT MUST NOT DISPLACE THE LEAF");
      expect(Buffer.byteLength(section, "utf8")).toBeLessThanOrEqual(
        PROJECT_INSTRUCTIONS_MAX_BYTES,
      );
      expect(totalBytesRead).toBeLessThanOrEqual(PROJECT_INSTRUCTIONS_MAX_BYTES + 1);
      expect(openHandles).toBe(0);
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  test("root and nested workspace both contribute in order; override wins in same dir", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "agents-hier-"));
    await fs.mkdir(path.join(tmp, ".git"), { recursive: true });
    await fs.writeFile(path.join(tmp, "AGENTS.md"), "ROOT ONLY\n", "utf-8");

    const web = path.join(tmp, "apps", "web");
    await fs.mkdir(web, { recursive: true });
    await fs.writeFile(path.join(web, "AGENTS.override.md"), "WEB OVERRIDE\n", "utf-8");
    await fs.writeFile(path.join(web, "AGENTS.md"), "SHOULD NOT APPEAR\n", "utf-8");

    const files = await loadProjectAgentsFiles(web);
    expect(files.map((f) => [f.displayPath, f.filename, f.content.trim()])).toEqual([
      [".", "AGENTS.md", "ROOT ONLY"],
      ["apps/web", "AGENTS.override.md", "WEB OVERRIDE"],
    ]);

    const section = await loadProjectInstructionsSection(web);
    expect(section).toContain("## Project Instructions");
    expect(section).toContain("These instructions are loaded automatically");
    expect(section).toContain("### AGENTS.md for .");
    expect(section).toContain("ROOT ONLY");
    expect(section).toContain("### AGENTS.override.md for apps/web");
    expect(section).toContain("WEB OVERRIDE");
    expect(section).not.toContain("SHOULD NOT APPEAR");
  });

  test("without git, only workspace-level AGENTS.md is read", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "agents-no-git-"));
    const web = path.join(tmp, "apps", "web");
    await fs.mkdir(web, { recursive: true });
    await fs.writeFile(path.join(tmp, "AGENTS.md"), "OUTSIDE WS\n", "utf-8");
    await fs.writeFile(path.join(web, "AGENTS.md"), "INSIDE WS\n", "utf-8");

    const files = await loadProjectAgentsFiles(web);
    expect(files).toHaveLength(1);
    expect(files[0]!.displayPath).toBe(".");
    expect(files[0]!.content.trim()).toBe("INSIDE WS");
  });

  test("enforces UTF-8 byte cap with notice", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "agents-cap-"));
    await fs.mkdir(path.join(tmp, ".git"), { recursive: true });
    const huge = "x".repeat(PROJECT_INSTRUCTIONS_MAX_BYTES + 500);
    await fs.writeFile(path.join(tmp, "AGENTS.md"), huge, "utf-8");

    const section = await loadProjectInstructionsSection(tmp);
    expect(Buffer.byteLength(section, "utf8")).toBeLessThanOrEqual(PROJECT_INSTRUCTIONS_MAX_BYTES);
    expect(section).toContain("truncated");
  });

  test("enforces UTF-8 byte cap for non-ASCII content without replacement characters", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "agents-cap-unicode-"));
    await fs.mkdir(path.join(tmp, ".git"), { recursive: true });
    const huge = "界".repeat(PROJECT_INSTRUCTIONS_MAX_BYTES);
    await fs.writeFile(path.join(tmp, "AGENTS.md"), huge, "utf-8");

    const section = await loadProjectInstructionsSection(tmp);
    expect(Buffer.byteLength(section, "utf8")).toBeLessThanOrEqual(PROJECT_INSTRUCTIONS_MAX_BYTES);
    expect(section).toContain("truncated");
    expect(section).not.toContain("\uFFFD");
  });

  test("preserves the most specific workspace AGENTS content under the byte cap", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "agents-cap-specific-"));
    await fs.mkdir(path.join(tmp, ".git"), { recursive: true });
    await fs.writeFile(
      path.join(tmp, "AGENTS.md"),
      "R".repeat(PROJECT_INSTRUCTIONS_MAX_BYTES),
      "utf-8",
    );

    const web = path.join(tmp, "apps", "web");
    await fs.mkdir(web, { recursive: true });
    await fs.writeFile(path.join(web, "AGENTS.md"), "NESTED INSTRUCTION\n", "utf-8");

    const section = await loadProjectInstructionsSection(web);
    expect(Buffer.byteLength(section, "utf8")).toBeLessThanOrEqual(PROJECT_INSTRUCTIONS_MAX_BYTES);
    expect(section).toContain("truncated");
    expect(section).toContain("NESTED INSTRUCTION");
  });

  test("keeps only a contiguous suffix of the most specific AGENTS files under the byte cap", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "agents-cap-contiguous-"));
    await fs.mkdir(path.join(tmp, ".git"), { recursive: true });
    await fs.writeFile(path.join(tmp, "AGENTS.md"), "ROOT SHOULD DROP\n", "utf-8");

    const apps = path.join(tmp, "apps");
    await fs.mkdir(apps, { recursive: true });
    await fs.writeFile(
      path.join(apps, "AGENTS.md"),
      "M".repeat(PROJECT_INSTRUCTIONS_MAX_BYTES),
      "utf-8",
    );

    const web = path.join(apps, "web");
    await fs.mkdir(web, { recursive: true });
    await fs.writeFile(path.join(web, "AGENTS.md"), "LEAF SHOULD STAY\n", "utf-8");

    const section = await loadProjectInstructionsSection(web);
    expect(Buffer.byteLength(section, "utf8")).toBeLessThanOrEqual(PROJECT_INSTRUCTIONS_MAX_BYTES);
    expect(section).toContain("truncated");
    expect(section).toContain("LEAF SHOULD STAY");
    expect(section).not.toContain("ROOT SHOULD DROP");
    expect(section).not.toContain("### AGENTS.md for .");
  });

  test("falls back to a readable AGENTS.md when AGENTS.override.md cannot be read", async () => {
    const workspaceRoot = await fs.mkdtemp(path.join(scratchRoots()[0], "agents-read-fallback-"));
    try {
      await fs.writeFile(path.join(workspaceRoot, "AGENTS.override.md"), "UNREADABLE OVERRIDE\n");
      await fs.writeFile(path.join(workspaceRoot, "AGENTS.md"), "READABLE FALLBACK\n");
      const io = {
        stat: fs.stat,
        open: async (abs: string, flags: string) => {
          if (abs === path.join(workspaceRoot, "AGENTS.override.md")) {
            throw Object.assign(new Error("EACCES"), { code: "EACCES" });
          }
          return fs.open(abs, flags);
        },
      };

      const files = await loadProjectAgentsFiles(workspaceRoot, io);
      expect(files.map((f) => [f.displayPath, f.filename, f.content.trim()])).toEqual([
        [".", "AGENTS.md", "READABLE FALLBACK"],
      ]);

      const section = await loadProjectInstructionsSection(workspaceRoot, io);
      expect(section).toContain("READABLE FALLBACK");
    } finally {
      await fs.rm(workspaceRoot, { recursive: true, force: true });
    }
  });
});

describe("projectInstructions internals", () => {
  test("truncateUtf8Bytes keeps complete UTF-8 code points at an exact byte boundary", () => {
    expect(__internal.truncateUtf8Bytes("hello世界", 8)).toBe("hello世");
  });
});
