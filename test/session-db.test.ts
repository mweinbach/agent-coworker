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

  test("skips malformed legacy snapshots and still imports valid ones", async () => {
    const paths = await makeTmpCoworkHome();
    const now = new Date().toISOString();
    await fs.writeFile(
      path.join(paths.sessionsDir, "legacy-valid.json"),
      JSON.stringify({
        version: 1,
        sessionId: "legacy-valid",
        createdAt: now,
        updatedAt: now,
        session: {
          title: "Legacy Valid",
          titleSource: "default",
          titleModel: null,
          provider: "google",
          model: "gemini-2.0-flash",
        },
        config: {
          provider: "google",
          model: "gemini-2.0-flash",
          enableMcp: false,
          workingDirectory: "/tmp/legacy-valid",
        },
        context: {
          system: "legacy-valid",
          messages: [{ role: "user", content: "hello from valid legacy snapshot" }],
          todos: [],
          harnessContext: null,
        },
      }),
      "utf-8",
    );
    await fs.writeFile(path.join(paths.sessionsDir, "legacy-bad-json.json"), "not valid json {{{", "utf-8");
    await fs.writeFile(
      path.join(paths.sessionsDir, "legacy-bad-structure.json"),
      JSON.stringify({ version: 1, sessionId: "missing-fields" }),
      "utf-8",
    );

    const db = await SessionDb.create({ paths });
    try {
      const sessions = db.listSessions();
      expect(sessions).toHaveLength(1);
      expect(sessions[0]?.sessionId).toBe("legacy-valid");

      const persisted = db.getSessionRecord("legacy-valid");
      expect(persisted?.title).toBe("Legacy Valid");
      expect(persisted?.messages).toHaveLength(1);
    } finally {
      db.close();
    }
  });

  test("skips unreadable legacy snapshot entries while importing valid ones", async () => {
    const paths = await makeTmpCoworkHome();
    const now = new Date().toISOString();
    await fs.writeFile(
      path.join(paths.sessionsDir, "legacy-valid.json"),
      JSON.stringify({
        version: 1,
        sessionId: "legacy-valid",
        createdAt: now,
        updatedAt: now,
        session: {
          title: "Legacy Valid",
          titleSource: "default",
          titleModel: null,
          provider: "google",
          model: "gemini-2.0-flash",
        },
        config: {
          provider: "google",
          model: "gemini-2.0-flash",
          enableMcp: false,
          workingDirectory: "/tmp/legacy-valid",
        },
        context: {
          system: "legacy-valid",
          messages: [{ role: "user", content: "hello from valid legacy snapshot" }],
          todos: [],
          harnessContext: null,
        },
      }),
      "utf-8",
    );

    const unreadableDir = path.join(paths.sessionsDir, "legacy-unreadable.json");
    await fs.mkdir(unreadableDir);

    const db = await SessionDb.create({ paths });
    try {
      const sessions = db.listSessions();
      expect(sessions).toHaveLength(1);
      expect(sessions[0]?.sessionId).toBe("legacy-valid");

      const persisted = db.getSessionRecord("legacy-valid");
      expect(persisted?.title).toBe("Legacy Valid");
      expect(persisted?.messages).toHaveLength(1);
    } finally {
      db.close();
      await fs.rm(unreadableDir, { recursive: true, force: true });
    }
  });

  test("returns empty messages when messages_json is malformed", async () => {
    const paths = await makeTmpCoworkHome();
    const db = await SessionDb.create({ paths });
    try {
      const now = new Date().toISOString();
      db.persistSessionMutation({
        sessionId: "s-bad-messages",
        eventType: "session.created",
        snapshot: {
          title: "Session with bad messages",
          titleSource: "default",
          titleModel: null,
          provider: "google",
          model: "gemini-2.0-flash",
          workingDirectory: "/tmp/project",
          enableMcp: false,
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

      (db as any).db
        .query("UPDATE session_state SET messages_json = ? WHERE session_id = ?")
        .run("not-json", "s-bad-messages");

      const paged = db.getMessages("s-bad-messages", 0, 10);
      expect(paged.total).toBe(0);
      expect(paged.messages).toEqual([]);
    } finally {
      db.close();
    }
  });
});
