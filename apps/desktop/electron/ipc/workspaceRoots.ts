import fs from "node:fs/promises";
import path from "node:path";

import type { PersistedState } from "../../src/app/types";
import type { PersistenceService } from "../services/persistence";
import type { WorkspaceRootsAccess } from "./types";

async function normalizeWorkspacePath(workspacePath: string): Promise<string> {
  if (!workspacePath.trim()) {
    throw new Error("workspacePath must be a non-empty string");
  }

  const resolved = path.resolve(workspacePath);
  const stat = await fs.stat(resolved);
  if (!stat.isDirectory()) {
    throw new Error(`workspacePath is not a directory: ${workspacePath}`);
  }
  return await fs.realpath(resolved);
}

async function getNormalizedWorkspaceRoots(state: PersistedState): Promise<string[]> {
  const roots: string[] = [];
  for (const workspace of state.workspaces) {
    try {
      roots.push(await normalizeWorkspacePath(workspace.path));
    } catch {
      // Ignore invalid paths from persisted state.
    }
  }
  return roots;
}

export class WorkspaceRootsController implements WorkspaceRootsAccess {
  private readonly approvedWorkspaceRoots = new Set<string>();
  private approvedWorkspaceRootsInitialized = false;

  constructor(private readonly persistence: PersistenceService) {}

  private resetApprovedWorkspaceRoots(paths: Iterable<string>): void {
    this.approvedWorkspaceRoots.clear();
    for (const workspacePath of paths) {
      this.approvedWorkspaceRoots.add(workspacePath);
    }
    this.approvedWorkspaceRootsInitialized = true;
  }

  setApprovedWorkspaceRoots(paths: Iterable<string>): void {
    this.resetApprovedWorkspaceRoots(paths);
  }

  async refreshApprovedWorkspaceRootsFromState(state: PersistedState): Promise<void> {
    const roots = await getNormalizedWorkspaceRoots(state);
    this.resetApprovedWorkspaceRoots(roots);
  }

  async ensureApprovedWorkspaceRoots(): Promise<void> {
    if (this.approvedWorkspaceRootsInitialized) {
      return;
    }
    const state = await this.persistence.loadState();
    await this.refreshApprovedWorkspaceRootsFromState(state);
  }

  async assertApprovedWorkspacePath(workspacePath: string): Promise<string> {
    await this.ensureApprovedWorkspaceRoots();
    const normalized = await normalizeWorkspacePath(workspacePath);
    if (!this.approvedWorkspaceRoots.has(normalized)) {
      throw new Error("Workspace path is not approved. Use the workspace picker before saving or starting.");
    }
    return normalized;
  }

  async addApprovedWorkspacePath(workspacePath: string): Promise<string> {
    const normalized = await normalizeWorkspacePath(workspacePath);
    this.approvedWorkspaceRoots.add(normalized);
    this.approvedWorkspaceRootsInitialized = true;
    return normalized;
  }

  getApprovedWorkspaceRoots(): string[] {
    return Array.from(this.approvedWorkspaceRoots.values());
  }
}
