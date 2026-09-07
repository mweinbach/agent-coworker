import fs from "node:fs/promises";
import path from "node:path";

import type { PersistedState } from "../../src/app/types";
import type { PersistenceService } from "../services/persistence";
import type { WorkspaceRootsAccess } from "./types";

const TEMPORARILY_UNAVAILABLE_WORKSPACE_ERROR_CODES = new Set([
  "EACCES",
  "EIO",
  "ENODEV",
  "ENOENT",
  "ENXIO",
  "EPERM",
  "ESTALE",
]);

function isTemporarilyUnavailableWorkspaceError(error: unknown): boolean {
  const code =
    error && typeof error === "object" && "code" in error
      ? (error as { code?: unknown }).code
      : null;
  return typeof code === "string" && TEMPORARILY_UNAVAILABLE_WORKSPACE_ERROR_CODES.has(code);
}

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
    } catch (error) {
      if (isTemporarilyUnavailableWorkspaceError(error)) {
        roots.push(path.resolve(workspace.path));
      }
    }
  }
  return roots;
}

export class WorkspaceRootsController implements WorkspaceRootsAccess {
  private readonly approvedWorkspaceRoots = new Set<string>();
  private readonly persistedWorkspaceRoots = new Set<string>();
  private readonly unpersistedWorkspaceRoots = new Set<string>();
  private approvedWorkspaceRootsInitialized: boolean = false;

  constructor(private readonly persistence: PersistenceService) {}

  private resetApprovedWorkspaceRoots(paths: Iterable<string>): void {
    this.approvedWorkspaceRoots.clear();
    this.persistedWorkspaceRoots.clear();
    for (const workspacePath of paths) {
      this.approvedWorkspaceRoots.add(workspacePath);
      this.persistedWorkspaceRoots.add(workspacePath);
      this.unpersistedWorkspaceRoots.delete(workspacePath);
    }
    for (const workspacePath of this.unpersistedWorkspaceRoots) {
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
    let normalized: string;
    try {
      normalized = await normalizeWorkspacePath(workspacePath);
    } catch (error) {
      const previouslyApprovedPath = path.resolve(workspacePath);
      if (
        this.persistedWorkspaceRoots.has(previouslyApprovedPath) &&
        isTemporarilyUnavailableWorkspaceError(error)
      ) {
        return previouslyApprovedPath;
      }
      throw error;
    }
    if (!this.approvedWorkspaceRoots.has(normalized)) {
      throw new Error(
        "Workspace path is not approved. Use the workspace picker before saving or starting.",
      );
    }
    return normalized;
  }

  async addApprovedWorkspacePath(workspacePath: string): Promise<string> {
    const normalized = await normalizeWorkspacePath(workspacePath);
    if (!this.approvedWorkspaceRoots.has(normalized)) {
      this.unpersistedWorkspaceRoots.add(normalized);
    }
    this.approvedWorkspaceRoots.add(normalized);
    this.approvedWorkspaceRootsInitialized = true;
    return normalized;
  }

  getApprovedWorkspaceRoots(): string[] {
    return Array.from(this.approvedWorkspaceRoots.values());
  }
}
