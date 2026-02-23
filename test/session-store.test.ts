import { describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  getPersistedSessionFilePath,
  listPersistedSessionSnapshots,
  parsePersistedSessionSnapshot,
  readPersistedSessionSnapshot,
  writePersistedSessionSnapshot,
  type PersistedSessionSnapshot,
} from "../src/server/sessionStore";

function makeSnapshot(sessionId: string): PersistedSessionSnapshot {
  return {
    version: 1,
    sessionId,
    createdAt: "2026-02-19T00:00:00.000Z",
    updatedAt: "2026-02-19T00:00:01.000Z",
    session: {
      title: "Persisted session title",
      titleSource: "model",
      titleModel: "gpt-5-mini",
      provider: "openai",
      model: "gpt-5.2",
    },
    config: {
      provider: "openai",
      model: "gpt-5.2",
      enableMcp: true,
      workingDirectory: "/tmp/workspace",
      outputDirectory: "/tmp/workspace/output",
      uploadsDirectory: "/tmp/workspace/uploads",
    },
    context: {
      system: "System prompt",
      messages: [
        { role: "user", content: "hello" },
        { role: "assistant", content: "world" },
      ] as any,
      todos: [{ content: "Do thing", status: "pending", activeForm: "Doing thing" }],
      harnessContext: {
        runId: "run-1",
        objective: "Test",
        acceptanceCriteria: ["A"],
        constraints: ["C"],
        updatedAt: "2026-02-19T00:00:00.000Z",
      },
    },
  };
}

describe("sessionStore", () => {
  test("writes and reads a persisted session snapshot", async () => {
    const sessionsDir = await fs.mkdtemp(path.join(os.tmpdir(), "session-store-test-"));
    const sessionId = "sess-123";
    const snapshot = makeSnapshot(sessionId);

    const writtenPath = await writePersistedSessionSnapshot({
      paths: { sessionsDir },
      snapshot,
    });

    expect(writtenPath).toBe(getPersistedSessionFilePath({ sessionsDir }, sessionId));

    const loaded = await readPersistedSessionSnapshot({
      paths: { sessionsDir },
      sessionId,
    });

    expect(loaded).toEqual(snapshot);
  });

  test("readPersistedSessionSnapshot throws for malformed files", async () => {
    const sessionsDir = await fs.mkdtemp(path.join(os.tmpdir(), "session-store-test-"));
    const sessionId = "sess-bad";
    const filePath = getPersistedSessionFilePath({ sessionsDir }, sessionId);

    await fs.writeFile(filePath, "not valid json {{{", "utf-8");

    await expect(
      readPersistedSessionSnapshot({ paths: { sessionsDir }, sessionId }),
    ).rejects.toThrow("Invalid JSON in persisted session snapshot");
  });

  test("parsePersistedSessionSnapshot rejects invalid shape", () => {
    expect(() =>
      parsePersistedSessionSnapshot({
        version: 1,
        sessionId: "sess-1",
        createdAt: "2026-02-19T00:00:00.000Z",
        updatedAt: "2026-02-19T00:00:01.000Z",
        session: { title: "x" },
      }),
    ).toThrow("Invalid persisted session snapshot");
  });

  test("listPersistedSessionSnapshots skips malformed files", async () => {
    const sessionsDir = await fs.mkdtemp(path.join(os.tmpdir(), "session-store-list-test-"));
    const snapshotA = makeSnapshot("sess-a");
    const snapshotB = {
      ...makeSnapshot("sess-b"),
      updatedAt: "2026-02-19T00:00:02.000Z",
    };

    await writePersistedSessionSnapshot({
      paths: { sessionsDir },
      snapshot: snapshotA,
    });
    await writePersistedSessionSnapshot({
      paths: { sessionsDir },
      snapshot: snapshotB,
    });

    await fs.writeFile(path.join(sessionsDir, "broken.json"), "{ invalid", "utf-8");
    await fs.writeFile(path.join(sessionsDir, "invalid-shape.json"), JSON.stringify({ version: 1 }), "utf-8");

    const summaries = await listPersistedSessionSnapshots({ sessionsDir });

    expect(summaries.map((summary) => summary.sessionId)).toEqual(["sess-b", "sess-a"]);
    expect(summaries).toHaveLength(2);
  });
});
