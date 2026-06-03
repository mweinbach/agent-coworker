import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  type PersistedSessionSnapshot,
  readPersistedSessionSnapshot,
  writePersistedSessionSnapshot,
} from "../src/server/sessionStore";
import type { ToolContext } from "../src/tools/context";
import { createReadPastConversationTool } from "../src/tools/readPastConversation";

let sessionsDir: string;

beforeEach(async () => {
  sessionsDir = await fs.mkdtemp(path.join(os.tmpdir(), "adv-mem-read-past-"));
});

afterEach(async () => {
  await fs.rm(sessionsDir, { recursive: true, force: true });
});

function makeCtx(): ToolContext {
  return {
    config: {
      workingDirectory: "/tmp/workspace",
    },
    log: () => {},
  } as unknown as ToolContext;
}

function makeSnapshot(
  sessionId: string,
  workingDirectory: string,
  content: string,
): PersistedSessionSnapshot {
  return {
    version: 4,
    sessionId,
    createdAt: "2026-02-19T00:00:00.000Z",
    updatedAt: "2026-02-19T00:00:01.000Z",
    session: {
      title: `${sessionId} title`,
      titleSource: "model",
      titleModel: "gpt-5-mini",
      provider: "openai",
      model: "gpt-5.2",
      sessionKind: "root",
      parentSessionId: null,
      role: null,
    },
    config: {
      provider: "openai",
      model: "gpt-5.2",
      enableMcp: true,
      workingDirectory,
      outputDirectory: path.join(workingDirectory, "output"),
      uploadsDirectory: path.join(workingDirectory, "uploads"),
    },
    context: {
      system: "System prompt",
      messages: [
        { role: "user", content },
        { role: "assistant", content: `answer to ${content}` },
      ] as PersistedSessionSnapshot["context"]["messages"],
      providerState: null,
      todos: [],
      harnessContext: null,
      costTracker: null,
    },
  };
}

async function writeSnapshot(snapshot: PersistedSessionSnapshot): Promise<void> {
  await writePersistedSessionSnapshot({ paths: { sessionsDir }, snapshot });
}

describe("readPastConversation", () => {
  test("lists only conversations from the active workspace", async () => {
    await writeSnapshot(makeSnapshot("sess-active", "/tmp/workspace", "active hello"));
    await writeSnapshot(makeSnapshot("sess-other", "/tmp/other-workspace", "secret hello"));

    const tool = createReadPastConversationTool(makeCtx(), {
      getPaths: () => ({ sessionsDir }),
      readSnapshot: readPersistedSessionSnapshot,
    });

    const out = (await tool.execute({ list: true })) as string;
    expect(out).toContain("sess-active");
    expect(out).not.toContain("sess-other");
  });

  test("does not read a transcript from another workspace by session id", async () => {
    await writeSnapshot(makeSnapshot("sess-active", "/tmp/workspace", "active hello"));
    await writeSnapshot(makeSnapshot("sess-other", "/tmp/other-workspace", "secret hello"));

    const tool = createReadPastConversationTool(makeCtx(), {
      getPaths: () => ({ sessionsDir }),
      readSnapshot: readPersistedSessionSnapshot,
    });

    const activeOut = (await tool.execute({ sessionId: "sess-active" })) as string;
    expect(activeOut).toContain("active hello");

    const otherOut = (await tool.execute({ sessionId: "sess-other" })) as string;
    expect(otherOut).toContain('No conversation found for sessionId "sess-other"');
    expect(otherOut).not.toContain("secret hello");
  });
});
