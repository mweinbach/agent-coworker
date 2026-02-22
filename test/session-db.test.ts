import { describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { SessionDb } from "../src/server/sessionDb";

async function makeTmpCoworkHome(prefix = "session-db-test-"): Promise<{
  rootDir: string;
  sessionsDir: string;
}> {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  const rootDir = path.join(home, ".cowork");
  const sessionsDir = path.join(rootDir, "sessions");
  await fs.mkdir(sessionsDir, { recursive: true });
  return { rootDir, sessionsDir };
}

describe("sessionDb", () => {
  test("persists/lists/deletes sessions with canonical state", async () => {
    const paths = await makeTmpCoworkHome();
    const db = await SessionDb.create({ paths });
    try {
      const now = new Date().toISOString();
      db.persistSessionMutation({
        sessionId: "s-1",
        eventType: "session.created",
        snapshot: {
          title: "Session One",
          titleSource: "default",
          titleModel: null,
          provider: "google",
          model: "gemini-2.0-flash",
          workingDirectory: "/tmp/project",
          enableMcp: true,
          createdAt: now,
          updatedAt: now,
          status: "active",
          hasPendingAsk: false,
          hasPendingApproval: false,
          systemPrompt: "system",
          messages: [{ role: "user", content: "hello" }],
          todos: [],
          harnessContext: null,
        },
      });

      const sessions = db.listSessions();
      expect(sessions).toHaveLength(1);
      expect(sessions[0]?.sessionId).toBe("s-1");
      expect(sessions[0]?.messageCount).toBe(1);

      const paged = db.getMessages("s-1", 0, 10);
      expect(paged.total).toBe(1);
      expect(paged.messages).toHaveLength(1);

      const persisted = db.getSessionRecord("s-1");
      expect(persisted?.sessionId).toBe("s-1");
      expect(persisted?.lastEventSeq).toBe(1);

      db.deleteSession("s-1");
      expect(db.getSessionRecord("s-1")).toBeNull();
    } finally {
      db.close();
    }
  });

  test("imports legacy JSON snapshots before marking legacy migration as applied", async () => {
    const paths = await makeTmpCoworkHome();
    const now = new Date().toISOString();

    await fs.writeFile(
      path.join(paths.sessionsDir, "legacy-1.json"),
      JSON.stringify({
        version: 1,
        sessionId: "legacy-1",
        createdAt: now,
        updatedAt: now,
        session: {
          title: "Legacy Session",
          titleSource: "default",
          titleModel: null,
          provider: "google",
          model: "gemini-2.0-flash",
        },
        config: {
          provider: "google",
          model: "gemini-2.0-flash",
          enableMcp: false,
          workingDirectory: "/tmp/legacy",
        },
        context: {
          system: "legacy",
          messages: [{ role: "user", content: "hello from legacy" }],
          todos: [],
          harnessContext: null,
        },
      }),
      "utf-8",
    );

    const db = await SessionDb.create({ paths });
    try {
      const sessions = db.listSessions();
      expect(sessions).toHaveLength(1);
      expect(sessions[0]?.sessionId).toBe("legacy-1");
      expect(sessions[0]?.messageCount).toBe(1);

      const persisted = db.getSessionRecord("legacy-1");
      expect(persisted?.title).toBe("Legacy Session");
      expect(persisted?.messages).toHaveLength(1);
    } finally {
      db.close();
    }
  });

  test("fails to create database when legacy snapshot JSON is malformed", async () => {
    const paths = await makeTmpCoworkHome();
    await fs.writeFile(path.join(paths.sessionsDir, "legacy-bad.json"), "not valid json {{{", "utf-8");

    await expect(SessionDb.create({ paths })).rejects.toThrow("Invalid JSON in legacy session snapshot");
  });
});
