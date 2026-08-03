import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import type { AgentConfig } from "../types";
import { inspectWorkflowSource } from "./inspect";

export const WORKFLOW_DEFINITION_MAX_BYTES = 200_000;

export const WORKFLOW_DEFINITION_SCOPES = ["project", "global", "bundled"] as const;
export type WorkflowDefinitionScope = (typeof WORKFLOW_DEFINITION_SCOPES)[number];
export type WritableWorkflowDefinitionScope = Extract<
  WorkflowDefinitionScope,
  "project" | "global"
>;

export type WorkflowCatalogEntry = {
  name: string;
  description: string;
  phases: string[];
  scope: WorkflowDefinitionScope;
  path: string;
};

export type WorkflowCatalogDiagnostic = {
  name: string;
  scope: WorkflowDefinitionScope;
  path: string;
  message: string;
};

export type ResolvedWorkflowDefinition = WorkflowCatalogEntry & {
  source: string;
};

const WORKFLOW_NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function assertWorkflowDefinitionName(name: string): string {
  const trimmed = name.trim();
  if (trimmed.length > 80 || !WORKFLOW_NAME_RE.test(trimmed)) {
    throw new Error(
      "workflow name must be 1-80 characters of lowercase letters, digits, and single hyphens",
    );
  }
  return trimmed;
}

export function workflowDefinitionRoots(
  config: Pick<AgentConfig, "projectCoworkDir" | "userCoworkDir" | "builtInDir">,
): Array<{ scope: WorkflowDefinitionScope; dir: string }> {
  return [
    { scope: "project", dir: path.join(config.projectCoworkDir, "workflows") },
    { scope: "global", dir: path.join(config.userCoworkDir, "workflows") },
    { scope: "bundled", dir: path.join(config.builtInDir, "workflows") },
  ];
}

function definitionPath(dir: string, name: string): string {
  return path.join(dir, `${assertWorkflowDefinitionName(name)}.ts`);
}

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function readDefinitionSource(targetPath: string): Promise<string> {
  const stat = await fs.lstat(targetPath);
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error("workflow definition must be a regular file, not a symlink");
  }
  if (stat.size > WORKFLOW_DEFINITION_MAX_BYTES) {
    throw new Error(`workflow definition exceeds the ${WORKFLOW_DEFINITION_MAX_BYTES}-byte limit`);
  }
  return await fs.readFile(targetPath, "utf8");
}

async function inspectDefinition(opts: {
  name: string;
  scope: WorkflowDefinitionScope;
  path: string;
}): Promise<ResolvedWorkflowDefinition> {
  const source = await readDefinitionSource(opts.path);
  const inspected = await inspectWorkflowSource(source);
  if (!inspected.ok) {
    throw new Error(inspected.issues.map((issue) => `${issue.path}: ${issue.message}`).join("; "));
  }
  if (inspected.meta.name !== opts.name) {
    throw new Error(
      `workflow filename/name mismatch: expected meta.name "${opts.name}", found "${inspected.meta.name}"`,
    );
  }
  return {
    name: opts.name,
    description: inspected.meta.description,
    phases: [...inspected.meta.phases],
    scope: opts.scope,
    path: opts.path,
    source,
  };
}

async function listNames(dir: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true, encoding: "utf8" });
    return entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".ts"))
      .map((entry) => entry.name.slice(0, -3))
      .filter((name) => WORKFLOW_NAME_RE.test(name) && name.length <= 80)
      .sort((left, right) => left.localeCompare(right));
  } catch {
    return [];
  }
}

