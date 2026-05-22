import { describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { maybeSpillToolOutputToWorkspace } from "../src/runtime/toolOutputOverflow";
import { MODEL_SCRATCHPAD_DIRNAME } from "../src/shared/toolOutputOverflow";

describe("tool output overflow", () => {
  test("refuses to spill into a symlinked scratchpad directory", async () => {
    if (process.platform === "win32") {
      return;
    }
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-overflow-workspace-"));
    const target = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-overflow-target-"));
    const logs: string[] = [];

    await fs.symlink(target, path.join(workspace, MODEL_SCRATCHPAD_DIRNAME), "dir");

    const result = await maybeSpillToolOutputToWorkspace({
      output: "oversized-output-".repeat(50),
      toolName: "lookup",
      toolCallId: "call-1",
      workingDirectory: workspace,
      toolOutputOverflowChars: 10,
      log: (line) => logs.push(line),
    });

    expect(result).toBeNull();
    expect(logs.join("\n")).toContain(`${MODEL_SCRATCHPAD_DIRNAME} must not be a symbolic link`);
    expect(await fs.readdir(target)).toEqual([]);
  });
});
