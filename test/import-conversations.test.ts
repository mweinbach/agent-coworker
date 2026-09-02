import { Database } from "bun:sqlite";
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  buildSafeHandoffText,
  buildSafeModelMessages,
  claudeCodeConversationAdapter,
  codexConversationAdapter,
  coworkConversationAdapter,
  createConversationImportService,
  type ExternalConversation,
  parseClaudeCodeJsonl,
  parseCodexRollout,
  persistImportedConversation,
} from "../src/import/conversations";
import { SessionDb } from "../src/server/sessionDb";
import { WebDesktopService } from "../src/server/webDesktopService";
import type { AgentConfig } from "../src/types";
import {
  createImportTestService,
  writeCoworkBackupDb,
  writeImportHistory,
} from "./helpers/conversationImport";

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
        {
          timestamp: "2026-01-01T00:00:05.000Z",
          type: "event_msg",
          payload: { type: "user_message", message: "hello" },
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
      "user",
    ]);
    const users = parsed.items.filter((item) => item.kind === "user");
    expect(users.map((item) => item.text)).toEqual(["hello", "hello"]);
    expect(new Set(users.map((item) => item.id)).size).toBe(2);
    expect(parsed.items.find((item) => item.kind === "tool")).toMatchObject({
      kind: "tool",
      name: "exec_command",
      result: "ok",
    });
    expect(parsed.warnings.some((warning) => warning.code === "reasoning_redacted")).toBe(true);
    expect(parsed.warnings.some((warning) => warning.code === "tool_protocol_redacted")).toBe(true);
  });

  test("discovers Codex state and resolves relative rollout paths under sessions", async () => {
    const home = await makeTempDir();
    const codexRoot = path.join(home, ".codex");
    const sessionsDir = path.join(codexRoot, "sessions");
    await fs.mkdir(sessionsDir, { recursive: true });
    const rollout = path.join(sessionsDir, "rollout.jsonl");
    await fs.writeFile(
      rollout,
      jsonl([
        {
          timestamp: "2026-01-01T00:00:00.000Z",
          type: "event_msg",
          payload: { type: "user_message", message: "import me" },
        },
        {
          timestamp: "2026-01-01T00:00:01.000Z",
          type: "response_item",
          payload: {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "imported" }],
          },
        },
      ]),
    );
    const statePath = path.join(codexRoot, "state_5.sqlite");
    const sqlite = new Database(statePath);
    try {
      sqlite.exec(
        "CREATE TABLE threads (id TEXT PRIMARY KEY, title TEXT, cwd TEXT, model TEXT, rollout_path TEXT, created_at INTEGER, updated_at INTEGER, archived INTEGER)",
      );
      sqlite
        .query(
          "INSERT INTO threads (id, title, cwd, model, rollout_path, created_at, updated_at, archived) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .run(
          "thread-1",
          "Relative rollout",
          home,
          "gpt-5.5",
          "rollout.jsonl",
          1767225600,
          1767225601,
          0,
        );
    } finally {
      sqlite.close();
    }

    const candidates = await codexConversationAdapter.discover({ homedir: home });
    const stateCandidate = candidates.find((candidate) => candidate.path === statePath);
    expect(stateCandidate).toMatchObject({ available: true, conversationCount: 1 });
    if (!stateCandidate) throw new Error("missing Codex state candidate");

    const conversations = await codexConversationAdapter.preview(stateCandidate, { limit: 10 });
    expect(conversations).toHaveLength(1);
    expect(conversations[0]).toMatchObject({
      source: "codex",
      sourceId: "thread-1",
      cwd: home,
      sourcePath: rollout,
      title: "Relative rollout",
    });
    expect(conversations[0]?.items.map((item) => item.kind)).toEqual(["user", "assistant"]);
  });

  test("discovers standalone Codex JSONL rollouts without importing Cowork auth caches", async () => {
    const home = await makeTempDir();
    const sessionsDir = path.join(home, ".codex", "sessions");
    await fs.mkdir(sessionsDir, { recursive: true });
    const rollout = path.join(sessionsDir, "standalone.jsonl");
    await fs.writeFile(
      rollout,
      jsonl([
        {
          timestamp: "2026-01-01T00:00:00.000Z",
          type: "event_msg",
          payload: { type: "user_message", message: "hello from file" },
        },
      ]),
    );
    const coworkAuth = path.join(home, ".cowork", "auth", "codex-cli", "sessions");
    await fs.mkdir(coworkAuth, { recursive: true });
    await fs.writeFile(path.join(coworkAuth, "ignored.jsonl"), jsonl([]));

    const candidates = await codexConversationAdapter.discover({ homedir: home });
    expect(candidates.some((candidate) => candidate.path.includes(".cowork"))).toBe(false);
    const sessionsCandidate = candidates.find((candidate) => candidate.path === sessionsDir);
    expect(sessionsCandidate).toMatchObject({ available: true, conversationCount: 1 });
    if (!sessionsCandidate) throw new Error("missing Codex sessions candidate");

    const conversations = await codexConversationAdapter.preview(sessionsCandidate, { limit: 10 });
    expect(conversations).toHaveLength(1);
    expect(conversations[0]?.items[0]).toMatchObject({ kind: "user", text: "hello from file" });
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
            content: [
              { type: "tool_result", tool_use_id: "toolu_secret", content: "ok" },
              { type: "text", text: "Keep the preview local." },
            ],
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
    expect(conversation.items.map((item) => item.kind)).toEqual([
      "user",
      "tool",
      "user",
      "assistant",
    ]);
    expect(
      conversation.items.filter((item) => item.kind === "user").map((item) => item.text),
    ).toEqual(["setup preview", "Keep the preview local."]);
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

  test("redacts non-summary Claude thinking content instead of importing it", async () => {
    const dir = await makeTempDir();
    const file = path.join(dir, "thinking.jsonl");
    await fs.writeFile(
      file,
      jsonl([
        {
          type: "user",
          timestamp: "2026-01-01T00:00:00.000Z",
          cwd: dir,
          sessionId: "claude-thinking",
          message: { role: "user", content: "question" },
        },
        {
          type: "assistant",
          timestamp: "2026-01-01T00:00:01.000Z",
          cwd: dir,
          sessionId: "claude-thinking",
          message: {
            role: "assistant",
            model: "claude-opus-4-7",
            content: [
              {
                type: "thinking",
                thinking: "hidden chain of thought must not import",
                signature: "signature-secret",
              },
              { type: "text", text: "answer" },
            ],
          },
        },
      ]),
    );

    const conversation = await parseClaudeCodeJsonl(file, dir);
    const handoff = buildSafeHandoffText(conversation);

    expect(conversation.items.map((item) => item.kind)).toEqual(["user", "assistant"]);
    expect(handoff).not.toContain("hidden chain of thought");
    expect(handoff).not.toContain("signature-secret");
    expect(conversation.warnings.some((warning) => warning.code === "reasoning_redacted")).toBe(
      true,
    );
  });

  test("imports explicit Claude thinking summaries as visible reasoning summaries", async () => {
    const dir = await makeTempDir();
    const file = path.join(dir, "summary.jsonl");
    await fs.writeFile(
      file,
      jsonl([
        {
          type: "assistant",
          timestamp: "2026-01-01T00:00:01.000Z",
          cwd: dir,
          sessionId: "claude-summary",
          message: {
            role: "assistant",
            model: "claude-opus-4-7",
            content: [{ type: "thinking", summary: "visible reasoning summary" }],
          },
        },
      ]),
    );

    const conversation = await parseClaudeCodeJsonl(file, dir);
    expect(conversation.items).toEqual([
      expect.objectContaining({
        kind: "reasoning",
        mode: "summary",
        text: "visible reasoning summary",
      }),
    ]);
  });

  test("discovers Claude Code project folders and decodes cwd fallback", async () => {
    const home = await makeTempDir();
    const projectPath = "/Users/alice/Projects/demo";
    const encodedProject = projectPath.replace(/\//g, "-");
    const projectDir = path.join(home, ".claude", "projects", encodedProject);
    await fs.mkdir(projectDir, { recursive: true });
    await fs.writeFile(
      path.join(projectDir, "session.jsonl"),
      jsonl([
        {
          type: "user",
          timestamp: "2026-01-01T00:00:00.000Z",
          sessionId: "claude-project",
          message: { role: "user", content: "hello" },
        },
      ]),
    );

    const candidates = await claudeCodeConversationAdapter.discover({ homedir: home });
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({ available: true, conversationCount: 1 });
    const conversations = await claudeCodeConversationAdapter.preview(candidates[0]!, {
      limit: 10,
    });
    expect(conversations[0]).toMatchObject({ cwd: projectPath, sourceId: "claude-project" });
  });

  test("uses Claude's project registry when folder encoding loses literal hyphens", async () => {
    const home = await makeTempDir();
    const projectPaths = ["/Users/alice/Projects/demo-app", "C:\\Users\\alice\\Projects\\demo-app"];
    await fs.writeFile(
      path.join(home, ".claude.json"),
      JSON.stringify({
        projects: Object.fromEntries(projectPaths.map((projectPath) => [projectPath, {}])),
      }),
    );

    for (const [index, projectPath] of projectPaths.entries()) {
      const encodedProject = projectPath.replace(/[:\\/]/g, "-");
      const projectDir = path.join(home, ".claude", "projects", encodedProject);
      await fs.mkdir(projectDir, { recursive: true });
      await fs.writeFile(
        path.join(projectDir, `session-${index}.jsonl`),
        jsonl([
          {
            type: "user",
            timestamp: `2026-01-01T00:00:0${index}.000Z`,
            sessionId: `claude-project-${index}`,
            message: { role: "user", content: "hello" },
          },
        ]),
      );
    }

    const [candidate] = await claudeCodeConversationAdapter.discover({ homedir: home });
    if (!candidate) throw new Error("missing Claude Code candidate");
    const conversations = await claudeCodeConversationAdapter.preview(candidate, { limit: 10 });
    expect(conversations).toHaveLength(2);
    for (const [index, projectPath] of projectPaths.entries()) {
      expect(
        conversations.find((conversation) => conversation.sourceId === `claude-project-${index}`),
      ).toMatchObject({
        cwd: projectPath,
      });
    }
  });

  test("does not guess a cwd when Claude project folder encodings collide", async () => {
    const home = await makeTempDir();
    const encodedProject = "-Users-alice-Projects-demo-app";
    await fs.writeFile(
      path.join(home, ".claude.json"),
      JSON.stringify({
        projects: {
          "/Users/alice/Projects/demo-app": {},
          "/Users/alice/Projects/demo/app": {},
        },
      }),
    );
    const projectDir = path.join(home, ".claude", "projects", encodedProject);
    await fs.mkdir(projectDir, { recursive: true });
    await fs.writeFile(
      path.join(projectDir, "session.jsonl"),
      jsonl([
        {
          type: "user",
          timestamp: "2026-01-01T00:00:00.000Z",
          sessionId: "claude-ambiguous-project",
          message: { role: "user", content: "hello" },
        },
      ]),
    );

    const [candidate] = await claudeCodeConversationAdapter.discover({ homedir: home });
    if (!candidate) throw new Error("missing Claude Code candidate");
    const [conversation] = await claudeCodeConversationAdapter.preview(candidate, { limit: 10 });
    expect(conversation?.cwd).toBeNull();
    expect(conversation?.warnings).toContainEqual(expect.objectContaining({ code: "missing_cwd" }));
  });

  test("discovers Cowork backup directories and rejects the current sessions database", async () => {
    const dir = await makeTempDir();
    const workspace = path.join(dir, "workspace");
    const backupRoot = path.join(dir, "backup", ".cowork");
    await fs.mkdir(workspace, { recursive: true });
    const dbPath = await writeCoworkBackupDb(backupRoot, [
      { sessionId: "cowork-root", title: "Backup root", cwd: workspace },
      {
        sessionId: "cowork-agent",
        title: "Nested agent",
        cwd: workspace,
        sessionKind: "agent",
      },
    ]);

    const candidates = await coworkConversationAdapter.discover({
      homedir: dir,
      explicitPaths: [backupRoot],
    });
    expect(candidates).toEqual([
      expect.objectContaining({
        source: "cowork",
        id: `cowork:${dbPath}`,
        path: dbPath,
        available: true,
        conversationCount: 1,
      }),
    ]);

    const selfCandidates = await coworkConversationAdapter.discover({
      homedir: dir,
      explicitPaths: [backupRoot],
      currentCoworkDbPath: dbPath,
    });
    expect(selfCandidates).toEqual([
      expect.objectContaining({
        source: "cowork",
        path: dbPath,
        available: false,
        warning: "The current Cowork sessions database cannot be imported into itself.",
      }),
    ]);
  });

  test("previews Cowork session snapshots as external conversation items", async () => {
    const dir = await makeTempDir();
    const workspace = path.join(dir, "workspace");
    const backupRoot = path.join(dir, "backup", ".cowork");
    await fs.mkdir(workspace, { recursive: true });
    const dbPath = await writeCoworkBackupDb(backupRoot, [
      {
        sessionId: "cowork-snapshot",
        title: "Snapshot session",
        cwd: workspace,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:05.000Z",
        feed: [
          {
            id: "user-1",
            kind: "message",
            role: "user",
            ts: "2026-01-01T00:00:00.000Z",
            text: "Run the deploy check.",
          },
          {
            id: "tool-1",
            kind: "tool",
            ts: "2026-01-01T00:00:01.000Z",
            name: "bash",
            state: "output-error",
            args: { command: "deploy" },
            result: { text: "permission denied" },
          },
          {
            id: "reasoning-1",
            kind: "reasoning",
            mode: "summary",
            ts: "2026-01-01T00:00:02.000Z",
            text: "The deploy command needs credentials.",
          },
          {
            id: "system-1",
            kind: "system",
            ts: "2026-01-01T00:00:03.000Z",
            line: "Model switched.",
          },
          {
            id: "log-1",
            kind: "log",
            ts: "2026-01-01T00:00:04.000Z",
            line: "Command exited.",
          },
          {
            id: "assistant-1",
            kind: "message",
            role: "assistant",
            ts: "2026-01-01T00:00:05.000Z",
            text: "Credentials are missing.",
          },
        ],
      },
    ]);

    const conversations = await coworkConversationAdapter.preview(
      {
        source: "cowork",
        id: `cowork:${dbPath}`,
        path: dbPath,
        available: true,
      },
      { limit: 10 },
    );

    expect(conversations).toHaveLength(1);
    expect(conversations[0]).toEqual(
      expect.objectContaining({
        source: "cowork",
        sourceId: "cowork-snapshot",
        sourcePath: dbPath,
        cwd: workspace,
        title: "Snapshot session",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:05.000Z",
        originalProvider: "google",
        originalModel: "gemini-3-flash-preview",
        warnings: [],
      }),
    );
    expect(conversations[0]?.items.map((item) => item.kind)).toEqual([
      "user",
      "tool",
      "reasoning",
      "system",
      "system",
      "assistant",
    ]);
    expect(conversations[0]?.items[1]).toEqual(
      expect.objectContaining({
        kind: "tool",
        name: "bash",
        args: { command: "deploy" },
        error: "permission denied",
      }),
    );
    expect(conversations[0]?.items[2]).toEqual(
      expect.objectContaining({
        kind: "reasoning",
        mode: "summary",
        text: "The deploy command needs credentials.",
      }),
    );
  });

  test("falls back to Cowork messages_json when snapshots are absent", async () => {
    const dir = await makeTempDir();
    const backupRoot = path.join(dir, "backup", ".cowork");
    const dbPath = await writeCoworkBackupDb(backupRoot, [
      {
        sessionId: "cowork-messages",
        title: "Messages only",
        cwd: "",
        updatedAt: "2026-01-01T00:00:02.000Z",
        messages: [
          { role: "user", content: "fallback user" },
          {
            role: "assistant",
            content: [{ type: "text", text: "fallback assistant" }],
          },
        ],
      },
    ]);

    const conversations = await coworkConversationAdapter.preview(
      {
        source: "cowork",
        id: `cowork:${dbPath}`,
        path: dbPath,
        available: true,
      },
      { limit: 10 },
    );

    expect(conversations).toHaveLength(1);
    expect(conversations[0]).toEqual(
      expect.objectContaining({
        source: "cowork",
        sourceId: "cowork-messages",
        cwd: null,
        title: "Messages only",
        warnings: [
          {
            code: "missing_cwd",
            message: "Cowork session did not include a working directory.",
          },
        ],
      }),
    );
    expect(conversations[0]?.items).toEqual([
      expect.objectContaining({
        kind: "user",
        ts: "2026-01-01T00:00:02.000Z",
        text: "fallback user",
      }),
      expect.objectContaining({
        kind: "assistant",
        ts: "2026-01-01T00:00:02.000Z",
        text: "fallback assistant",
      }),
    ]);

    await expect(
      coworkConversationAdapter.preview(
        {
          source: "cowork",
          id: `cowork:${dbPath}`,
          path: dbPath,
          available: true,
        },
        { currentCoworkDbPath: dbPath, limit: 10 },
      ),
    ).resolves.toEqual([]);
  });

  test("safe handoff creates only plain model messages", () => {
    const messages = buildSafeModelMessages(conversationFixture("/tmp/workspace"));
    expect(messages).toEqual([expect.objectContaining({ role: "user" })]);
    expect(JSON.stringify(messages)).not.toContain('"role":"tool"');
    expect(JSON.stringify(messages)).not.toContain("call_should_not_leak");
  });
});

describe("conversation import persistence", () => {
  test.each([
    "sessions",
    "session_state",
    "session_events",
    "session_snapshots",
    "external_conversation_imports",
  ])("rolls back an import after the %s write fails", async (table) => {
    const dir = await makeTempDir();
    const { db, workspace } = await createImportTestService(dir);
    const inspectDb = new Database(db.dbPath, { readwrite: true, create: false });
    const input = {
      sessionDb: db,
      importInput: {
        conversation: conversationFixture(workspace),
        workspacePath: workspace,
        provider: "openai" as const,
        model: "gpt-5.5",
        enableMcp: true,
      },
    };
    try {
      inspectDb.exec(
        `CREATE TRIGGER reject_import AFTER INSERT ON ${table} BEGIN SELECT RAISE(FAIL, 'injected import failure'); END`,
      );
      await expect(persistImportedConversation(input)).rejects.toThrow("injected import failure");
      for (const ownedTable of [
        "sessions",
        "session_state",
        "session_events",
        "session_snapshots",
        "external_conversation_imports",
      ]) {
        expect(inspectDb.query(`SELECT count(*) AS count FROM ${ownedTable}`).get()).toEqual({
          count: 0,
        });
      }

      inspectDb.exec("DROP TRIGGER reject_import");
      const retried = await persistImportedConversation(input);
      expect(db.getSessionRecord(retried.threadId)?.lastEventSeq).toBe(1);
      expect(db.getSessionSnapshot(retried.threadId)?.lastEventSeq).toBe(1);
      expect(db.listExternalConversationImports()).toHaveLength(1);
    } finally {
      inspectDb.close();
      db.close();
    }
  });

  test("concurrent imports share one transaction and one original event", async () => {
    const dir = await makeTempDir();
    const { db, workspace } = await createImportTestService(dir);
    const otherDb = await SessionDb.create({
      paths: {
        rootDir: path.dirname(db.dbPath),
        sessionsDir: path.join(dir, ".cowork", "sessions"),
      },
      dbPath: db.dbPath,
    });
    const importInput = {
      conversation: conversationFixture(workspace),
      workspacePath: workspace,
      provider: "openai" as const,
      model: "gpt-5.5",
      enableMcp: true,
    };
    try {
      const results = await Promise.all(
        [db, otherDb, db, otherDb].map((sessionDb) =>
          persistImportedConversation({ sessionDb, importInput }),
        ),
      );
      expect(results.every((result) => result.threadId === results[0]!.threadId)).toBe(true);
      expect(db.listSessions()).toHaveLength(1);
      expect(db.getSessionRecord(results[0]!.threadId)?.lastEventSeq).toBe(1);
      expect(db.getSessionSnapshot(results[0]!.threadId)?.lastEventSeq).toBe(1);
      expect(db.listExternalConversationImports()).toHaveLength(1);
    } finally {
      otherDb.close();
      db.close();
    }
  });

  test.each([false, true])(
    "preserves a continued import on retry (legacy missing ledger: %s)",
    async (missingLedger) => {
      const dir = await makeTempDir();
      const { db, workspace } = await createImportTestService(dir);
      const inspectDb = new Database(db.dbPath, { readwrite: true, create: false });
      const input = {
        sessionDb: db,
        importInput: {
          conversation: conversationFixture(workspace),
          workspacePath: workspace,
          provider: "openai" as const,
          model: "gpt-5.5",
          enableMcp: true,
        },
      };
      try {
        const first = await persistImportedConversation(input);
        const original = db.getSessionRecord(first.threadId)!;
        const originalSnapshot = db.getSessionSnapshot(first.threadId)!;
        const continuedText = "Continue from my edits, not the imported source.";
        const lastEventSeq = await db.persistSessionMutation({
          sessionId: first.threadId,
          eventType: "user_message",
          snapshot: {
            ...original,
            title: "Continued conversation",
            messages: [...original.messages, { role: "user", content: continuedText }],
          },
        });
        await db.persistSessionSnapshot(first.threadId, {
          ...originalSnapshot,
          lastEventSeq,
          title: "Continued conversation",
          feed: [
            ...originalSnapshot.feed,
            {
              id: "continued-user-message",
              kind: "message",
              role: "user",
              ts: "2026-01-01T00:02:00.000Z",
              text: continuedText,
            },
          ],
        });
        if (missingLedger) inspectDb.exec("DELETE FROM external_conversation_imports");
        const continued = db.getSessionRecord(first.threadId);
        const continuedSnapshot = db.getSessionSnapshot(first.threadId);
        if (missingLedger) {
          await expect(persistImportedConversation(input)).rejects.toThrow(
            "existing conversation has been preserved",
          );
        } else {
          const retried = await persistImportedConversation(input);
          expect(retried.modelMessages).toEqual(continued?.messages);
          expect(retried.snapshotFeed).toEqual(continuedSnapshot?.feed);
        }
        expect(db.getSessionRecord(first.threadId)).toEqual(continued);
        expect(db.getSessionSnapshot(first.threadId)).toEqual(continuedSnapshot);
      } finally {
        inspectDb.close();
        db.close();
      }
    },
  );

  test.each(["missing", "file"] as const)(
    "rejects a %s create target before workspace or session writes",
    async (kind) => {
      const dir = await makeTempDir();
      const desktopService = new WebDesktopService({
        userDataDir: path.join(dir, "desktop"),
        homedir: dir,
      });
      const { db, service, workspace } = await createImportTestService(dir, { desktopService });
      const destination = path.join(dir, "invalid-workspace");
      if (kind === "file") await fs.writeFile(destination, "Keep this file.");
      const source = await writeImportHistory(path.join(dir, "backup"), workspace, "cowork", 1);
      const preview = await service.preview({ sources: [source] });
      const mapping = { kind: "create" as const, path: destination };
      const save = spyOn(desktopService, "saveState");
      try {
        const imported = await service.importSelected({
          sources: [source],
          selected: preview.conversations,
          mappings: { [preview.conversations[0]!.fingerprint]: mapping },
        });
        expect(imported.imported).toEqual([]);
        expect(imported.failed).toHaveLength(1);
        expect(imported.failed[0]?.message).toContain("existing directory");
        expect(imported.createdWorkspaces).toEqual([]);
        expect(save).not.toHaveBeenCalled();
        expect(db.listSessions()).toEqual([]);
        expect(db.listExternalConversationImports()).toEqual([]);
        const validation = await service.validateWorkspaceMappings({ mappings: { test: mapping } });
        expect(validation.valid).toBe(false);
        if (kind === "file") expect(await fs.readFile(destination, "utf8")).toBe("Keep this file.");
        else expect(await fs.exists(destination)).toBe(false);
      } finally {
        save.mockRestore();
        await desktopService.stopAll();
        db.close();
      }
    },
  );

  test("imports the same explicit source paths and inclusion flags used by preview", async () => {
    const dir = await makeTempDir();
    const { db, service, workspace } = await createImportTestService(dir);
    try {
      const source = await writeImportHistory(path.join(dir, "backup"), workspace, "cowork", 1);
      const selection = {
        includeCodex: false,
        includeClaudeCode: false,
        includeCowork: true,
        explicitPaths: [source.path!],
      };
      const preview = await service.preview(selection);
      expect(preview.conversations).toHaveLength(1);
      const result = await service.importSelected({
        ...selection,
        selected: preview.conversations,
      });
      expect(result.failed).toEqual([]);
      expect(result.imported).toHaveLength(1);
      expect(result.imported[0]?.source).toBe("cowork");
    } finally {
      db.close();
    }
  });

  test.each(["codex-files", "codex-db", "claude-code", "cowork"] as const)(
    "%s applies the preview limit after prioritizing chats that are not imported",
    async (format) => {
      const dir = await makeTempDir();
      const { db, service, workspace } = await createImportTestService(dir);
      try {
        const source = await writeImportHistory(path.join(dir, "backup"), workspace, format, 3);
        const all = await service.preview({ sources: [source], limit: 3 });
        const newest = all.conversations.slice(0, 2);
        const mappings = Object.fromEntries(
          newest.map((conversation) => [
            conversation.fingerprint,
            { kind: "create" as const, path: workspace },
          ]),
        );
        const imported = await service.importSelected({
          sources: [source],
          selected: newest,
          mappings,
        });
        expect(imported.imported).toHaveLength(2);

        const next = await service.preview({ sources: [source], limit: 2 });
        expect(next.conversations).toHaveLength(2);
        expect(next.conversations[0]).toMatchObject({
          title: "Message 0",
          alreadyImportedThreadId: null,
        });
        expect(next.conversations[1]?.alreadyImportedThreadId).not.toBeNull();
      } finally {
        db.close();
      }
    },
  );

  test("imports a selected conversation beyond the default 250-row preview window", async () => {
    const dir = await makeTempDir();
    const { db, service, workspace } = await createImportTestService(dir);
    try {
      const source = await writeImportHistory(path.join(dir, "backup"), workspace, "codex-db", 251);
      const preview = await service.preview({ sources: [source], limit: 1000 });
      expect(preview.conversations).toHaveLength(251);
      const oldest = preview.conversations.at(-1)!;
      expect(oldest.title).toBe("Message 0");
      const result = await service.importSelected({ sources: [source], selected: [oldest] });
      expect(result.failed).toEqual([]);
      expect(result.imported).toHaveLength(1);
      expect(result.imported[0]?.title).toBe("Message 0");
    } finally {
      db.close();
    }
  });

  test("shares the requested preview limit across selected sources", async () => {
    const dir = await makeTempDir();
    const { db, service, workspace } = await createImportTestService(dir);
    try {
      const sources = await Promise.all([
        writeImportHistory(path.join(dir, "codex"), workspace, "codex-db", 3),
        writeImportHistory(path.join(dir, "claude"), workspace, "claude-code", 3),
      ]);
      const preview = await service.preview({ sources, limit: 2 });
      expect(preview.conversations).toHaveLength(2);
      expect(preview.conversations.map((conversation) => conversation.title)).toEqual([
        "Message 2",
        "Message 2",
      ]);
    } finally {
      db.close();
    }
  });

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
      expect(db.listExternalConversationImports({ source: "claude-code" })).toHaveLength(1);
    } finally {
      db.close();
    }
  });

  test("validates workspace mapping inputs before import", async () => {
    const dir = await makeTempDir();
    const rootDir = path.join(dir, ".cowork");
    const sessionsDir = path.join(rootDir, "sessions");
    const workspace = path.join(dir, "workspace");
    await fs.mkdir(sessionsDir, { recursive: true });
    await fs.mkdir(workspace);
    const db = await SessionDb.create({
      paths: { rootDir, sessionsDir },
      dbPath: path.join(rootDir, "sessions.db"),
    });
    const config = {
      provider: "openai",
      model: "gpt-5.5",
      preferredChildModel: "gpt-5.5",
      workingDirectory: workspace,
      userName: "Tester",
      knowledgeCutoff: "Unknown",
      projectCoworkDir: rootDir,
      userCoworkDir: rootDir,
      builtInDir: dir,
      builtInConfigDir: dir,
      skillsDirs: [],
      memoryDirs: [],
      configDirs: [],
    } as AgentConfig;
    try {
      const service = createConversationImportService({
        sessionDb: db,
        homedir: dir,
        getConfig: () => config,
      });
      const realWorkspace = await fs.realpath(workspace);
      const valid = await service.validateWorkspaceMappings({
        mappings: { fingerprint: { kind: "create", path: workspace, name: "Workspace" } },
      });
      expect(valid.valid).toBe(true);
      expect(valid.mappings.fingerprint).toMatchObject({
        status: "create",
        workspacePath: realWorkspace,
        name: "Workspace",
      });

      const missing = await service.validateWorkspaceMappings({
        mappings: { fingerprint: { kind: "create", path: path.join(dir, "missing") } },
      });
      expect(missing.valid).toBe(false);
      expect(missing.errors[0]).toMatchObject({
        fingerprint: "fingerprint",
        message: "Workspace path must be an existing directory.",
      });
    } finally {
      db.close();
    }
  });
});
