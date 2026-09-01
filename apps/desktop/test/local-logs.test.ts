import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import fs from "node:fs/promises";
import path from "node:path";

import { scratchRoots } from "../../../src/platform/sandbox/policy";
import { createElectronMock } from "./helpers/mockElectron";

const LOG_FILE_LIMIT = 5 * 1024 * 1024;
const LOG_RECORD_LIMIT = 16 * 1024;
let userDataDir = "";

mock.module("electron", () => createElectronMock({ app: { getPath: () => userDataDir } }));
const { flushLocalLogWrites, getLocalLogPath, tailLog, writeLocalLog } = await import(
  "../electron/services/localLogs"
);

beforeEach(async () => {
  userDataDir = await fs.mkdtemp(path.join(scratchRoots()[0], "cowork-local-logs-"));
});

afterEach(async () => {
  await flushLocalLogWrites();
  mock.restore();
  await fs.rm(userDataDir, { recursive: true, force: true });
});

async function readEntries(fileName: "desktop-main.log" | "server.log" = "desktop-main.log") {
  const contents = await fs.readFile(getLocalLogPath(fileName), "utf8");
  return contents
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as { message: string; meta?: Record<string, unknown> });
}

describe("local desktop logs", () => {
  test("compacts an existing oversized log while retaining recent complete records", async () => {
    const logPath = getLocalLogPath("desktop-main.log");
    await fs.mkdir(path.dirname(logPath));
    await fs.writeFile(
      logPath,
      `${"old data".repeat(LOG_FILE_LIMIT / 8 + 100)}\n${JSON.stringify({ message: "recent context" })}\n`,
    );

    writeLocalLog("desktop-main.log", "info", "test", "new context");
    await flushLocalLogWrites();

    expect((await fs.stat(logPath)).size).toBeLessThanOrEqual(LOG_FILE_LIMIT);
    expect((await readEntries()).map((entry) => entry.message)).toEqual([
      "recent context",
      "new context",
    ]);
  });

  test("preserves queued record order when normal appends cross the size limit", async () => {
    const logPath = getLocalLogPath("desktop-main.log");
    await fs.mkdir(path.dirname(logPath));
    const prefix = `${JSON.stringify({ message: "old", padding: "x".repeat(LOG_FILE_LIMIT - 300) })}\n`;
    await fs.writeFile(logPath, prefix);

    for (let index = 0; index < 12; index += 1) {
      writeLocalLog("desktop-main.log", "info", "test", `queued ${index}`);
    }
    await flushLocalLogWrites();

    expect((await fs.stat(logPath)).size).toBeLessThanOrEqual(LOG_FILE_LIMIT);
    expect((await readEntries()).map((entry) => entry.message)).toEqual(
      Array.from({ length: 12 }, (_, index) => `queued ${index}`),
    );
  });

  test("caps individual JSON records without losing redaction or the message", async () => {
    const metadata = Object.fromEntries(
      Array.from({ length: 60 }, (_, index) => [`field${index}`, "x".repeat(1024)]),
    );
    writeLocalLog(
      "desktop-main.log",
      "error",
      "test",
      "token=synthetic-private-token failed",
      metadata,
    );
    await flushLocalLogWrites();

    const contents = await fs.readFile(getLocalLogPath("desktop-main.log"), "utf8");
    expect(Buffer.byteLength(contents)).toBeLessThanOrEqual(LOG_RECORD_LIMIT);
    expect(contents).not.toContain("synthetic-private-token");
    const entry = JSON.parse(contents);
    expect(entry.message).toContain("failed");
    expect(entry.meta.truncated).toBe(true);
  });

  test("does not rescan a growing log on each normal append", async () => {
    writeLocalLog("desktop-main.log", "info", "test", "first");
    await flushLocalLogWrites();
    const stat = spyOn(fs, "stat");
    const readFile = spyOn(fs, "readFile");
    const mkdir = spyOn(fs, "mkdir");

    for (let index = 0; index < 5; index += 1) {
      writeLocalLog("desktop-main.log", "info", "test", `next ${index}`);
    }
    await flushLocalLogWrites();

    expect(stat).not.toHaveBeenCalled();
    expect(readFile).not.toHaveBeenCalled();
    expect(mkdir).not.toHaveBeenCalled();
  });

  test("recovers after a failed append without dropping subsequent records", async () => {
    const appendFile = spyOn(fs, "appendFile").mockRejectedValueOnce(new Error("disk unavailable"));
    writeLocalLog("desktop-main.log", "info", "test", "failed record");
    writeLocalLog("desktop-main.log", "info", "test", "recovered record");
    await flushLocalLogWrites();

    expect(appendFile).toHaveBeenCalledTimes(2);
    expect((await readEntries()).map((entry) => entry.message)).toEqual(["recovered record"]);
  });

  test("preserves the original log if compaction fails and retries on the next write", async () => {
    const logPath = getLocalLogPath("desktop-main.log");
    await fs.mkdir(path.dirname(logPath));
    const original = `${"x".repeat(LOG_FILE_LIMIT)}\n${JSON.stringify({ message: "recent context" })}\n`;
    await fs.writeFile(logPath, original);
    const rename = spyOn(fs, "rename").mockRejectedValueOnce(new Error("replace unavailable"));

    writeLocalLog("desktop-main.log", "info", "test", "failed compaction");
    await flushLocalLogWrites();
    expect((await fs.stat(logPath)).size).toBe(Buffer.byteLength(original));
    rename.mockRestore();

    writeLocalLog("desktop-main.log", "info", "test", "retry succeeded");
    await flushLocalLogWrites();
    expect((await fs.stat(logPath)).size).toBeLessThanOrEqual(LOG_FILE_LIMIT);
    expect((await readEntries()).map((entry) => entry.message)).toEqual([
      "recent context",
      "retry succeeded",
    ]);
  });

  test("a metadata serialization failure cannot throw into the caller", async () => {
    const metadata = {
      get detail() {
        throw new Error("unavailable metadata");
      },
    };
    expect(() =>
      writeLocalLog("desktop-main.log", "info", "test", "bad metadata", metadata),
    ).not.toThrow();
    writeLocalLog("desktop-main.log", "info", "test", "healthy record");
    await flushLocalLogWrites();

    expect((await readEntries()).at(-1)?.message).toBe("healthy record");
  });
});

describe("tailLog", () => {
  test("uses the file opened after a concurrent replacement", async () => {
    const file = path.join(userDataDir, "tail.log");
    await fs.writeFile(file, "long original content");
    const open = fs.open.bind(fs);
    spyOn(fs, "open").mockImplementation(async (...args) => {
      await fs.writeFile(file, "new");
      return open(...args);
    });

    expect(await tailLog(file, 100)).toBe("new");
  });

  test("does not pad with NUL bytes when the file shrinks between stat and read", async () => {
    const file = path.join(userDataDir, "tail.log");
    await fs.writeFile(file, "1234567890");
    const open = fs.open.bind(fs);
    spyOn(fs, "open").mockImplementation(async (...args) => {
      const handle = await open(...args);
      const read = handle.read.bind(handle);
      let truncated = false;
      spyOn(handle, "read").mockImplementation(async (...readArgs) => {
        if (!truncated) {
          truncated = true;
          await fs.truncate(file, 4);
        }
        return read(...readArgs);
      });
      return handle;
    });

    expect(await tailLog(file, 100)).toBe("1234");
  });
});