export async function listWorkflowDefinitions(
  config: Pick<AgentConfig, "projectCoworkDir" | "userCoworkDir" | "builtInDir">,
): Promise<{ workflows: WorkflowCatalogEntry[]; diagnostics: WorkflowCatalogDiagnostic[] }> {
  const selected = new Map<
    string,
    { name: string; scope: WorkflowDefinitionScope; path: string }
  >();

  for (const root of workflowDefinitionRoots(config)) {
    for (const name of await listNames(root.dir)) {
      if (!selected.has(name)) {
        selected.set(name, { name, scope: root.scope, path: definitionPath(root.dir, name) });
      }
    }
  }

  const workflows: WorkflowCatalogEntry[] = [];
  const diagnostics: WorkflowCatalogDiagnostic[] = [];
  for (const candidate of [...selected.values()].sort((left, right) =>
    left.name.localeCompare(right.name),
  )) {
    try {
      const resolved = await inspectDefinition(candidate);
      workflows.push({
        name: resolved.name,
        description: resolved.description,
        phases: resolved.phases,
        scope: resolved.scope,
        path: resolved.path,
      });
    } catch (error) {
      diagnostics.push({
        ...candidate,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return { workflows, diagnostics };
}

export async function resolveWorkflowDefinition(
  config: Pick<AgentConfig, "projectCoworkDir" | "userCoworkDir" | "builtInDir">,
  name: string,
): Promise<ResolvedWorkflowDefinition> {
  const safeName = assertWorkflowDefinitionName(name);
  for (const root of workflowDefinitionRoots(config)) {
    const targetPath = definitionPath(root.dir, safeName);
    if (await pathExists(targetPath)) {
      return await inspectDefinition({ name: safeName, scope: root.scope, path: targetPath });
    }
  }
  throw new Error(`saved workflow "${safeName}" was not found`);
}

export async function saveWorkflowDefinition(opts: {
  config: Pick<AgentConfig, "projectCoworkDir" | "userCoworkDir" | "builtInDir">;
  name: string;
  scope: WritableWorkflowDefinitionScope;
  source: string;
  overwrite?: boolean;
}): Promise<WorkflowCatalogEntry> {
  const name = assertWorkflowDefinitionName(opts.name);
  if (Buffer.byteLength(opts.source, "utf8") > WORKFLOW_DEFINITION_MAX_BYTES) {
    throw new Error(`workflow definition exceeds the ${WORKFLOW_DEFINITION_MAX_BYTES}-byte limit`);
  }

  const inspected = await inspectWorkflowSource(opts.source);
  if (!inspected.ok) {
    throw new Error(inspected.issues.map((issue) => `${issue.path}: ${issue.message}`).join("; "));
  }
  if (inspected.meta.name !== name) {
    throw new Error(
      `workflow save name must match meta.name: expected "${name}", found "${inspected.meta.name}"`,
    );
  }

  const root = workflowDefinitionRoots(opts.config).find((entry) => entry.scope === opts.scope);
  if (!root) throw new Error(`workflow scope "${opts.scope}" is not writable`);
  await fs.mkdir(root.dir, { recursive: true });
  const targetPath = definitionPath(root.dir, name);
  const source = `${opts.source.trimEnd()}\n`;

  if (!opts.overwrite) {
    try {
      await fs.writeFile(targetPath, source, { encoding: "utf8", flag: "wx" });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        throw new Error(
          `workflow "${name}" already exists in ${opts.scope} scope; pass overwrite:true to replace it`,
        );
      }
      throw error;
    }
  } else {
    if (await pathExists(targetPath)) {
      const existing = await fs.lstat(targetPath);
      if (existing.isSymbolicLink() || !existing.isFile()) {
        throw new Error("refusing to overwrite a workflow path that is not a regular file");
      }
    }
    const tempPath = path.join(root.dir, `.${name}.${randomUUID()}.tmp`);
    try {
      await fs.writeFile(tempPath, source, { encoding: "utf8", flag: "wx" });
      try {
        await fs.rename(tempPath, targetPath);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== "EEXIST" && code !== "EPERM") throw error;
        await fs.rm(targetPath, { force: true });
        await fs.rename(tempPath, targetPath);
      }
    } finally {
      await fs.rm(tempPath, { force: true }).catch(() => {});
    }
  }

  return {
    name,
    description: inspected.meta.description,
    phases: [...inspected.meta.phases],
    scope: opts.scope,
    path: targetPath,
  };
}
