import { afterEach, describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";

import { __internal, WebDesktopService } from "../src/server/webDesktopService";
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

function createMockWorkspaceChild() {
  return Object.assign(new EventEmitter(), {
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    exitCode: null,
    signalCode: null,
  });
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
      desktopFeatureFlagOverrides: {
        remoteAccess: false,
      },
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

    const stateResponse = await handleWebDesktopRoute(
      new Request("http://localhost/cowork/desktop/state"),
      { cwd: workspaceA, desktopService: service },
    );
    expect(stateResponse).not.toBeNull();
    expect(await readJson(stateResponse!)).toEqual(expect.objectContaining({
      desktopFeatureFlagOverrides: {
        remoteAccess: false,
      },
    }));

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
    expect(state.desktopFeatureFlagOverrides).toEqual({});

    await service.stopAll();
  });

  test("restarts the workspace server when launch params change for the same workspace id", async () => {
    const workspaceA = await makeTempDir("cowork-web-desktop-restart-a-");
    const workspaceB = await makeTempDir("cowork-web-desktop-restart-b-");
    const starts: Array<{ workspacePath: string; yolo: boolean }> = [];
    const kills: string[] = [];
    let launchCount = 0;

    function makeChild(id: string) {
      return {
        __id: id,
        exitCode: null,
        signalCode: null,
        once() {
          return this;
        },
      } as any;
    }

    const manager = new __internal.SourceWorkspaceServerManager({
      repoRoot: "/repo",
      sourceEntry: "/repo/src/server/index.ts",
      launchWorkspaceServer: async ({ workspacePath, yolo }) => {
        starts.push({ workspacePath, yolo });
        launchCount += 1;
        return { child: makeChild(`child-${launchCount}`), url: `ws://mock-${launchCount}` };
      },
      gracefulKill: async (child) => {
        kills.push((child as any).__id);
      },
    });

    const first = await manager.startWorkspaceServer({
      workspaceId: "ws1",
      workspacePath: workspaceA,
      yolo: false,
    });
    const second = await manager.startWorkspaceServer({
      workspaceId: "ws1",
      workspacePath: workspaceA,
      yolo: false,
    });
    const third = await manager.startWorkspaceServer({
      workspaceId: "ws1",
      workspacePath: workspaceB,
      yolo: true,
    });

    expect(first).toEqual({ url: "ws://mock-1" });
    expect(second).toEqual({ url: "ws://mock-1" });
    expect(third).toEqual({ url: "ws://mock-2" });
    expect(starts).toEqual([
      { workspacePath: await fs.realpath(workspaceA), yolo: false },
      { workspacePath: await fs.realpath(workspaceB), yolo: true },
    ]);
    expect(kills).toEqual(["child-1"]);
  });

  test("serves active-content files as attachments while keeping plain text inline", async () => {
    const workspace = await makeTempDir("cowork-web-desktop-open-");
    const htmlPath = path.join(workspace, "preview.html");
    const svgPath = path.join(workspace, "vector.svg");
    const textPath = path.join(workspace, "notes.txt");
    await fs.writeFile(htmlPath, "<!doctype html><script>window.hacked = true</script>", "utf8");
    await fs.writeFile(svgPath, "<svg xmlns=\"http://www.w3.org/2000/svg\"></svg>", "utf8");
    await fs.writeFile(textPath, "hello", "utf8");

    const htmlResponse = await handleWebDesktopRoute(
      new Request(`http://localhost/cowork/fs/open?path=${encodeURIComponent(htmlPath)}`),
      { cwd: workspace },
    );
    const svgResponse = await handleWebDesktopRoute(
      new Request(`http://localhost/cowork/fs/open?path=${encodeURIComponent(svgPath)}`),
      { cwd: workspace },
    );
    const textResponse = await handleWebDesktopRoute(
      new Request(`http://localhost/cowork/fs/open?path=${encodeURIComponent(textPath)}`),
      { cwd: workspace },
    );

    expect(htmlResponse).not.toBeNull();
    expect(svgResponse).not.toBeNull();
    expect(textResponse).not.toBeNull();
    expect(htmlResponse!.headers.get("Content-Disposition")).toStartWith("attachment;");
    expect(svgResponse!.headers.get("Content-Disposition")).toStartWith("attachment;");
    expect(textResponse!.headers.get("Content-Disposition")).toStartWith("inline;");
    expect(htmlResponse!.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(svgResponse!.headers.get("X-Content-Type-Options")).toBe("nosniff");
  });

  test("workspace server monitor keeps draining stdout and stderr after readiness", async () => {
    const child = createMockWorkspaceChild();
    const seenLines: Array<{ source: string; line: string }> = [];
    const monitor = __internal.createWorkspaceServerMonitor(
      child as any,
      (source, line) => {
        seenLines.push({ source, line });
      },
    );

    child.stdout.write("{\"type\":\"server_listening\",\"url\":\"ws://127.0.0.1:7337/ws\"}\n");
    await expect(monitor.ready).resolves.toEqual({ url: "ws://127.0.0.1:7337/ws" });

    child.stdout.write("stdout after ready\n");
    child.stderr.write("stderr after ready\n");
    await Bun.sleep(0);

    expect(seenLines).toEqual([
      { source: "stdout", line: "stdout after ready" },
      { source: "stderr", line: "stderr after ready" },
    ]);

    child.stdout.end();
    child.stderr.end();
    child.emit("exit", 0, null);
    await expect(monitor.drained).resolves.toBeUndefined();
  });
});
