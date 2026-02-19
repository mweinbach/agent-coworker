import { describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  getPersistedSessionFilePath,
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

  test("readPersistedSessionSnapshot returns null for malformed files", async () => {
    const sessionsDir = await fs.mkdtemp(path.join(os.tmpdir(), "session-store-test-"));
    const sessionId = "sess-bad";
    const filePath = getPersistedSessionFilePath({ sessionsDir }, sessionId);

    await fs.writeFile(filePath, "not valid json {{{", "utf-8");

    const loaded = await readPersistedSessionSnapshot({ paths: { sessionsDir }, sessionId });
    expect(loaded).toBeNull();
  });

  test("parsePersistedSessionSnapshot rejects invalid shape", () => {
    const parsed = parsePersistedSessionSnapshot({
      version: 1,
      sessionId: "sess-1",
      createdAt: "2026-02-19T00:00:00.000Z",
      updatedAt: "2026-02-19T00:00:01.000Z",
      session: { title: "x" },
    });
    expect(parsed).toBeNull();
  });
});
