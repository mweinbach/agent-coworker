import { describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { SessionDb } from "../src/server/sessionDb";
import type { PersistedSessionSnapshot } from "../src/server/sessionStore";

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

function makeLegacySnapshot(sessionId: string): PersistedSessionSnapshot {
  const now = new Date("2024-01-01T00:00:00.000Z").toISOString();
  return {
    version: 1,
    sessionId,
    createdAt: now,
    updatedAt: now,
    session: {
      title: "Imported Session",
      titleSource: "heuristic",
      titleModel: null,
      provider: "google",
      model: "gemini-2.0-flash",
    },
    config: {
      provider: "google",
      model: "gemini-2.0-flash",
      enableMcp: true,
      workingDirectory: "/tmp/project",
    },
    context: {
      system: "You are a helpful assistant.",
      messages: [
        { role: "user", content: "hello" },
        { role: "assistant", content: "hi" },
      ],
      todos: [],
      harnessContext: null,
    },
  };
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

  test("imports legacy JSON snapshots once at startup and skips malformed files", async () => {
    const paths = await makeTmpCoworkHome();
    const legacy = makeLegacySnapshot("legacy-1");
    await fs.writeFile(
      path.join(paths.sessionsDir, "legacy-1.json"),
      `${JSON.stringify(legacy, null, 2)}\n`,
      "utf-8"
    );
    await fs.writeFile(path.join(paths.sessionsDir, "broken.json"), "{ bad json", "utf-8");

    const first = await SessionDb.create({ paths });
    try {
      const sessions = first.listSessions();
      expect(sessions.map((entry) => entry.sessionId)).toContain("legacy-1");
      const record = first.getSessionRecord("legacy-1");
      expect(record?.lastEventSeq).toBe(1);
      expect(record?.messages.length).toBe(2);
    } finally {
      first.close();
    }

    const second = await SessionDb.create({ paths });
    try {
      const record = second.getSessionRecord("legacy-1");
      expect(record?.lastEventSeq).toBe(1);
      expect(second.listSessions().filter((entry) => entry.sessionId === "legacy-1")).toHaveLength(1);
    } finally {
      second.close();
    }
  });
});
