import { describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { SkillMutationBus } from "../src/server/runtime/SkillMutationBus";
import {
  readSharedSkillMutationSignal,
  resolveSharedSkillMutationSignalPath,
  writeSharedSkillMutationSignal,
} from "../src/server/sharedSkillMutationSignal";

type RefreshCall = {
  workingDirectory: string;
  sourceSessionId?: string;
  allWorkspaces?: boolean;
};

type TestableSkillMutationBus = SkillMutationBus & {
  applySignal: () => Promise<void>;
  scheduleRefresh: () => void;
  refreshLoop: Promise<void> | null;
};

async function makeTempCoworkDir(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "skill-mutation-bus-"));
  return path.join(root, ".cowork");
}

function asTestableBus(bus: SkillMutationBus): TestableSkillMutationBus {
  return bus as unknown as TestableSkillMutationBus;
}

function peerPid(): number {
  return process.pid + 10_000;
}

describe("SkillMutationBus", () => {
  test("refreshes all local workspaces for a peer process signal", async () => {
    const userCoworkDir = await makeTempCoworkDir();
    const workingDirectory = path.join(path.dirname(userCoworkDir), "workspace");
    const calls: RefreshCall[] = [];
    const bus = asTestableBus(
      new SkillMutationBus({
        userCoworkDir,
        workingDirectory,
        refreshLocalSkillState: async (options) => {
          calls.push(options);
        },
      }),
    );
    const signalPath = resolveSharedSkillMutationSignalPath(userCoworkDir);

    await writeSharedSkillMutationSignal(signalPath, {
      revision: "peer-revision-1",
      pid: peerPid(),
      at: "2026-05-19T10:00:00.000Z",
    });

    await bus.applySignal();
    await bus.applySignal();

    expect(calls).toEqual([
      {
        workingDirectory,
        allWorkspaces: true,
      },
    ]);
  });

  test("does not refresh for a signal written by this process", async () => {
    const userCoworkDir = await makeTempCoworkDir();
    const calls: RefreshCall[] = [];
    const bus = asTestableBus(
      new SkillMutationBus({
        userCoworkDir,
        workingDirectory: "/workspace-a",
        refreshLocalSkillState: async (options) => {
          calls.push(options);
        },
      }),
    );

    await writeSharedSkillMutationSignal(resolveSharedSkillMutationSignalPath(userCoworkDir), {
      revision: "local-revision-1",
      pid: process.pid,
      at: "2026-05-19T10:00:00.000Z",
    });

    await bus.applySignal();

    expect(calls).toEqual([]);
  });

  test("coalesces queued signal changes while a refresh is in flight", async () => {
    const userCoworkDir = await makeTempCoworkDir();
    const signalPath = resolveSharedSkillMutationSignalPath(userCoworkDir);
    const calls: RefreshCall[] = [];
    let firstRefreshStarted: () => void = () => {};
    let releaseFirstRefresh: () => void = () => {};
    const firstRefreshStartedPromise = new Promise<void>((resolve) => {
      firstRefreshStarted = resolve;
    });
    const releaseFirstRefreshPromise = new Promise<void>((resolve) => {
      releaseFirstRefresh = resolve;
    });
    const bus = asTestableBus(
      new SkillMutationBus({
        userCoworkDir,
        workingDirectory: "/workspace-a",
        refreshLocalSkillState: async (options) => {
          calls.push(options);
          if (calls.length === 1) {
            firstRefreshStarted();
            await releaseFirstRefreshPromise;
          }
        },
      }),
    );

    await writeSharedSkillMutationSignal(signalPath, {
      revision: "peer-revision-1",
      pid: peerPid(),
      at: "2026-05-19T10:00:00.000Z",
    });
    bus.scheduleRefresh();
    const refreshLoop = bus.refreshLoop;
    expect(refreshLoop).toBeInstanceOf(Promise);
    await firstRefreshStartedPromise;

    await writeSharedSkillMutationSignal(signalPath, {
      revision: "peer-revision-2",
      pid: peerPid(),
      at: "2026-05-19T10:00:01.000Z",
    });
    bus.scheduleRefresh();
    await writeSharedSkillMutationSignal(signalPath, {
      revision: "peer-revision-3",
      pid: peerPid(),
      at: "2026-05-19T10:00:02.000Z",
    });
    bus.scheduleRefresh();
    releaseFirstRefresh();
    await refreshLoop;

    expect(calls).toEqual([
      {
        workingDirectory: "/workspace-a",
        allWorkspaces: true,
      },
      {
        workingDirectory: "/workspace-a",
        allWorkspaces: true,
      },
    ]);
  });

  test("ignores malformed shared mutation signal files", async () => {
    const userCoworkDir = await makeTempCoworkDir();
    const signalPath = resolveSharedSkillMutationSignalPath(userCoworkDir);
    const calls: RefreshCall[] = [];
    const bus = asTestableBus(
      new SkillMutationBus({
        userCoworkDir,
        workingDirectory: "/workspace-a",
        refreshLocalSkillState: async (options) => {
          calls.push(options);
        },
      }),
    );
    await fs.mkdir(userCoworkDir, { recursive: true });
    await fs.writeFile(signalPath, '{"revision": "", "pid": "not-a-number"}', "utf-8");

    const signal = await readSharedSkillMutationSignal(signalPath);
    await bus.applySignal();

    expect(signal).toBeNull();
    expect(calls).toEqual([]);
  });
});
