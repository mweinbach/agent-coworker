import { describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import path from "node:path";

import { scratchRoots } from "../../../src/platform/sandbox";
import {
  assertDirection,
  assertSafeId,
  assertWithinTranscriptsDir,
  assertWorkspaceDirectory,
} from "../electron/services/validation";

describe("desktop identifier and transcript gates", () => {
  test("assertSafeId accepts bounded ids and rejects path or punctuation characters", () => {
    expect(() => assertSafeId("Thread_1-ok", "workspaceId")).not.toThrow();
    expect(() => assertSafeId("a".repeat(256), "threadId")).not.toThrow();

    for (const id of [
      "",
      " thread",
      "thread ",
      "thread 1",
      "thread/1",
      "thread\\1",
      ".",
      "..",
      "thread.id",
      "thread\0",
      "a".repeat(257),
    ]) {
      expect(() => assertSafeId(id, "threadId")).toThrow("threadId contains invalid characters");
    }
  });

  test("assertDirection normalizes case and whitespace and rejects other values", () => {
    expect(assertDirection("server")).toBe("server");
    expect(assertDirection(" Client ")).toBe("client");
    expect(assertDirection("SERVER\n")).toBe("server");

    for (const direction of ["", "both", "servers", "client/server"]) {
      expect(() => assertDirection(direction)).toThrow("direction must be 'server' or 'client'");
    }
  });

  test("assertWithinTranscriptsDir rejects paths that leave the transcript root", () => {
    const root = path.resolve("cowork-transcript-root");
    expect(() => assertWithinTranscriptsDir(root, root)).not.toThrow();
    expect(() => assertWithinTranscriptsDir(root, path.join(root, "thread_1.jsonl"))).not.toThrow();

    expect(() =>
      assertWithinTranscriptsDir(root, path.resolve(root, "..", "outside.jsonl")),
    ).toThrow("Resolved transcript path escapes transcript root");
    expect(() =>
      assertWithinTranscriptsDir(root, path.join(`${root}-other`, "thread.jsonl")),
    ).toThrow("Resolved transcript path escapes transcript root");
  });
});

describe("assertWorkspaceDirectory", () => {
  test("rejects blank, missing, and non-directory workspace paths", async () => {
    for (const blank of ["", "   "]) {
      await expect(assertWorkspaceDirectory(blank)).rejects.toThrow(
        "workspacePath must not be empty",
      );
    }

    const dir = await fs.mkdtemp(path.join(scratchRoots()[0]!, "cowork-workspace-gate-"));
    const filePath = path.join(dir, "not-a-dir");
    try {
      await fs.writeFile(filePath, "x");
      await expect(assertWorkspaceDirectory(path.join(dir, "missing"))).rejects.toThrow(
        "Workspace folder is unavailable",
      );
      await expect(assertWorkspaceDirectory(filePath)).rejects.toThrow(
        "Workspace path is not a directory",
      );
      await expect(assertWorkspaceDirectory(dir)).resolves.toBeUndefined();
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
