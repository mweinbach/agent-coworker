import { describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import path from "node:path";

import type { AgentConfig } from "../../src/types";
import {
  listWorkflowDefinitions,
  resolveWorkflowDefinition,
  saveWorkflowDefinition,
} from "../../src/workflows/registry";
import { metaHeader, workflowTmpDir } from "./harness";

type DefinitionConfig = Pick<AgentConfig, "projectCoworkDir" | "userCoworkDir" | "builtInDir">;

async function makeConfig(): Promise<DefinitionConfig> {
  const root = await workflowTmpDir();
  return {
    projectCoworkDir: path.join(root, "project", ".cowork"),
    userCoworkDir: path.join(root, "user", ".cowork"),
    builtInDir: path.join(root, "built-in"),
  };
}

function workflowSource(name: string, value: string): string {
  return `${metaHeader(name)}export default async function run() { return ${JSON.stringify(value)}; }`;
}

describe("saved workflow registry", () => {
  test("resolves project, global, and bundled definitions by precedence", async () => {
    const config = await makeConfig();
    const bundledDir = path.join(config.builtInDir, "workflows");
    await fs.mkdir(bundledDir, { recursive: true });
    await fs.writeFile(path.join(bundledDir, "shared.ts"), workflowSource("shared", "bundled"));

    let resolved = await resolveWorkflowDefinition(config, "shared");
    expect(resolved.scope).toBe("bundled");
    expect(resolved.source).toContain('return "bundled"');

    await saveWorkflowDefinition({
      config,
      name: "shared",
      scope: "global",
      source: workflowSource("shared", "global"),
    });
    resolved = await resolveWorkflowDefinition(config, "shared");
    expect(resolved.scope).toBe("global");
    expect(resolved.source).toContain('return "global"');

    await saveWorkflowDefinition({
      config,
      name: "shared",
      scope: "project",
      source: workflowSource("shared", "project"),
    });
    resolved = await resolveWorkflowDefinition(config, "shared");
    expect(resolved.scope).toBe("project");
    expect(resolved.source).toContain('return "project"');

    const catalog = await listWorkflowDefinitions(config);
    expect(catalog.diagnostics).toEqual([]);
    expect(catalog.workflows).toEqual([
      expect.objectContaining({ name: "shared", scope: "project" }),
    ]);
  });

  test("requires explicit overwrite and replaces regular files safely", async () => {
    const config = await makeConfig();
    await saveWorkflowDefinition({
      config,
      name: "replace-me",
      scope: "project",
      source: workflowSource("replace-me", "first"),
    });

    await expect(
      saveWorkflowDefinition({
        config,
        name: "replace-me",
        scope: "project",
        source: workflowSource("replace-me", "second"),
      }),
    ).rejects.toThrow("overwrite:true");

    await saveWorkflowDefinition({
      config,
      name: "replace-me",
      scope: "project",
      source: workflowSource("replace-me", "second"),
      overwrite: true,
    });
    const resolved = await resolveWorkflowDefinition(config, "replace-me");
    expect(resolved.source).toContain('return "second"');
  });

  test("rejects save names that do not match workflow metadata", async () => {
    const config = await makeConfig();
    await expect(
      saveWorkflowDefinition({
        config,
        name: "expected-name",
        scope: "global",
        source: workflowSource("different-name", "value"),
      }),
    ).rejects.toThrow("must match meta.name");
  });

  test("an invalid project definition shadows a valid global definition", async () => {
    const config = await makeConfig();
    await saveWorkflowDefinition({
      config,
      name: "shadowed",
      scope: "global",
      source: workflowSource("shadowed", "global"),
    });
    const projectDir = path.join(config.projectCoworkDir, "workflows");
    await fs.mkdir(projectDir, { recursive: true });
    await fs.writeFile(
      path.join(projectDir, "shadowed.ts"),
      `${metaHeader("shadowed")}export default 42;`,
    );

    const catalog = await listWorkflowDefinitions(config);
    expect(catalog.workflows).toEqual([]);
    expect(catalog.diagnostics).toEqual([
      expect.objectContaining({ name: "shadowed", scope: "project" }),
    ]);
    await expect(resolveWorkflowDefinition(config, "shadowed")).rejects.toThrow("default export");
  });

  test("rejects non-regular workflow paths", async () => {
    const config = await makeConfig();
    const target = path.join(config.projectCoworkDir, "workflows", "not-a-file.ts");
    await fs.mkdir(target, { recursive: true });

    await expect(resolveWorkflowDefinition(config, "not-a-file")).rejects.toThrow("regular file");
    await expect(
      saveWorkflowDefinition({
        config,
        name: "not-a-file",
        scope: "project",
        source: workflowSource("not-a-file", "value"),
        overwrite: true,
      }),
    ).rejects.toThrow("regular file");
  });

  test("discovers the bundled deep-research workflow", async () => {
    const config = await makeConfig();
    config.builtInDir = path.resolve(import.meta.dir, "../..");

    const resolved = await resolveWorkflowDefinition(config, "deep-research");
    expect(resolved.scope).toBe("bundled");
    expect(resolved.phases).toEqual(["plan", "research", "verify", "synthesize"]);
  });
});
