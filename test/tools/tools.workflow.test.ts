import { describe, expect, mock, test } from "bun:test";
import fs from "node:fs/promises";
import path from "node:path";

import { createWorkflowTool } from "../../src/tools/workflow";
import { makeFakeControl, makeWorkflowCtx, metaHeader, workflowTmpDir } from "../workflows/harness";

function workflowSource(name: string): string {
  return (
    `${metaHeader(name)}` +
    "export default async function run({ args }) { return { value: args.value }; }"
  );
}

async function makeToolContext() {
  const root = await workflowTmpDir();
  const projectCoworkDir = path.join(root, "project", ".cowork");
  const assertCanMutate = mock(async () => {});
  const ctx = makeWorkflowCtx(projectCoworkDir, {
    agentControl: makeFakeControl(),
    assertCanMutate,
  });
  ctx.config = {
    ...ctx.config,
    userCoworkDir: path.join(root, "user", ".cowork"),
    builtInDir: path.join(root, "built-in"),
  };
  return { ctx, assertCanMutate };
}

describe("workflow tool saved definitions", () => {
  test("lists without mutation and saves project workflows", async () => {
    const { ctx, assertCanMutate } = await makeToolContext();
    const tool = createWorkflowTool(ctx);
    expect(tool).not.toBeNull();
    if (!tool) return;

    const empty = await tool.execute({ action: "list" });
    expect(empty).toEqual({ ok: true, workflows: [], diagnostics: [] });
    expect(assertCanMutate).not.toHaveBeenCalled();

    const saved = await tool.execute({
      action: "save",
      name: "project-report",
      scope: "project",
      script: workflowSource("project-report"),
    });
    expect(saved).toEqual({
      ok: true,
      saved: expect.objectContaining({ name: "project-report", scope: "project" }),
    });
    expect(assertCanMutate).toHaveBeenCalledTimes(1);
    expect(
      await fs.readFile(
        path.join(ctx.config.projectCoworkDir, "workflows", "project-report.ts"),
        "utf8",
      ),
    ).toContain('name":"project-report"');
  });

  test("runs saved workflows by name and reports their definition", async () => {
    const { ctx, assertCanMutate } = await makeToolContext();
    const tool = createWorkflowTool(ctx);
    if (!tool) throw new Error("workflow tool was not created");

    await tool.execute({
      action: "save",
      name: "named-run",
      scope: "global",
      script: workflowSource("named-run"),
    });
    const result = await tool.execute({ action: "run", name: "named-run", args: { value: 7 } });

    expect(result).toEqual(
      expect.objectContaining({
        ok: true,
        result: { value: 7 },
        definition: expect.objectContaining({ name: "named-run", scope: "global" }),
      }),
    );
    expect(assertCanMutate).toHaveBeenCalledTimes(2);
  });

  test("allows inline and named dry runs when mutations are blocked", async () => {
    const { ctx, assertCanMutate } = await makeToolContext();
    const control = makeFakeControl();
    const onWorkflowProgress = mock(() => {});
    ctx.agentControl = control;
    ctx.onWorkflowProgress = onWorkflowProgress;
    assertCanMutate.mockImplementation(async () => {
      throw new Error("workflow mutations are blocked");
    });
    const tool = createWorkflowTool(ctx);
    if (!tool) throw new Error("workflow tool was not created");
    const workflowDir = path.join(ctx.config.projectCoworkDir, "workflows");
    await fs.mkdir(workflowDir, { recursive: true });
    const script =
      `${metaHeader("read-only-preview")}` +
      'export default async function run({ agent, args }) { await agent("preview"); return { value: args.value }; }';
    await fs.writeFile(path.join(workflowDir, "read-only-preview.ts"), script);

    const inline = await tool.execute({ script, args: { value: 3 }, dryRun: true });
    const named = await tool.execute({
      action: "run",
      name: "read-only-preview",
      args: { value: 7 },
      dryRun: true,
    });

    expect(inline).toEqual(
      expect.objectContaining({ ok: true, result: { value: 3 }, agentCount: 1, spentUsd: 0 }),
    );
    expect(named).toEqual(
      expect.objectContaining({
        ok: true,
        result: { value: 7 },
        agentCount: 1,
        spentUsd: 0,
        definition: expect.objectContaining({ name: "read-only-preview", scope: "project" }),
      }),
    );
    expect(assertCanMutate).not.toHaveBeenCalled();
    expect(control.spawnCount()).toBe(0);
    expect(onWorkflowProgress).not.toHaveBeenCalled();

    await expect(tool.execute({ script, args: { value: 9 } })).rejects.toThrow(
      "workflow mutations are blocked",
    );
    expect(assertCanMutate).toHaveBeenCalledTimes(1);
  });

  test("named dry runs still validate metadata when mutations are blocked", async () => {
    const { ctx, assertCanMutate } = await makeToolContext();
    assertCanMutate.mockImplementation(async () => {
      throw new Error("workflow mutations are blocked");
    });
    const tool = createWorkflowTool(ctx);
    if (!tool) throw new Error("workflow tool was not created");
    const workflowDir = path.join(ctx.config.projectCoworkDir, "workflows");
    await fs.mkdir(workflowDir, { recursive: true });
    await fs.writeFile(path.join(workflowDir, "mismatch.ts"), workflowSource("different-name"));

    await expect(tool.execute({ action: "run", name: "mismatch", dryRun: true })).rejects.toThrow(
      'workflow filename/name mismatch: expected meta.name "mismatch", found "different-name"',
    );
    expect(assertCanMutate).not.toHaveBeenCalled();
  });

  test("named runs validate metadata in the execution worker", async () => {
    const { ctx, assertCanMutate } = await makeToolContext();
    const tool = createWorkflowTool(ctx);
    if (!tool) throw new Error("workflow tool was not created");
    const workflowDir = path.join(ctx.config.projectCoworkDir, "workflows");
    await fs.mkdir(workflowDir, { recursive: true });
    await fs.writeFile(path.join(workflowDir, "mismatch.ts"), workflowSource("different-name"));

    await expect(tool.execute({ action: "run", name: "mismatch" })).rejects.toThrow(
      'workflow filename/name mismatch: expected meta.name "mismatch", found "different-name"',
    );
    expect(assertCanMutate).toHaveBeenCalledTimes(1);
  });

  test("keeps legacy inline runs and rejects ambiguous run sources", async () => {
    const { ctx } = await makeToolContext();
    const tool = createWorkflowTool(ctx);
    if (!tool) throw new Error("workflow tool was not created");

    const result = await tool.execute({ script: workflowSource("inline-run"), args: { value: 9 } });
    expect(result).toEqual(expect.objectContaining({ ok: true, result: { value: 9 } }));

    await expect(
      tool.execute({
        action: "run",
        name: "inline-run",
        script: workflowSource("inline-run"),
      }),
    ).rejects.toThrow("exactly one of name or script");
  });
});
