import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import path from "node:path";

import { removeWithRetry } from "../src/platform/fs";
import { scratchRoots } from "../src/platform/sandbox";
import { maybeSpillToolOutputToWorkspace } from "../src/runtime/toolOutputOverflow";
import { MODEL_SCRATCHPAD_DIRNAME } from "../src/shared/toolOutputOverflow";

const temporaryDirectories: string[] = [];

async function makeWorkspace(): Promise<string> {
  const directory = await fs.mkdtemp(
    path.join(scratchRoots()[0] ?? "/tmp", "cowork-overflow-gate-"),
  );
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  while (temporaryDirectories.length > 0) {
    const directory = temporaryDirectories.pop();
    if (directory) await removeWithRetry(directory, { recursive: true, bestEffort: true });
  }
});

describe("tool output overflow mutation-gate rollback", () => {
  test("does not create a scratchpad when the pre-mkdir gate closes", async () => {
    const workspace = await makeWorkspace();
    const logs: string[] = [];

    const result = await maybeSpillToolOutputToWorkspace({
      output: "oversized-output-".repeat(20),
      toolName: "bash",
      toolCallId: "call-pre",
      workingDirectory: workspace,
      toolOutputOverflowChars: 10,
      assertCanMutate: () => {
        throw new Error("gate closed before mkdir");
      },
      log: (line) => logs.push(line),
    });

    expect(result).toBeNull();
    expect(logs.join("\n")).toContain("gate closed before mkdir");
    await expect(fs.stat(path.join(workspace, MODEL_SCRATCHPAD_DIRNAME))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  test("rolls back a newly created scratchpad when the post-mkdir gate closes", async () => {
    const workspace = await makeWorkspace();
    const logs: string[] = [];
    let checks = 0;

    const result = await maybeSpillToolOutputToWorkspace({
      output: "oversized-output-".repeat(20),
      toolName: "lookup",
      toolCallId: "call-post",
      workingDirectory: workspace,
      toolOutputOverflowChars: 10,
      assertCanMutate: () => {
        checks += 1;
        if (checks > 1) throw new Error("gate closed after mkdir");
      },
      log: (line) => logs.push(line),
    });

    expect(result).toBeNull();
    expect(checks).toBe(2);
    expect(logs.join("\n")).toContain("gate closed after mkdir");
    await expect(fs.stat(path.join(workspace, MODEL_SCRATCHPAD_DIRNAME))).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(await fs.readdir(workspace)).toEqual([]);
  });
});
