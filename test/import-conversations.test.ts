import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  buildSafeHandoffText,
  type ExternalConversation,
  parseClaudeCodeJsonl,
  parseCodexRollout,
  persistImportedConversation,
} from "../src/import/conversations";
import { SessionDb } from "../src/server/sessionDb";

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-import-test-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) await fs.rm(dir, { recursive: true, force: true });
  }
});

function jsonl(records: unknown[]): string {
  return `${records.map((record) => JSON.stringify(record)).join("\n")}\n`;
}

function conversationFixture(cwd: string): ExternalConversation {
  return {
    source: "claude-code",
    sourceId: "session-1",
    sourcePath: "/tmp/session.jsonl",
    fingerprint: "fixture-fingerprint",
    cwd,
    title: "Imported fixture",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:01:00.000Z",
    originalProvider: "anthropic",
    originalModel: "claude-opus-4-7",
    summary: "The assistant inspected files and explained the result.",
    warnings: [],
    items: [
      {
        kind: "user",
        id: "u1",
        ts: "2026-01-01T00:00:00.000Z",
        text: "Please inspect the project.",
      },
      {
        kind: "tool",
        id: "t1",
        ts: "2026-01-01T00:00:10.000Z",
        name: "Read",
        args: { file_path: "package.json", call_id: "call_should_not_leak" },
        result: "package contents",
      },
      {
        kind: "assistant",
        id: "a1",
        ts: "2026-01-01T00:01:00.000Z",
        text: "The project uses Bun.",
      },
    ],
  };
}

describe("conversation import parsers", () => {
  test("parses Codex rollout with visible summaries and redacted protocol state", async () => {
    const dir = await makeTempDir();
    const rollout = path.join(dir, "rollout.jsonl");
    await fs.writeFile(
      rollout,
      jsonl([
        {
          timestamp: "2026-01-01T00:00:00.000Z",
          type: "event_msg",
          payload: { type: "user_message", message: "hello" },
        },
        {
          timestamp: "2026-01-01T00:00:01.000Z",
          type: "response_item",
          payload: {
            type: "reasoning",
            summary: [{ type: "summary_text", text: "Visible summary" }],
            encrypted_content: "gAAAAA-secret",
          },
        },
        {
          timestamp: "2026-01-01T00:00:02.000Z",
          type: "response_item",
          payload: {
            type: "function_call",
            call_id: "call_abc123",
            name: "exec_command",
            arguments: JSON.stringify({ cmd: "ls" }),
          },
        },
        {
          timestamp: "2026-01-01T00:00:03.000Z",
          type: "response_item",
          payload: {
            type: "function_call_output",
            call_id: "call_abc123",
            output: "ok",
          },
        },
        {
          timestamp: "2026-01-01T00:00:04.000Z",
          type: "response_item",
          payload: {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "done" }],
          },
        },
      ]),
    );

    const parsed = await parseCodexRollout({
      rolloutPath: rollout,
      sourceId: "codex-session",
      fallbackCreatedAt: "2026-01-01T00:00:00.000Z",
      fallbackUpdatedAt: "2026-01-01T00:00:04.000Z",
    });

    expect(parsed.items.map((item) => item.kind)).toEqual([
      "user",
      "reasoning",
      "tool",
      "assistant",
    ]);
    expect(parsed.items.find((item) => item.kind === "tool")).toMatchObject({
      kind: "tool",
      name: "exec_command",
      result: "ok",
    });
    expect(parsed.warnings.some((warning) => warning.code === "reasoning_redacted")).toBe(true);
    expect(parsed.warnings.some((warning) => warning.code === "tool_protocol_redacted")).toBe(true);
  });

  test("parses Claude Code JSONL and omits thinking signatures from handoff", async () => {
    const dir = await makeTempDir();
    const file = path.join(dir, "session.jsonl");
    await fs.writeFile(
      file,
      jsonl([
        { type: "ai-title", aiTitle: "Set up preview", sessionId: "claude-session" },
        {
          type: "user",
          timestamp: "2026-01-01T00:00:00.000Z",
          cwd: dir,
          sessionId: "claude-session",
          message: { role: "user", content: "setup preview" },
        },
        {
          type: "assistant",
          timestamp: "2026-01-01T00:00:01.000Z",
          cwd: dir,
          sessionId: "claude-session",
          message: {
            role: "assistant",
            model: "claude-opus-4-7",
            content: [{ type: "thinking", thinking: "", signature: "signature-secret" }],
          },
        },
        {
          type: "assistant",
          timestamp: "2026-01-01T00:00:02.000Z",
          cwd: dir,
          sessionId: "claude-session",
          message: {
            role: "assistant",
            model: "claude-opus-4-7",
            content: [
              { type: "tool_use", id: "toolu_secret", name: "Bash", input: { command: "ls" } },
            ],
          },
        },
        {
          type: "user",
          timestamp: "2026-01-01T00:00:03.000Z",
          cwd: dir,
          sessionId: "claude-session",
          toolUseResult: { stdout: "ok" },
          message: {
            role: "user",
            content: [{ type: "tool_result", tool_use_id: "toolu_secret", content: "ok" }],
          },
        },
        {
          type: "assistant",
          timestamp: "2026-01-01T00:00:04.000Z",
          cwd: dir,
          sessionId: "claude-session",
          message: {
            role: "assistant",
            model: "claude-opus-4-7",
            content: [{ type: "text", text: "Preview is ready." }],
          },
        },
      ]),
    );

    const conversation = await parseClaudeCodeJsonl(file, dir);
    const handoff = buildSafeHandoffText(conversation);

    expect(conversation.title).toBe("Set up preview");
    expect(conversation.originalModel).toBe("claude-opus-4-7");
    expect(conversation.items.map((item) => item.kind)).toEqual(["user", "tool", "assistant"]);
    expect(conversation.items.find((item) => item.kind === "tool")).toMatchObject({
      kind: "tool",
      name: "Bash",
      result: { stdout: "ok" },
    });
    expect(conversation.warnings.some((warning) => warning.code === "reasoning_redacted")).toBe(
      true,
    );
    expect(handoff).not.toContain("signature-secret");
    expect(handoff).not.toContain("toolu_secret");
  });
});

