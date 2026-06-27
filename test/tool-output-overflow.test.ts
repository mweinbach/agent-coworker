import { describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { maybeSpillToolOutputToWorkspace } from "../src/runtime/toolOutputOverflow";
import { MODEL_SCRATCHPAD_DIRNAME } from "../src/shared/toolOutputOverflow";

describe("tool output overflow", () => {
  test("keeps oversized SKILL.md content inline", async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-overflow-skill-inline-"));
    const skillBody = `# Large skill\n\n${"Follow these instructions.\n".repeat(100)}`;

    const result = await maybeSpillToolOutputToWorkspace({
      output: skillBody,
      toolName: "skill",
      toolCallId: "call-skill",
      workingDirectory: workspace,
      toolOutputOverflowChars: 10,
    });

    expect(result).toBeNull();
    await expect(fs.readdir(path.join(workspace, MODEL_SCRATCHPAD_DIRNAME))).rejects.toThrow();
  });

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
