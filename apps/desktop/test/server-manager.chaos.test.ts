import { describe, expect, mock, test } from "bun:test";
import { createFakeChild, type FakeChild } from "./helpers/fakeServerChild";
import { createElectronMock, setElectronMockOverrides } from "./helpers/mockElectron";

// Chaos scenarios for the desktop supervisor (ServerManager): the workspace
// server dies after announcing itself, the health probe stalls past the 1.5s
// budget, or the health endpoint reports a failure. All are driven through the
// fake child + injected fetch — no spawned processes.

const electronMockOverrides = {
  app: {
    getPath: (name: string) => (name === "userData" ? process.cwd() : process.cwd()),
    getAppPath: () => process.cwd(),
    getVersion: () => "1.2.3",
    isPackaged: false,
  },
  BrowserWindow: {
    getAllWindows: () => [],
    fromWebContents: () => null,
    getFocusedWindow: () => null,
  },
  Menu: {
    buildFromTemplate() {
      return { popup() {} };
    },
  },
};

setElectronMockOverrides(electronMockOverrides);
mock.module("electron", () => createElectronMock());

const { ServerManager, __internal } = await import("../electron/services/serverManager");

type ExitEvent = {
  workspaceId: string;
  url: string | null;
  code: number | null;
  signal: string | null;
};

type ServerHandleLike = {
  child: FakeChild;
  url: string;
  mobileH3: null;
  cleanup: () => void;
};

type ServerManagerInternals = {
  servers: Map<string, ServerHandleLike>;
  finishWorkspaceServerExit: (
    workspaceId: string,
    child: FakeChild,
    url: string | null,
    cleanup: () => void,
    code: number | null,
    signal: NodeJS.Signals | null,
  ) => void;
};

function internalsOf(manager: InstanceType<typeof ServerManager>): ServerManagerInternals {
  return manager as unknown as ServerManagerInternals;
}

/** Register an alive, listening server handle and wire its exit back to the manager. */
function registerRunningServer(
  manager: InstanceType<typeof ServerManager>,
  workspaceId: string,
  url: string,
): FakeChild {
  const internals = internalsOf(manager);
  const child = createFakeChild();
  const cleanup = () => {};
  internals.servers.set(workspaceId, { child, url, mobileH3: null, cleanup });
  child.once("exit", (code: number | null, signal: NodeJS.Signals | null) => {
    internals.finishWorkspaceServerExit(workspaceId, child, url, cleanup, code, signal);
  });
  return child;
}

async function flushMicrotasks(): Promise<void> {
  await new Promise<void>((resolve) => queueMicrotask(resolve));
}

const RUNNING_URL = "ws://127.0.0.1:1234/ws";

describe("chaos: desktop server manager", () => {
  test("scenario 1: killing the server after server_listening is detected and reported", async () => {
    const exits: ExitEvent[] = [];
    const manager = new ServerManager({
      onWorkspaceServerExited: (event) => exits.push(event),
    });

    // The child announces itself the way a real server does.
    const child = createFakeChild();
    const waitPromise = __internal.waitForServerListening(child as never);
    child.emitServerListening({ url: RUNNING_URL, port: 1234, cwd: "C:\\tmp" });
    const listening = await waitPromise;
    expect(listening.url).toBe(RUNNING_URL);

    // Register it as running, then kill it out from under the supervisor.
    const internals = internalsOf(manager);
    const cleanup = () => {};
    internals.servers.set("ws-1", { child, url: listening.url, mobileH3: null, cleanup });
    child.once("exit", (code: number | null, signal: NodeJS.Signals | null) => {
      internals.finishWorkspaceServerExit("ws-1", child, listening.url, cleanup, code, signal);
    });

    child.killWith(null, "SIGKILL");
    await flushMicrotasks();

    // The death is surfaced via the exit callback and the lifecycle diagnostics.
    expect(exits).toEqual([
      { workspaceId: "ws-1", url: RUNNING_URL, code: null, signal: "SIGKILL" },
    ]);
    const diagnostics = manager.getDiagnostics();
    const workspace = diagnostics.workspaces.find((entry) => entry.workspaceId === "ws-1");
    expect(workspace?.running).toBe(false);
    expect(workspace?.lastChildExit).toMatchObject({ code: null, signal: "SIGKILL" });

    // The reaped server is gone, so a follow-up status query finds nothing.
    const status = await manager.getWorkspaceServerStatus("ws-1");
    expect(status.reason).toBe("not_found");
  });

  test("scenario 3: a health probe that stalls past 1.5s is reported as health_failed", async () => {
    const manager = new ServerManager({
      // Models the AbortController firing after SERVER_HEALTH_TIMEOUT_MS (1.5s).
      fetch: (async () => {
        throw Object.assign(new Error("The operation was aborted."), { name: "AbortError" });
      }) as unknown as typeof fetch,
    });
    registerRunningServer(manager, "ws-1", RUNNING_URL);

    const status = await manager.getWorkspaceServerStatus("ws-1");
    expect(status.reason).toBe("health_failed");
    expect(status.running).toBe(false);
    expect(status.error).toContain("aborted");
  });

  test("scenario 5: a 503 from /cowork/health is reported as health_failed", async () => {
    const manager = new ServerManager({
      fetch: (async () => new Response("", { status: 503 })) as unknown as typeof fetch,
    });
    registerRunningServer(manager, "ws-1", RUNNING_URL);

    const status = await manager.getWorkspaceServerStatus("ws-1");
    expect(status.reason).toBe("health_failed");
    expect(status.running).toBe(false);
    expect(status.error).toBe("HTTP 503");
  });

  test("a healthy 200 keeps the server marked running", async () => {
    const manager = new ServerManager({
      fetch: (async () =>
        new Response(JSON.stringify({ ok: true }), { status: 200 })) as unknown as typeof fetch,
    });
    registerRunningServer(manager, "ws-1", RUNNING_URL);

    const status = await manager.getWorkspaceServerStatus("ws-1");
    expect(status.reason).toBe("running");
    expect(status.running).toBe(true);
  });
});
