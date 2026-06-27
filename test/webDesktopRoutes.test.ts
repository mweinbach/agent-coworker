import { afterEach, describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { handleWebDesktopRoute } from "../src/server/webDesktopRoutes";
import { __internal, WebDesktopService } from "../src/server/webDesktopService";
import { getOneOffChatsRoot } from "../src/utils/oneOffChats";

const cleanupPaths = new Set<string>();

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  cleanupPaths.add(dir);
  return dir;
}

async function readJson(response: Response): Promise<unknown> {
  return JSON.parse(await response.text());
}

async function waitForCondition(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (predicate()) {
      return;
    }
    await Bun.sleep(10);
  }
  throw new Error("Timed out waiting for condition");
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
  async function makeAliasedHome(prefix: string): Promise<{
    cleanupRoot: string;
    aliasHome: string;
    processHome: string;
  }> {
    const cleanupRoot = await makeTempDir(prefix);
    const realHome = path.join(cleanupRoot, "real-home");
    const aliasHome = path.join(cleanupRoot, "home-alias");
    const processHome = path.join(cleanupRoot, "process-home");
    await fs.mkdir(realHome, { recursive: true });
    await fs.mkdir(processHome, { recursive: true });
    await fs.symlink(realHome, aliasHome, process.platform === "win32" ? "junction" : "dir");
    return { cleanupRoot, aliasHome, processHome };
  }

  test("desktop service route creates one-off chat workspaces", async () => {
    const workspace = await makeTempDir("cowork-web-desktop-one-off-route-");
    const service = {
      getWorkspaceRoots: async () => [workspace],
      createOneOffChatWorkspace: async (opts?: { titleHint?: string }) => ({
        name: opts?.titleHint ?? "New chat",
        path: path.join(workspace, "created-chat"),
      }),
    };

    const response = await handleWebDesktopRoute(
      new Request("http://localhost/cowork/desktop/one-off-chat/workspace", {
        method: "POST",
        body: JSON.stringify({ titleHint: "Scratch pad" }),
      }),
      { cwd: workspace, desktopService: service as any },
    );

    expect(response).not.toBeNull();
    expect(await readJson(response!)).toEqual({
      name: "Scratch pad",
      path: path.join(workspace, "created-chat"),
    });
  });

  test("desktop state roundtrip keeps fallback one-off workspaces classified as chats", async () => {
    const { cleanupRoot, aliasHome } = await makeAliasedHome("cowork-web-desktop-fallback-oneoff-");
    const userDataDir = path.join(cleanupRoot, "user-data");
    const oneOffWorkspace = path.join(aliasHome, ".cowork", "chats", "fallback-chat");
    const promotedProject = path.join(aliasHome, ".cowork", "chats", "promoted-project");
    const projectWorkspace = path.join(cleanupRoot, "project");
    await fs.mkdir(oneOffWorkspace, { recursive: true });
    await fs.mkdir(promotedProject, { recursive: true });
    await fs.mkdir(projectWorkspace, { recursive: true });
    const oneOffPath = await fs.realpath(oneOffWorkspace);
    const promotedProjectPath = await fs.realpath(promotedProject);
    const projectPath = await fs.realpath(projectWorkspace);
    const service = new WebDesktopService({ userDataDir, homedir: aliasHome });

    const stateResponse = await handleWebDesktopRoute(
      new Request("http://localhost/cowork/desktop/state"),
      { cwd: oneOffPath, desktopService: service },
    );
    expect(stateResponse).not.toBeNull();
    const roundtripState = (await readJson(stateResponse!)) as {
      workspaces: Array<{ id: string; path: string; workspaceKind?: string }>;
    };
    expect(roundtripState.workspaces).toHaveLength(1);
    expect(roundtripState.workspaces[0]).toEqual(
      expect.objectContaining({
        path: oneOffPath,
        workspaceKind: "oneOffChat",
      }),
    );

    const saveResponse = await handleWebDesktopRoute(
      new Request("http://localhost/cowork/desktop/state", {
        method: "POST",
        body: JSON.stringify(roundtripState),
      }),
      { cwd: oneOffPath, desktopService: service },
    );
    expect(saveResponse).not.toBeNull();
    const savedState = (await readJson(saveResponse!)) as {
      workspaces: Array<{ path: string; workspaceKind?: string }>;
    };
    expect(savedState.workspaces[0]).toEqual(
      expect.objectContaining({
        path: oneOffPath,
        workspaceKind: "oneOffChat",
      }),
    );
    await expect(service.loadState({ fallbackCwd: oneOffPath })).resolves.toMatchObject({
      workspaces: [expect.objectContaining({ path: oneOffPath, workspaceKind: "oneOffChat" })],
    });

    await expect(service.loadState({ fallbackCwd: projectPath })).resolves.toMatchObject({
      workspaces: [expect.objectContaining({ path: oneOffPath, workspaceKind: "oneOffChat" })],
    });
    const projectService = new WebDesktopService({
      userDataDir: path.join(cleanupRoot, "project-user-data"),
      homedir: aliasHome,
    });
    await expect(projectService.loadState({ fallbackCwd: projectPath })).resolves.toMatchObject({
      workspaces: [expect.objectContaining({ path: projectPath, workspaceKind: "project" })],
    });

    await service.saveState({
      version: 2,
      workspaces: [
        {
          id: "promoted-project",
          name: "Promoted project",
          path: promotedProjectPath,
          workspaceKind: "project",
          createdAt: "2026-06-20T00:00:00.000Z",
          lastOpenedAt: "2026-06-20T00:00:00.000Z",
        },
      ],
      threads: [],
    });
    await expect(service.loadState({ fallbackCwd: oneOffPath })).resolves.toMatchObject({
      workspaces: [
        expect.objectContaining({ path: promotedProjectPath, workspaceKind: "project" }),
      ],
    });
  });

  test("desktop service creates one-off chats under the configured home", async () => {
    const { cleanupRoot, aliasHome, processHome } = await makeAliasedHome(
      "cowork-web-desktop-oneoff-home-",
    );
    const userDataDir = path.join(cleanupRoot, "user-data");
    const service = new WebDesktopService({ userDataDir, homedir: aliasHome });
    const previousHome = process.env.HOME;
    process.env.HOME = processHome;
    try {
      const response = await handleWebDesktopRoute(
        new Request("http://localhost/cowork/desktop/one-off-chat/workspace", {
          method: "POST",
          body: JSON.stringify({ titleHint: "Configured home chat" }),
        }),
        { cwd: cleanupRoot, desktopService: service },
      );
      expect(response).not.toBeNull();
      const created = (await readJson(response!)) as { name: string; path: string };
      const configuredChatsRoot = await fs.realpath(getOneOffChatsRoot(aliasHome));
      const processChatsRoot = path.join(processHome, ".cowork", "chats");
      expect(created.name).toBe("New chat");
      expect(created.path.startsWith(`${configuredChatsRoot}${path.sep}`)).toBe(true);
      expect(created.path.startsWith(processChatsRoot)).toBe(false);

      await service.saveState({
        version: 2,
        workspaces: [
          {
            id: "created-one-off",
            name: "Created one-off",
            path: created.path,
            workspaceKind: "oneOffChat",
            createdAt: "2026-06-20T00:00:00.000Z",
            lastOpenedAt: "2026-06-20T00:00:00.000Z",
          },
        ],
        threads: [],
      });
      await expect(service.loadState()).resolves.toMatchObject({
        workspaces: [expect.objectContaining({ path: created.path, workspaceKind: "oneOffChat" })],
      });
    } finally {
      if (previousHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = previousHome;
      }
    }
  });

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
    const desktopState = await readJson(stateResponse!);
    expect(desktopState).toEqual(
      expect.objectContaining({
        desktopFeatureFlagOverrides: {
          remoteAccess: false,
        },
      }),
    );
    expect(desktopState.workspaces.map((entry: { yolo?: boolean }) => entry.yolo)).toEqual([
      false,
      false,
    ]);

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
    expect(state.workspaces[0]?.yolo).toBe(false);
    expect(state.desktopFeatureFlagOverrides).toEqual({});

    await service.stopAll();
  });

  test("desktop service allows fs access to global one-off chat session dirs", async () => {
    const userDataDir = await makeTempDir("cowork-web-desktop-oneoff-userdata-");
    const workspace = await makeTempDir("cowork-web-desktop-oneoff-ws-");
    const service = new WebDesktopService({ userDataDir });

    const chatsRoot = getOneOffChatsRoot();
    await fs.mkdir(chatsRoot, { recursive: true });
    const sessionDir = await fs.mkdtemp(path.join(chatsRoot, "20260601T000000Z-research-"));
    cleanupPaths.add(sessionDir);
    await fs.writeFile(path.join(sessionDir, "report.md"), "# findings\n", "utf8");

    try {
      const roots = await service.getWorkspaceRoots(workspace);
      expect(roots).toContain(chatsRoot);

      const listResponse = await handleWebDesktopRoute(
        new Request(`http://localhost/cowork/fs/list?path=${encodeURIComponent(sessionDir)}`),
        { cwd: workspace, desktopService: service },
      );
      expect(listResponse).not.toBeNull();
      expect(await readJson(listResponse!)).toEqual([
        {
          isDirectory: false,
          isHidden: false,
          modifiedAtMs: expect.any(Number),
          name: "report.md",
          path: path.join(sessionDir, "report.md"),
          sizeBytes: 11,
        },
      ]);
    } finally {
      await service.stopAll();
    }
  });

  test("desktop service notifies watchers when persisted state changes", async () => {
    const userDataDir = await makeTempDir("cowork-web-desktop-watch-userdata-");
    const service = new WebDesktopService({ userDataDir });
    let changeCount = 0;
    const dispose = service.watchStateChanges(() => {
      changeCount += 1;
    });

    try {
      await service.saveState({
        version: 2,
        workspaces: [],
        threads: [],
      });
      expect(changeCount).toBe(1);
      await Bun.sleep(75);
      expect(changeCount).toBe(1);
    } finally {
      dispose();
      await service.stopAll();
    }
  });

  test("desktop service shares and tears down debounced state file watchers", async () => {
    const userDataDir = await makeTempDir("cowork-web-desktop-shared-watch-userdata-");
    const service = new WebDesktopService({ userDataDir });
    const serviceInternals = service as unknown as { stateWatcher: unknown | null };
    let firstListenerCount = 0;
    let secondListenerCount = 0;

    const disposeFirst = service.watchStateChanges(() => {
      firstListenerCount += 1;
    });
    const firstWatcher = serviceInternals.stateWatcher;
    const disposeSecond = service.watchStateChanges(() => {
      secondListenerCount += 1;
    });

    try {
      expect(firstWatcher).not.toBeNull();
      expect(serviceInternals.stateWatcher).toBe(firstWatcher);

      await fs.writeFile(path.join(userDataDir, "other.txt"), "ignore me", "utf8");
      await Bun.sleep(75);
      expect(firstListenerCount).toBe(0);
      expect(secondListenerCount).toBe(0);

      await fs.writeFile(
        path.join(userDataDir, "state.json"),
        JSON.stringify({ version: 2, workspaces: [], threads: [] }),
        "utf8",
      );
      await waitForCondition(() => firstListenerCount === 1 && secondListenerCount === 1);

      await fs.writeFile(
        path.join(userDataDir, "state.json"),
        JSON.stringify({ version: 2, workspaces: [], threads: [], developerMode: true }),
        "utf8",
      );
      await fs.writeFile(
        path.join(userDataDir, "state.json"),
        JSON.stringify({ version: 2, workspaces: [], threads: [], showHiddenFiles: true }),
        "utf8",
      );
      await waitForCondition(() => firstListenerCount === 2 && secondListenerCount === 2);
      await Bun.sleep(75);
      expect(firstListenerCount).toBe(2);
      expect(secondListenerCount).toBe(2);

      disposeFirst();
      expect(serviceInternals.stateWatcher).toBe(firstWatcher);
      disposeSecond();
      expect(serviceInternals.stateWatcher).toBeNull();

      await fs.writeFile(
        path.join(userDataDir, "state.json"),
        JSON.stringify({ version: 2, workspaces: [], threads: [], perWorkspaceSettings: true }),
        "utf8",
      );
      await Bun.sleep(75);
      expect(firstListenerCount).toBe(2);
      expect(secondListenerCount).toBe(2);
    } finally {
      disposeFirst();
      disposeSecond();
      await service.stopAll();
    }
  });

  test("desktop service watches existing state files until the listener is disposed", async () => {
    const userDataDir = await makeTempDir("cowork-web-desktop-existing-watch-userdata-");
    const statePath = path.join(userDataDir, "state.json");
    await fs.writeFile(
      statePath,
      JSON.stringify({ version: 2, workspaces: [], threads: [] }),
      "utf8",
    );
    const service = new WebDesktopService({ userDataDir });
    let changeCount = 0;
    const dispose = service.watchStateChanges(() => {
      changeCount += 1;
    });

    try {
      await fs.writeFile(path.join(userDataDir, "other.json"), "{}", "utf8");
      await Bun.sleep(75);
      expect(changeCount).toBe(0);

      await fs.writeFile(
        statePath,
        JSON.stringify({ version: 2, workspaces: [], threads: [], developerMode: true }),
        "utf8",
      );
      await waitForCondition(() => changeCount === 1);

      dispose();
      await fs.writeFile(
        statePath,
        JSON.stringify({ version: 2, workspaces: [], threads: [], developerMode: false }),
        "utf8",
      );
      await Bun.sleep(75);
      expect(changeCount).toBe(1);
    } finally {
      dispose();
      await service.stopAll();
    }
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

  test("defers source workspace server manager creation until a nested launch is requested", async () => {
    const userDataDir = await makeTempDir("cowork-web-desktop-lazy-userdata-");
    let factoryCalls = 0;
    const service = new WebDesktopService({
      userDataDir,
      serverManagerFactory: () => {
        factoryCalls += 1;
        throw new Error("server manager should be lazy");
      },
    });

    await expect(service.loadState()).resolves.toMatchObject({ version: 2 });
    await expect(service.stopAll()).resolves.toBeUndefined();
    expect(factoryCalls).toBe(0);
  });

  test("web desktop service never forwards yolo workspace launches", async () => {
    const userDataDir = await makeTempDir("cowork-web-desktop-yolo-userdata-");
    const workspace = await makeTempDir("cowork-web-desktop-yolo-workspace-");
    const starts: Array<{ workspacePath: string; yolo: boolean }> = [];
    const manager = {
      startWorkspaceServer: async (opts: {
        workspaceId: string;
        workspacePath: string;
        yolo: boolean;
      }) => {
        starts.push({ workspacePath: opts.workspacePath, yolo: opts.yolo });
        return { url: "ws://mock" };
      },
      stopWorkspaceServer: async () => {},
      stopAll: async () => {},
    };
    const service = new WebDesktopService({
      userDataDir,
      serverManager: manager as unknown as InstanceType<
        typeof __internal.SourceWorkspaceServerManager
      >,
    });

    await expect(
      service.startWorkspaceServer({
        workspaceId: "ws1",
        workspacePath: workspace,
        yolo: true,
      }),
    ).resolves.toEqual({ url: "ws://mock" });

    expect(starts).toEqual([{ workspacePath: workspace, yolo: false }]);
  });

  test("serves active-content files as attachments while keeping plain text inline", async () => {
    const workspace = await makeTempDir("cowork-web-desktop-open-");
    const htmlPath = path.join(workspace, "preview.html");
    const svgPath = path.join(workspace, "vector.svg");
    const textPath = path.join(workspace, "notes.txt");
    await fs.writeFile(htmlPath, "<!doctype html><script>window.hacked = true</script>", "utf8");
    await fs.writeFile(svgPath, '<svg xmlns="http://www.w3.org/2000/svg"></svg>', "utf8");
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
    const monitor = __internal.createWorkspaceServerMonitor(child as any, (source, line) => {
      seenLines.push({ source, line });
    });

    child.stdout.write('{"type":"server_listening","url":"ws://127.0.0.1:7337/ws"}\n');
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

  test("workspace server terminal mirroring follows the harness log env flag", () => {
    expect(__internal.shouldMirrorWorkspaceServerOutputToTerminal({})).toBe(false);
    expect(
      __internal.shouldMirrorWorkspaceServerOutputToTerminal({
        COWORK_HARNESS_TERMINAL_LOGS: "1",
      }),
    ).toBe(true);
    expect(
      __internal.shouldMirrorWorkspaceServerOutputToTerminal({
        COWORK_HARNESS_TERMINAL_LOGS: "true",
      }),
    ).toBe(true);
  });
});
