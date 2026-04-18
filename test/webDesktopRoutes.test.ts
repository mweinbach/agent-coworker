import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { WebDesktopService } from "../src/server/webDesktopService";
import { handleWebDesktopRoute } from "../src/server/webDesktopRoutes";

const cleanupPaths = new Set<string>();

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  cleanupPaths.add(dir);
  return dir;
}

async function readJson(response: Response): Promise<unknown> {
  return JSON.parse(await response.text());
}

afterEach(async () => {
  await Promise.all(
    [...cleanupPaths].map(async (target) => {
      await fs.rm(target, { recursive: true, force: true });
      cleanupPaths.delete(target);
    }),
  );
});

describe("web desktop routes", () => {
  test("desktop service exposes persisted workspaces and allows fs access across them", async () => {
    const userDataDir = await makeTempDir("cowork-web-desktop-userdata-");
    const workspaceA = await makeTempDir("cowork-web-desktop-ws-a-");
    const workspaceB = await makeTempDir("cowork-web-desktop-ws-b-");
    const realWorkspaceA = await fs.realpath(workspaceA);
    const realWorkspaceB = await fs.realpath(workspaceB);
    await fs.writeFile(path.join(workspaceB, "hello.txt"), "hi", "utf8");

    const service = new WebDesktopService({ userDataDir });
    await service.saveState({
      version: 2,
      workspaces: [
        {
          id: "ws_a",
          name: "Workspace A",
          path: realWorkspaceA,
          createdAt: "2026-04-18T00:00:00.000Z",
          lastOpenedAt: "2026-04-18T00:00:00.000Z",
          defaultEnableMcp: true,
          defaultBackupsEnabled: true,
          yolo: false,
        },
        {
          id: "ws_b",
          name: "Workspace B",
          path: realWorkspaceB,
          createdAt: "2026-04-18T00:00:00.000Z",
          lastOpenedAt: "2026-04-18T00:00:00.000Z",
          defaultEnableMcp: true,
          defaultBackupsEnabled: true,
          yolo: false,
        },
      ],
      threads: [],
      developerMode: false,
      showHiddenFiles: false,
      perWorkspaceSettings: false,
    });

    const workspacesResponse = await handleWebDesktopRoute(
      new Request("http://localhost/cowork/workspaces"),
      { cwd: workspaceA, desktopService: service },
    );
    expect(workspacesResponse).not.toBeNull();
    expect(await readJson(workspacesResponse!)).toEqual({
      workspaces: [
        { name: "Workspace A", path: realWorkspaceA },
        { name: "Workspace B", path: realWorkspaceB },
      ],
    });

    const listResponse = await handleWebDesktopRoute(
      new Request(`http://localhost/cowork/fs/list?path=${encodeURIComponent(realWorkspaceB)}`),
      { cwd: realWorkspaceA, desktopService: service },
    );
    expect(listResponse).not.toBeNull();
    expect(await readJson(listResponse!)).toEqual([
      {
        isDirectory: false,
        isHidden: false,
        modifiedAtMs: expect.any(Number),
        name: "hello.txt",
        path: path.join(realWorkspaceB, "hello.txt"),
        sizeBytes: 2,
      },
    ]);

    await service.stopAll();
  });

  test("desktop service falls back to the current cwd when no persisted state exists", async () => {
    const userDataDir = await makeTempDir("cowork-web-desktop-fallback-userdata-");
    const workspace = await makeTempDir("cowork-web-desktop-fallback-ws-");
    const realWorkspace = await fs.realpath(workspace);
    const service = new WebDesktopService({ userDataDir });

    const state = await service.loadState({ fallbackCwd: workspace });
    expect(state.workspaces).toHaveLength(1);
    expect(state.workspaces[0]?.path).toBe(realWorkspace);
    expect(state.workspaces[0]?.name).toBe(path.basename(realWorkspace));

    await service.stopAll();
  });
});
