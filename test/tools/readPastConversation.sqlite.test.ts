import { describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import path from "node:path";

import { SessionDb } from "../../src/server/sessionDb";
import {
  type PersistedSessionSnapshot,
  writePersistedSessionSnapshot,
} from "../../src/server/sessionStore";
import type { ToolContext } from "../../src/tools/context";
import { createReadPastConversationTool } from "../../src/tools/readPastConversation";
import type { ModelMessage } from "../../src/types";
import { makeConfig, makeSession } from "../session/agentSession.harness";

async function makeTmpCoworkHome(prefix = "read-past-sqlite-"): Promise<{
  home: string;
  rootDir: string;
  sessionsDir: string;
}> {
  const home = await fs.mkdtemp(path.join("/tmp", prefix));
  const rootDir = path.join(home, ".cowork");
  const sessionsDir = path.join(rootDir, "sessions");
  await fs.mkdir(sessionsDir, { recursive: true });
  return { home, rootDir, sessionsDir };
}

async function persistConversation(
  db: SessionDb,
  opts: {
    sessionId: string;
    title: string;
    workingDirectory: string;
    updatedAt: string;
    messages: ModelMessage[];
  },
): Promise<void> {
  await db.persistSessionMutation({
    sessionId: opts.sessionId,
    eventType: "session.created",
    snapshot: {
      sessionKind: "root",
      parentSessionId: null,
      role: null,
      title: opts.title,
      titleSource: "manual",
      titleModel: null,
      provider: "google",
      model: "gemini-3-flash-preview",
      workingDirectory: opts.workingDirectory,
      enableMcp: true,
      createdAt: "2026-08-25T00:00:00.000Z",
      updatedAt: opts.updatedAt,
      status: "active",
      hasPendingAsk: false,
      hasPendingApproval: false,
      systemPrompt: "system",
      messages: opts.messages,
      providerState: null,
      todos: [],
      harnessContext: null,
      costTracker: null,
    },
  });
}

function makeLegacySnapshot(opts: {
  sessionId: string;
  title: string;
  workingDirectory: string;
  updatedAt: string;
  messages: ModelMessage[];
}): PersistedSessionSnapshot {
  return {
    version: 4,
    sessionId: opts.sessionId,
    createdAt: "2026-08-25T00:00:00.000Z",
    updatedAt: opts.updatedAt,
    session: {
      title: opts.title,
      titleSource: "manual",
      titleModel: null,
      provider: "google",
      model: "gemini-3-flash-preview",
      sessionKind: "root",
      parentSessionId: null,
      role: null,
    },
    config: {
      provider: "google",
      model: "gemini-3-flash-preview",
      enableMcp: true,
      workingDirectory: opts.workingDirectory,
      outputDirectory: path.join(opts.workingDirectory, "output"),
      uploadsDirectory: path.join(opts.workingDirectory, "uploads"),
    },
    context: {
      system: "system",
      messages: opts.messages,
      providerState: null,
      todos: [],
      harnessContext: null,
      costTracker: null,
    },
  };
}

async function writeLegacySnapshot(
  sessionsDir: string,
  snapshot: PersistedSessionSnapshot,
): Promise<void> {
  await writePersistedSessionSnapshot({ paths: { sessionsDir }, snapshot });
}

describe("readPastConversation SQLite history", () => {
  test("reads canonical SQLite sessions through the owning AgentSession", async () => {
    const paths = await makeTmpCoworkHome();
    const workspace = path.join(paths.home, "workspace");
    const otherWorkspace = path.join(paths.home, "other-workspace");
    const db = await SessionDb.create({ paths });

    try {
      await persistConversation(db, {
        sessionId: "sqlite-active",
        title: "SQLite Active",
        workingDirectory: workspace,
        updatedAt: "2026-08-25T00:00:02.000Z",
        messages: [
          { role: "user", content: "active sqlite hello" },
          { role: "assistant", content: "active sqlite answer" },
        ],
      });
      await persistConversation(db, {
        sessionId: "sqlite-other",
        title: "SQLite Other",
        workingDirectory: otherWorkspace,
        updatedAt: "2026-08-25T00:00:03.000Z",
        messages: [
          { role: "user", content: "other sqlite secret" },
          { role: "assistant", content: "other sqlite answer" },
        ],
      });

      const config = { ...makeConfig(workspace), advancedMemory: true };
      const { session } = makeSession({ config, sessionDb: db });
      await session.waitForPersistenceIdle({ throwOnError: true });

      try {
        const tool = createReadPastConversationTool(
          {
            config,
            sessionId: session.id,
            log: () => {},
          } as ToolContext,
          { getPaths: () => ({ sessionsDir: path.join(paths.home, "missing-legacy-sessions") }) },
        );

        const listOut = (await tool.execute({ list: true })) as string;
        expect(listOut).toContain("sqlite-active");
        expect(listOut).not.toContain("sqlite-other");

        const activeOut = (await tool.execute({ sessionId: "sqlite-active" })) as string;
        expect(activeOut).toContain("# SQLite Active");
        expect(activeOut).toContain("active sqlite hello");
        expect(activeOut).toContain("active sqlite answer");

        const otherOut = (await tool.execute({ sessionId: "sqlite-other" })) as string;
        expect(otherOut).toContain('No conversation found for sessionId "sqlite-other"');
        expect(otherOut).not.toContain("other sqlite secret");
      } finally {
        session.dispose("test complete", { closeSharedCodexClient: false });
        await session.waitForPersistenceIdle({ throwOnError: true });
      }
    } finally {
      db.close();
      await fs.rm(paths.home, { recursive: true, force: true });
    }
  });

  test("merges SQLite and legacy histories without cross-workspace fallback", async () => {
    const paths = await makeTmpCoworkHome("read-past-mixed-");
    const workspace = path.join(paths.home, "workspace");
    const otherWorkspace = path.join(paths.home, "other-workspace");
    const db = await SessionDb.create({ paths });

    try {
      await persistConversation(db, {
        sessionId: "sqlite-active",
        title: "SQLite Active",
        workingDirectory: workspace,
        updatedAt: "2026-08-25T00:00:02.000Z",
        messages: [
          { role: "user", content: "active sqlite hello" },
          { role: "assistant", content: "active sqlite answer" },
        ],
      });
      await persistConversation(db, {
        sessionId: "sqlite-other",
        title: "SQLite Other",
        workingDirectory: otherWorkspace,
        updatedAt: "2026-08-25T00:00:04.000Z",
        messages: [
          { role: "user", content: "other sqlite secret" },
          { role: "assistant", content: "other sqlite answer" },
        ],
      });
      await writeLegacySnapshot(
        paths.sessionsDir,
        makeLegacySnapshot({
          sessionId: "legacy-active",
          title: "Legacy Active",
          workingDirectory: workspace,
          updatedAt: "2026-08-25T00:00:03.000Z",
          messages: [
            { role: "user", content: "active legacy hello" },
            { role: "assistant", content: "active legacy answer" },
          ],
        }),
      );
      await writeLegacySnapshot(
        paths.sessionsDir,
        makeLegacySnapshot({
          sessionId: "sqlite-active",
          title: "Legacy Duplicate",
          workingDirectory: workspace,
          updatedAt: "2026-08-25T00:00:05.000Z",
          messages: [{ role: "user", content: "duplicate legacy should not win" }],
        }),
      );
      await writeLegacySnapshot(
        paths.sessionsDir,
        makeLegacySnapshot({
          sessionId: "legacy-other",
          title: "Legacy Other",
          workingDirectory: otherWorkspace,
          updatedAt: "2026-08-25T00:00:06.000Z",
          messages: [{ role: "user", content: "other legacy secret" }],
        }),
      );
      await writeLegacySnapshot(
        paths.sessionsDir,
        makeLegacySnapshot({
          sessionId: "sqlite-other",
          title: "Legacy Same Id Active",
          workingDirectory: workspace,
          updatedAt: "2026-08-25T00:00:07.000Z",
          messages: [{ role: "user", content: "same id legacy fallback secret" }],
        }),
      );

      const config = { ...makeConfig(workspace), advancedMemory: true };
      const { session } = makeSession({ config, sessionDb: db });
      await session.waitForPersistenceIdle({ throwOnError: true });

      try {
        const tool = createReadPastConversationTool(
          {
            config,
            sessionId: session.id,
            log: () => {},
          } as ToolContext,
          { getPaths: () => ({ sessionsDir: paths.sessionsDir }) },
        );

        const listOut = (await tool.execute({ list: true })) as string;
        expect(listOut).toContain("sqlite-active");
        expect(listOut).toContain("legacy-active");
        expect(listOut).not.toContain("Legacy Duplicate");
        expect(listOut).not.toContain("legacy-other");
        expect(listOut).not.toContain("other legacy secret");
        expect(listOut).not.toContain("sqlite-other");

        const sqliteOut = (await tool.execute({ sessionId: "sqlite-active" })) as string;
        expect(sqliteOut).toContain("# SQLite Active");
        expect(sqliteOut).toContain("active sqlite hello");
        expect(sqliteOut).not.toContain("duplicate legacy should not win");

        const legacyOut = (await tool.execute({ sessionId: "legacy-active" })) as string;
        expect(legacyOut).toContain("# Legacy Active");
        expect(legacyOut).toContain("active legacy hello");

        const legacyOtherOut = (await tool.execute({ sessionId: "legacy-other" })) as string;
        expect(legacyOtherOut).toContain('No conversation found for sessionId "legacy-other"');
        expect(legacyOtherOut).not.toContain("other legacy secret");

        const otherOut = (await tool.execute({ sessionId: "sqlite-other" })) as string;
        expect(otherOut).toContain('No conversation found for sessionId "sqlite-other"');
        expect(otherOut).not.toContain("other sqlite secret");
        expect(otherOut).not.toContain("same id legacy fallback secret");
      } finally {
        session.dispose("test complete", { closeSharedCodexClient: false });
        await session.waitForPersistenceIdle({ throwOnError: true });
      }
    } finally {
      db.close();
      await fs.rm(paths.home, { recursive: true, force: true });
    }
  });
});
