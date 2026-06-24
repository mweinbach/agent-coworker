import { describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { maybeSpillToolOutputToWorkspace } from "../src/runtime/toolOutputOverflow";
import { MODEL_SCRATCHPAD_DIRNAME } from "../src/shared/toolOutputOverflow";

describe("tool output overflow", () => {
  test("does not spill oversized read tool output", async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-overflow-workspace-"));

    const result = await maybeSpillToolOutputToWorkspace({
      output: "large-file-content-".repeat(50),
      toolName: "read",
      toolCallId: "call-1",
      workingDirectory: workspace,
      toolOutputOverflowChars: 10,
    });

    expect(result).toBeNull();
    await expect(fs.stat(path.join(workspace, MODEL_SCRATCHPAD_DIRNAME))).rejects.toThrow();
  });

  test("does not spill when overflow threshold is disabled", async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-overflow-workspace-"));

    const result = await maybeSpillToolOutputToWorkspace({
      output: "oversized-output-".repeat(50),
      toolName: "bash",
      toolCallId: "call-1",
      workingDirectory: workspace,
      toolOutputOverflowChars: null,
    });

    expect(result).toBeNull();
    await expect(fs.stat(path.join(workspace, MODEL_SCRATCHPAD_DIRNAME))).rejects.toThrow();
  });

  test("does not spill image-bearing rich output", async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-overflow-workspace-"));

    const result = await maybeSpillToolOutputToWorkspace({
      output: [
        { type: "text", text: "oversized-output-".repeat(50) },
        { type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" },
      ],
      toolName: "screenshot",
      toolCallId: "call-1",
      workingDirectory: workspace,
      toolOutputOverflowChars: 10,
    });

    expect(result).toBeNull();
    await expect(fs.stat(path.join(workspace, MODEL_SCRATCHPAD_DIRNAME))).rejects.toThrow();
  });

  test("spills oversized non-exempt output and preserves summary metadata", async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-overflow-workspace-"));
    const output = {
      type: "text",
      value: "oversized-output-".repeat(50),
      exitCode: 0,
      ok: true,
      count: 42,
      provider: "local",
    };

    const result = await maybeSpillToolOutputToWorkspace({
      output,
      toolName: "bash",
      toolCallId: "call:with/unsafe chars",
      workingDirectory: workspace,
      toolOutputOverflowChars: 10,
    });

    expect(result).not.toBeNull();
    expect(result?.file.kind).toBe("tool-output-overflow");
    expect(result?.file.toolName).toBe("bash");
    expect(result?.output).toMatchObject({
      type: "text",
      overflow: true,
      exitCode: 0,
      ok: true,
      count: 42,
      provider: "local",
    });
    expect(String(result?.output.value)).toContain("Tool output overflowed");
    expect(String(result?.output.value)).toContain("Use the read tool to inspect the saved file");
    expect(result?.file.path).toContain(MODEL_SCRATCHPAD_DIRNAME);
    expect(path.basename(result?.file.path ?? "")).toContain("bash__call-with-unsafe-chars");
    await expect(fs.readFile(result?.file.path ?? "", "utf-8")).resolves.toBe(output.value);
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
