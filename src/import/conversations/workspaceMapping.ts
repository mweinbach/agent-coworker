import fs from "node:fs/promises";
import path from "node:path";

import type {
  ConversationWorkspaceMapping,
  ConversationWorkspaceMappingInput,
  ExternalConversation,
} from "./types";

export type WorkspaceMappingWorkspace = {
  id: string;
  name: string;
  path: string;
};

async function canonicalizeExistingPath(inputPath: string): Promise<string | null> {
  try {
    return await fs.realpath(inputPath);
  } catch {
    return null;
  }
}

function samePath(left: string, right: string): boolean {
  return path.resolve(left) === path.resolve(right);
}

export async function mapConversationWorkspace(input: {
  conversation: Pick<ExternalConversation, "cwd">;
  workspaces: WorkspaceMappingWorkspace[];
}): Promise<ConversationWorkspaceMapping> {
  const cwd = input.conversation.cwd?.trim() || null;
  if (!cwd) {
    return { status: "missing", originalPath: null, reason: "no_cwd" };
  }

  const realCwd = await canonicalizeExistingPath(cwd);
  if (!realCwd) {
    return { status: "missing", originalPath: cwd, reason: "path_missing" };
  }

  for (const workspace of input.workspaces) {
    const workspaceReal = await canonicalizeExistingPath(workspace.path);
    if (workspaceReal && samePath(workspaceReal, realCwd)) {
      return {
        status: "matched",
        workspaceId: workspace.id,
        workspacePath: workspace.path,
      };
    }
  }

  return {
    status: "create",
    workspacePath: realCwd,
    name: path.basename(realCwd) || realCwd,
  };
}

export function resolveWorkspaceMappingInput(input: {
  mapping: ConversationWorkspaceMappingInput;
  workspaces: WorkspaceMappingWorkspace[];
}): { workspaceId: string | null; workspacePath: string; name?: string } | { error: string } {
  if (input.mapping.kind === "create") {
    const workspacePath = input.mapping.path.trim();
    if (!workspacePath) return { error: "Workspace path is required." };
    return {
      workspaceId: null,
      workspacePath,
      ...(input.mapping.name?.trim() ? { name: input.mapping.name.trim() } : {}),
    };
  }

  const workspaceId = input.mapping.workspaceId;
  const workspace = input.workspaces.find((candidate) => candidate.id === workspaceId);
  if (!workspace) {
    return { error: `Unknown workspace: ${workspaceId}` };
  }
  return {
    workspaceId: workspace.id,
    workspacePath: workspace.path,
    name: workspace.name,
  };
}

export async function validateWorkspaceMappingInput(input: {
  mapping: ConversationWorkspaceMappingInput;
  workspaces: WorkspaceMappingWorkspace[];
}): Promise<ConversationWorkspaceMapping | { error: string }> {
  const resolved = resolveWorkspaceMappingInput(input);
  if ("error" in resolved) return resolved;
  if (input.mapping.kind === "create") {
    const realPath = await canonicalizeExistingPath(resolved.workspacePath);
    if (!realPath) {
      return {
        status: "missing",
        originalPath: resolved.workspacePath,
        reason: "path_missing",
      };
    }
    const fallbackName = path.basename(realPath) || realPath;
    const name = resolved.name ?? fallbackName;
    return {
      status: "create",
      workspacePath: realPath,
      name,
    };
  }
  return {
    status: "matched",
    workspaceId: resolved.workspaceId ?? "",
    workspacePath: resolved.workspacePath,
  };
}
