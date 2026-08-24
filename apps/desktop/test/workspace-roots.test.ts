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
});
