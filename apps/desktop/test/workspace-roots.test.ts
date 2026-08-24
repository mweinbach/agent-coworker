import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import path from "node:path";

import { scratchRoots } from "../../../src/platform/sandbox";
import { WorkspaceRootsController } from "../electron/ipc/workspaceRoots";

const temporaryDirectories: string[] = [];

async function createWorkspaceDirectory(): Promise<string> {
  const directory = await fs.mkdtemp(
    path.join(scratchRoots()[0] ?? "/tmp", "cowork-workspace-roots-"),
  );
  temporaryDirectories.push(directory);
  return await fs.realpath(directory);
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map(async (directory) => {
      await fs.rm(directory, { recursive: true, force: true });
    }),
  );
});

describe("desktop workspace root approvals", () => {
  test("keeps a newly approved quick-chat workspace through a stale persisted-state refresh", async () => {
    const workspacePath = await createWorkspaceDirectory();
    const persistence = { loadState: async () => ({ workspaces: [] }) };
    const roots = new WorkspaceRootsController(persistence as never);

    await roots.refreshApprovedWorkspaceRootsFromState({ workspaces: [] } as never);
    await roots.addApprovedWorkspacePath(workspacePath);

    await roots.refreshApprovedWorkspaceRootsFromState({ workspaces: [] } as never);

    await expect(roots.assertApprovedWorkspacePath(workspacePath)).resolves.toBe(workspacePath);
  });

  test("keeps an explicit approval during unrelated saves and revokes it after persisted removal", async () => {
    const workspacePath = await createWorkspaceDirectory();
    const otherWorkspacePath = await createWorkspaceDirectory();
    const persistence = { loadState: async () => ({ workspaces: [] }) };
    const roots = new WorkspaceRootsController(persistence as never);

    await roots.addApprovedWorkspacePath(workspacePath);
    roots.setApprovedWorkspaceRoots([otherWorkspacePath]);

    await expect(roots.assertApprovedWorkspacePath(workspacePath)).resolves.toBe(workspacePath);

    roots.setApprovedWorkspaceRoots([otherWorkspacePath, workspacePath]);
    roots.setApprovedWorkspaceRoots([otherWorkspacePath]);

    await expect(roots.assertApprovedWorkspacePath(workspacePath)).rejects.toThrow(
      "Workspace path is not approved",
    );
    await expect(roots.assertApprovedWorkspacePath(otherWorkspacePath)).resolves.toBe(
      otherWorkspacePath,
    );
  });

  test("keeps only a trusted persisted project approved while its drive is unavailable", async () => {
    const workspaceParent = await createWorkspaceDirectory();
    const workspacePath = path.join(workspaceParent, "external-project");
    const detachedPath = path.join(workspaceParent, "external-project-detached");
    await fs.mkdir(workspacePath);
    const persisted = { workspaces: [{ path: workspacePath }] };
    const persistence = { loadState: async () => persisted };
    const roots = new WorkspaceRootsController(persistence as never);

    await roots.refreshApprovedWorkspaceRootsFromState(persisted as never);
    await fs.rename(workspacePath, detachedPath);

    await expect(roots.assertApprovedWorkspacePath(workspacePath)).resolves.toBe(workspacePath);
    await roots.refreshApprovedWorkspaceRootsFromState(persisted as never);
    await expect(roots.assertApprovedWorkspacePath(workspacePath)).resolves.toBe(workspacePath);
    await expect(
      roots.assertApprovedWorkspacePath(path.join(workspaceParent, "never-approved")),
    ).rejects.toThrow();

    await fs.rename(detachedPath, workspacePath);
    await expect(roots.assertApprovedWorkspacePath(workspacePath)).resolves.toBe(workspacePath);

    roots.setApprovedWorkspaceRoots([]);
    await expect(roots.assertApprovedWorkspacePath(workspacePath)).rejects.toThrow(
      "Workspace path is not approved",
    );
  });

  test("does not grant unavailable-path access to an approval that was never persisted", async () => {
    const workspaceParent = await createWorkspaceDirectory();
    const workspacePath = path.join(workspaceParent, "not-yet-persisted");
    await fs.mkdir(workspacePath);
    const roots = new WorkspaceRootsController({
      loadState: async () => ({ workspaces: [] }),
    } as never);

    await roots.addApprovedWorkspacePath(workspacePath);
    await fs.rm(workspacePath, { recursive: true });

    await expect(roots.assertApprovedWorkspacePath(workspacePath)).rejects.toThrow();
  });

  test("rejects a remounted project that becomes a symlink outside its approved root", async () => {
    const workspaceParent = await createWorkspaceDirectory();
    const workspacePath = path.join(workspaceParent, "external-project");
    const detachedPath = path.join(workspaceParent, "external-project-detached");
    const outsidePath = await createWorkspaceDirectory();
    await fs.mkdir(workspacePath);
    const persisted = { workspaces: [{ path: workspacePath }] };
    const persistence = { loadState: async () => persisted };
    const roots = new WorkspaceRootsController(persistence as never);

    await roots.refreshApprovedWorkspaceRootsFromState(persisted as never);
    await fs.rename(workspacePath, detachedPath);
    await roots.refreshApprovedWorkspaceRootsFromState(persisted as never);
    await fs.symlink(outsidePath, workspacePath, "junction");

    await expect(roots.assertApprovedWorkspacePath(workspacePath)).rejects.toThrow(
      "Workspace path is not approved",
    );
    await expect(roots.assertApprovedWorkspacePath(outsidePath)).rejects.toThrow(
      "Workspace path is not approved",
    );
    await expect(
      roots.assertApprovedWorkspacePath(
        path.join(workspacePath, "..", "external-project-detached"),
      ),
    ).rejects.toThrow("Workspace path is not approved");
  });
});
