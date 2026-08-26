import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import path from "node:path";
import { scratchRoots } from "../../../src/platform/sandbox/policy";
import {
  assertDirection,
  assertPathWithinRoots,
  assertSafeId,
  assertValidFileName,
  assertWithinTranscriptsDir,
  assertWorkspaceDirectory,
} from "../electron/services/validation";

describe("desktop Electron IPC validation", () => {
  let root: string;
  let outside: string;

  beforeEach(async () => {
    const scratch = scratchRoots()[0] ?? "/tmp";
    root = await fs.mkdtemp(path.join(scratch, "cowork-electron-root-"));
    outside = await fs.mkdtemp(path.join(scratch, "cowork-electron-outside-"));
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(outside, { recursive: true, force: true });
  });

  test("assertSafeId accepts ids and rejects traversal or punctuation", () => {
    expect(() => assertSafeId("workspace-1", "workspaceId")).not.toThrow();
    expect(() => assertSafeId("A".repeat(256), "workspaceId")).not.toThrow();
    expect(() => assertSafeId("../etc", "workspaceId")).toThrow(
      "workspaceId contains invalid characters",
    );
    expect(() => assertSafeId("ws/1", "workspaceId")).toThrow(
      "workspaceId contains invalid characters",
    );
    expect(() => assertSafeId("has space", "sessionId")).toThrow(
      "sessionId contains invalid characters",
    );
    expect(() => assertSafeId("A".repeat(257), "workspaceId")).toThrow(
      "workspaceId contains invalid characters",
    );
  });

  test("assertValidFileName rejects empty, dotted, and separator names", () => {
    expect(() => assertValidFileName("notes.md", "fileName")).not.toThrow();
    expect(() => assertValidFileName("", "fileName")).toThrow("fileName is invalid");
    expect(() => assertValidFileName("..", "fileName")).toThrow("fileName is invalid");
    expect(() => assertValidFileName(".", "fileName")).toThrow("fileName is invalid");
    expect(() => assertValidFileName("a/b", "fileName")).toThrow("fileName is invalid");
    expect(() => assertValidFileName("a\\b", "fileName")).toThrow("fileName is invalid");
    expect(() => assertValidFileName("a\0b", "fileName")).toThrow("fileName is invalid");
  });

  test("assertDirection normalizes server/client and rejects other values", () => {
    expect(assertDirection(" Server ")).toBe("server");
    expect(assertDirection("CLIENT")).toBe("client");
    expect(() => assertDirection("both")).toThrow("direction must be 'server' or 'client'");
  });

  test("assertWorkspaceDirectory requires an existing directory", async () => {
    await expect(assertWorkspaceDirectory(root)).resolves.toBeUndefined();
    await expect(assertWorkspaceDirectory("   ")).rejects.toThrow(
      "workspacePath must not be empty",
    );
    await expect(assertWorkspaceDirectory(path.join(root, "missing"))).rejects.toThrow(
      "Workspace path does not exist",
    );

    const filePath = path.join(root, "file.txt");
    await fs.writeFile(filePath, "x");
    await expect(assertWorkspaceDirectory(filePath)).rejects.toThrow(
      "Workspace path is not a directory",
    );
  });

  test("assertWithinTranscriptsDir rejects resolved paths that escape the root", () => {
    const inside = path.join(root, "thread-1.json");
    expect(() => assertWithinTranscriptsDir(root, inside)).not.toThrow();
    expect(() =>
      assertWithinTranscriptsDir(root, path.join(root, "..", path.basename(outside), "x.json")),
    ).toThrow("Resolved transcript path escapes transcript root");
  });

  test("assertPathWithinRoots accepts in-root paths and rejects symlink escapes", async () => {
    const nested = path.join(root, "src", "notes.md");
    await fs.mkdir(path.dirname(nested), { recursive: true });
    await fs.writeFile(nested, "ok");
    await fs.writeFile(path.join(outside, "secret.txt"), "secret");

    expect(assertPathWithinRoots([root], nested, "path")).toBe(await fs.realpath(nested));
    expect(() => assertPathWithinRoots([root], "  ", "path")).toThrow("path must not be empty");
    expect(() => assertPathWithinRoots([root], path.join(outside, "secret.txt"), "path")).toThrow(
      "path is outside allowed workspace roots",
    );

    const escapeLink = path.join(root, "escape");
    await fs.symlink(outside, escapeLink);
    expect(() =>
      assertPathWithinRoots([root], path.join(escapeLink, "secret.txt"), "path"),
    ).toThrow("path is outside allowed workspace roots");
  });
});