describe("conversation import persistence", () => {
  test("persists imported sessions with snapshots, dedupe metadata, and null provider state", async () => {
    const dir = await makeTempDir();
    const rootDir = path.join(dir, ".cowork");
    const sessionsDir = path.join(rootDir, "sessions");
    await fs.mkdir(sessionsDir, { recursive: true });
    const db = await SessionDb.create({
      paths: { rootDir, sessionsDir },
      dbPath: path.join(rootDir, "sessions.db"),
    });
    try {
      const workspace = path.join(dir, "workspace");
      await fs.mkdir(workspace);
      const conversation = conversationFixture(workspace);

      const first = await persistImportedConversation({
        sessionDb: db,
        importInput: {
          conversation,
          workspacePath: workspace,
          provider: "openai",
          model: "gpt-5.5",
          enableMcp: true,
        },
      });
      const second = await persistImportedConversation({
        sessionDb: db,
        importInput: {
          conversation,
          workspacePath: workspace,
          provider: "openai",
          model: "gpt-5.5",
          enableMcp: true,
        },
      });

      expect(second.threadId).toBe(first.threadId);
      const record = db.getSessionRecord(first.threadId);
      expect(record?.providerState).toBeNull();
      expect(record?.messages).toHaveLength(1);
      expect(JSON.stringify(record?.messages)).not.toContain("call_should_not_leak");
      const snapshot = db.getSessionSnapshot(first.threadId);
      expect(snapshot?.feed.some((item) => item.kind === "system")).toBe(true);
      expect(snapshot?.feed.some((item) => item.kind === "tool")).toBe(true);
      const importRecord = db.getExternalConversationImport(
        "claude-code",
        conversation.fingerprint,
      );
      expect(importRecord?.importedSessionId).toBe(first.threadId);
    } finally {
      db.close();
    }
  });
});
