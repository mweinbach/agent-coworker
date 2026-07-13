import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
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
import { type PersistedSessionMutation, SessionDb } from "../src/server/sessionDb";
import type { SessionSnapshot } from "../src/shared/sessionSnapshot";
import type { AgentConfig } from "../src/types";

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

type CoworkBackupSessionFixture = {
  sessionId: string;
  title: string;
  cwd: string;
  sessionKind?: SessionSnapshot["sessionKind"];
  createdAt?: string;
  updatedAt?: string;
  provider?: AgentConfig["provider"];
  model?: string;
  feed?: SessionSnapshot["feed"];
  messages?: PersistedSessionMutation["snapshot"]["messages"];
};

function countSnapshotMessages(feed: SessionSnapshot["feed"]): number {
  return feed.filter((item) => item.kind === "message").length;
}

function makeCoworkBackupSnapshot(session: CoworkBackupSessionFixture): SessionSnapshot {
  const createdAt = session.createdAt ?? "2026-01-01T00:00:00.000Z";
  const updatedAt = session.updatedAt ?? "2026-01-01T00:00:01.000Z";
  const feed = session.feed ?? [];
  return {
    sessionId: session.sessionId,
    title: session.title,
    titleSource: "default",
    titleModel: null,
    provider: session.provider ?? "google",
    model: session.model ?? "gemini-3-flash-preview",
    sessionKind: session.sessionKind ?? "root",
    parentSessionId: null,
    role: null,
    mode: null,
    depth: null,
    nickname: null,
    taskType: null,
    targetPaths: null,
    profile: null,
    requestedModel: null,
    effectiveModel: null,
    requestedReasoningEffort: null,
    effectiveReasoningEffort: null,
    executionState: null,
    lastMessagePreview: null,
    createdAt,
    updatedAt,
    messageCount: countSnapshotMessages(feed),
    lastEventSeq: feed.length,
    feed,
    agents: [],
    todos: [],
    sessionUsage: null,
    lastTurnUsage: null,
    hasPendingAsk: false,
    hasPendingApproval: false,
  };
}

function makeCoworkBackupMutation(session: CoworkBackupSessionFixture): PersistedSessionMutation {
  const snapshot = makeCoworkBackupSnapshot(session);
  return {
    sessionId: session.sessionId,
    eventType: "session.created",
    eventTs: snapshot.updatedAt,
    snapshot: {
      sessionKind: snapshot.sessionKind,
      parentSessionId: snapshot.parentSessionId,
      role: snapshot.role,
      title: snapshot.title,
      titleSource: snapshot.titleSource,
      titleModel: snapshot.titleModel,
      provider: snapshot.provider,
      model: snapshot.model,
      workingDirectory: session.cwd,
      enableMcp: true,
      backupsEnabledOverride: null,
      createdAt: snapshot.createdAt,
      updatedAt: snapshot.updatedAt,
      status: "active",
      hasPendingAsk: false,
      hasPendingApproval: false,
      systemPrompt: "system",
      messages: session.messages ?? [],
      providerState: null,
      todos: [],
      harnessContext: null,
      costTracker: null,
    },
  };
}

async function writeCoworkBackupDb(
  rootDir: string,
  sessions: CoworkBackupSessionFixture[],
): Promise<string> {
  const sessionsDir = path.join(rootDir, "sessions");
  const dbPath = path.join(rootDir, "sessions.db");
  await fs.mkdir(sessionsDir, { recursive: true });
  const db = await SessionDb.create({
    paths: { rootDir, sessionsDir },
    dbPath,
  });
  try {
    for (const session of sessions) {
      await db.persistSessionMutation(makeCoworkBackupMutation(session));
      if (session.feed) {
        await db.persistSessionSnapshot(session.sessionId, makeCoworkBackupSnapshot(session));
      }
    }
  } finally {
    db.close();
  }
  return dbPath;
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
        message: "Workspace path does not exist.",
      });
    } finally {
      db.close();
    }
  });
});
