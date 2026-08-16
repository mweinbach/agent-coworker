import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import fs from "node:fs/promises";
import path from "node:path";

import { scratchRoots } from "../../../src/platform/sandbox";
import { pinHome } from "../../../test/helpers/platform";
import { createElectronMock, setElectronMockOverrides } from "./helpers/mockElectron";

let userDataDir = "";
let appDataDir = "";
let restoreHome: (() => void) | null = null;

const electronMockOverrides = {
  app: {
    getPath: (name: string) => (name === "appData" ? appDataDir : userDataDir),
  },
  BrowserWindow: {
    getAllWindows: () => [],
    fromWebContents: () => null,
    getFocusedWindow: () => null,
  },
  Menu: {
    buildFromTemplate() {
      return {
        popup() {},
      };
    },
  },
};

setElectronMockOverrides(electronMockOverrides);

mock.module("electron", () => createElectronMock());

const { PersistenceService } = await import("../electron/services/persistence");

const TS = "2024-01-01T00:00:00.000Z";

const UNSAFE_THREAD_IDS = ["../escape", "foo/bar", "..", ".", "", "a".repeat(257)];

describe("desktop persistence transcript path guards", () => {
  beforeEach(() => {
    setElectronMockOverrides(electronMockOverrides);
  });

  beforeEach(async () => {
    const [scratchRoot] = scratchRoots();
    if (!scratchRoot) {
      throw new Error("No platform scratch root is available for transcript guard tests.");
    }
    appDataDir = await fs.mkdtemp(path.join(scratchRoot, "cowork-desktop-transcript-guards-"));
    restoreHome = pinHome(appDataDir);
    userDataDir = path.join(appDataDir, "Cowork");
    await fs.mkdir(userDataDir, { recursive: true });
  });

  afterEach(async () => {
    if (appDataDir) {
      await fs.rm(appDataDir, { recursive: true, force: true });
    }
    restoreHome?.();
    restoreHome = null;
    userDataDir = "";
    appDataDir = "";
  });

  test("read, append, and delete reject unsafe thread ids before I/O", async () => {
    const persistence = new PersistenceService();

    for (const threadId of UNSAFE_THREAD_IDS) {
      await expect(persistence.readTranscript(threadId)).rejects.toThrow(
        "threadId contains invalid characters",
      );
      await expect(
        persistence.appendTranscriptEvent({
          ts: TS,
          threadId,
          direction: "server",
          payload: { type: "log", line: "should-not-write" },
        }),
      ).rejects.toThrow("threadId contains invalid characters");
      await expect(persistence.deleteTranscript(threadId)).rejects.toThrow(
        "threadId contains invalid characters",
      );
    }

    const escaped = path.join(userDataDir, "escape.jsonl");
    await expect(fs.stat(escaped)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.stat(path.join(userDataDir, "..", "escape.jsonl"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  test("append writes only inside the transcripts directory for a safe thread id", async () => {
    const persistence = new PersistenceService();

    await persistence.appendTranscriptEvent({
      ts: TS,
      threadId: "thread_safe",
      direction: "client",
      payload: { type: "ping" },
    });

    const transcriptPath = path.join(userDataDir, "transcripts", "thread_safe.jsonl");
    const raw = await fs.readFile(transcriptPath, "utf8");
    expect(raw).toContain("thread_safe");
    expect(await persistence.readTranscript("thread_safe")).toHaveLength(1);

    await persistence.deleteTranscript("thread_safe");
    await expect(fs.stat(transcriptPath)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
