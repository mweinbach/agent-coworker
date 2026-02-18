import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

let userDataDir = "";

mock.module("electron", () => ({
  app: {
    getPath: () => userDataDir,
  },
}));

const { PersistenceService } = await import("../electron/services/persistence");

function unixMode(mode: number): number {
  return mode & 0o777;
}

describe("desktop persistence permissions", () => {
  beforeEach(async () => {
    userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-desktop-persist-"));
  });

  afterEach(async () => {
    if (!userDataDir) {
      return;
    }
    await fs.rm(userDataDir, { recursive: true, force: true });
    userDataDir = "";
  });

  test("writes state file with private permissions", async () => {
    const persistence = new PersistenceService();
    await persistence.saveState({
      version: 1,
      workspaces: [],
      threads: [],
      developerMode: false,
    });

    const statePath = path.join(userDataDir, "state.json");
    const stat = await fs.stat(statePath);

    if (process.platform !== "win32") {
      expect(unixMode(stat.mode)).toBe(0o600);
    }
  });

  test("writes transcript files with private permissions", async () => {
    const persistence = new PersistenceService();
    await persistence.appendTranscriptEvent({
      ts: new Date(0).toISOString(),
      threadId: "thread_1",
      direction: "server",
      payload: { message: "hello" },
    });

    const transcriptDir = path.join(userDataDir, "transcripts");
    const transcriptPath = path.join(transcriptDir, "thread_1.jsonl");
    const transcriptStat = await fs.stat(transcriptPath);
    const dirStat = await fs.stat(transcriptDir);

    if (process.platform !== "win32") {
      expect(unixMode(transcriptStat.mode)).toBe(0o600);
      expect(unixMode(dirStat.mode)).toBe(0o700);
    }
  });
});
