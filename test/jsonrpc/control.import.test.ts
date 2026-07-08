import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import path from "node:path";
import { type PersistedSessionMutation, SessionDb } from "../../src/server/sessionDb";
import { startAgentServer } from "../../src/server/startServer";
import { makeTmpProject, serverOpts, stopTestServer } from "../helpers/wsHarness";
import { connectJsonRpc } from "./control.harness";

const IMPORT_RPC_TIMEOUT_MS = 15_000;

async function writeCodexPlugin(home: string, name: string): Promise<void> {
  const root = path.join(home, ".codex", "plugins", "cache", "mkt", name, "1.0.0");
  await fs.mkdir(path.join(root, ".codex-plugin"), { recursive: true });
  await fs.mkdir(path.join(root, "skills", `${name}-skill`), { recursive: true });
  await fs.writeFile(
    path.join(root, ".codex-plugin", "plugin.json"),
    `${JSON.stringify(
      { name, version: "1.0.0", description: `${name} plugin`, skills: "./skills/" },
      null,
      2,
    )}\n`,
  );
  await fs.writeFile(
    path.join(root, "skills", `${name}-skill`, "SKILL.md"),
    ["---", `name: ${name}-skill`, `description: ${name} skill`, "---", "", "Body"].join("\n"),
  );
}

async function writeCodexSkill(home: string, name: string): Promise<void> {
  const dir = path.join(home, ".codex", "skills", name);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    path.join(dir, "SKILL.md"),
    ["---", `name: ${name}`, `description: ${name} description`, "---", "", "Body"].join("\n"),
  );
}

async function writeCodexConversation(home: string, cwd: string): Promise<string> {
  const codexRoot = path.join(home, ".codex");
  const sessionsDir = path.join(codexRoot, "sessions");
  await fs.mkdir(sessionsDir, { recursive: true });
  await fs.writeFile(
    path.join(sessionsDir, "conversation.jsonl"),
    `${[
      {
        timestamp: "2026-01-01T00:00:00.000Z",
        type: "event_msg",
        payload: { type: "user_message", message: "import this Codex chat" },
      },
      {
        timestamp: "2026-01-01T00:00:01.000Z",
        type: "response_item",
        payload: {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "imported from Codex" }],
        },
      },
    ]
      .map((record) => JSON.stringify(record))
      .join("\n")}\n`,
  );
  const statePath = path.join(codexRoot, "state_5.sqlite");
  const db = new Database(statePath);
  try {
    db.exec(
      "CREATE TABLE threads (id TEXT PRIMARY KEY, title TEXT, cwd TEXT, model TEXT, rollout_path TEXT, created_at INTEGER, updated_at INTEGER, archived INTEGER)",
    );
    db.query(
      "INSERT INTO threads (id, title, cwd, model, rollout_path, created_at, updated_at, archived) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(
      "codex-thread-1",
      "Codex import fixture",
      cwd,
      "gpt-5.5",
      "conversation.jsonl",
      1767225600,
      1767225601,
      0,
    );
  } finally {
    db.close();
  }
  return statePath;
}

function makeCoworkConversationMutation(input: {
  sessionId: string;
  title: string;
  cwd: string;
}): PersistedSessionMutation {
  return {
    sessionId: input.sessionId,
    eventType: "session.created",
    eventTs: "2026-01-01T00:00:01.000Z",
    snapshot: {
      sessionKind: "root",
      parentSessionId: null,
      role: null,
      title: input.title,
      titleSource: "default",
      titleModel: null,
      provider: "google",
      model: "gemini-3-flash-preview",
      workingDirectory: input.cwd,
      enableMcp: true,
      backupsEnabledOverride: null,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:01.000Z",
      status: "active",
      hasPendingAsk: false,
      hasPendingApproval: false,
      systemPrompt: "system",
      messages: [
        { role: "user", content: "import this Cowork backup chat" },
        { role: "assistant", content: "imported from Cowork backup" },
      ],
      providerState: null,
      todos: [],
      harnessContext: null,
      costTracker: null,
    },
  };
}

async function writeCoworkConversationBackup(
  home: string,
  cwd: string,
): Promise<{
  rootDir: string;
  dbPath: string;
}> {
  const rootDir = path.join(home, "cowork-backup", ".cowork");
  const sessionsDir = path.join(rootDir, "sessions");
  const dbPath = path.join(rootDir, "sessions.db");
  await fs.mkdir(sessionsDir, { recursive: true });
  const db = await SessionDb.create({ paths: { rootDir, sessionsDir }, dbPath });
  try {
    await db.persistSessionMutation(
      makeCoworkConversationMutation({
        sessionId: "cowork-backup-thread-1",
        title: "Cowork backup import fixture",
        cwd,
      }),
    );
  } finally {
    db.close();
  }
  return { rootDir, dbPath };
}

describe("server JSON-RPC import methods", () => {
  test("lists, imports a codex plugin, and imports a codex skill", async () => {
    const tmpDir = await makeTmpProject("agent-harness-import-");
    const fakeHome = await makeTmpProject("agent-harness-import-home-");
    await writeCodexPlugin(fakeHome, "delta");
    await writeCodexSkill(fakeHome, "echo-skill");

    const { server, url } = await startAgentServer(serverOpts(tmpDir, { homedir: fakeHome }));
    try {
      const rpc = await connectJsonRpc(url);

      const listPlugins = await rpc.request(
        "cowork/import/list",
        {
          cwd: tmpDir,
          source: "codex",
          kind: "plugin",
        },
        IMPORT_RPC_TIMEOUT_MS,
      );
      expect(listPlugins.result.event).toEqual(
        expect.objectContaining({
          type: "import_list",
          source: "codex",
          kind: "plugin",
          homeExists: true,
          items: expect.arrayContaining([
            expect.objectContaining({ id: "delta", conversionRequired: false, diagnostics: [] }),
          ]),
        }),
      );

      const deltaItem = listPlugins.result.event.items.find((i: any) => i.id === "delta");
      const importPluginResponse = await rpc.request(
        "cowork/import/plugin",
        {
          cwd: tmpDir,
          source: "codex",
          sourcePath: deltaItem.sourcePath,
          conversionRequired: false,
          targetScope: "workspace",
        },
        IMPORT_RPC_TIMEOUT_MS,
      );
      expect(Array.isArray(importPluginResponse.result.events)).toBe(true);
      expect(importPluginResponse.result.events).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: "plugins_catalog",
            catalog: expect.objectContaining({
              plugins: expect.arrayContaining([expect.objectContaining({ id: "delta" })]),
            }),
          }),
        ]),
      );
      await expect(
        fs.stat(`${tmpDir}/.cowork/plugins/delta/.codex-plugin/plugin.json`),
      ).resolves.toBeDefined();

      const listSkills = await rpc.request(
        "cowork/import/list",
        {
          cwd: tmpDir,
          source: "codex",
          kind: "skill",
        },
        IMPORT_RPC_TIMEOUT_MS,
      );
      const skillItem = listSkills.result.event.items.find((i: any) => i.id === "echo-skill");
      expect(skillItem).toBeDefined();

      const importSkillResponse = await rpc.request(
        "cowork/import/skill",
        {
          cwd: tmpDir,
          source: "codex",
          sourcePath: skillItem.sourcePath,
          targetScope: "workspace",
        },
        IMPORT_RPC_TIMEOUT_MS,
      );
      expect(importSkillResponse.result.event).toEqual(
        expect.objectContaining({
          type: "skills_catalog",
          catalog: expect.objectContaining({
            installations: expect.arrayContaining([
              expect.objectContaining({ name: "echo-skill", scope: "project" }),
            ]),
          }),
        }),
      );

      rpc.close();
    } finally {
      await stopTestServer(server);
    }
  }, 20_000);

  test("reports homeExists=false when the source home is absent", async () => {
    const tmpDir = await makeTmpProject("agent-harness-import-empty-");
    const fakeHome = await makeTmpProject("agent-harness-import-empty-home-");
    const { server, url } = await startAgentServer(serverOpts(tmpDir, { homedir: fakeHome }));
    try {
      const rpc = await connectJsonRpc(url);
      const response = await rpc.request("cowork/import/list", {
        cwd: tmpDir,
        source: "claude",
        kind: "plugin",
      });
      expect(response.result.event).toEqual(
        expect.objectContaining({ type: "import_list", homeExists: false, items: [] }),
      );
      rpc.close();
    } finally {
      await stopTestServer(server);
    }
  });

  test("previews, imports, and dedupes Codex conversations", async () => {
    const tmpDir = await makeTmpProject("agent-harness-conversation-import-");
    const fakeHome = await makeTmpProject("agent-harness-conversation-import-home-");
    const statePath = await writeCodexConversation(fakeHome, tmpDir);

    const { server, url } = await startAgentServer(serverOpts(tmpDir, { homedir: fakeHome }));
    try {
      const rpc = await connectJsonRpc(url);
      const sources = await rpc.request(
        "cowork/conversationImport/sources/list",
        { includeCodex: true },
        IMPORT_RPC_TIMEOUT_MS,
      );
      expect(sources.result.sources).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ source: "codex", path: statePath, available: true }),
        ]),
      );

      const preview = await rpc.request(
        "cowork/conversationImport/preview",
        { sources: [{ source: "codex", path: statePath }], limit: 10 },
        IMPORT_RPC_TIMEOUT_MS,
      );
      expect(preview.result.conversations).toHaveLength(1);
      const conversation = preview.result.conversations[0];
      expect(conversation).toEqual(
        expect.objectContaining({
          source: "codex",
          sourceId: "codex-thread-1",
          title: "Codex import fixture",
          mapping: expect.objectContaining({ status: "matched" }),
          alreadyImportedThreadId: null,
        }),
      );

      const validate = await rpc.request(
        "cowork/conversationImport/workspaceMappings/validate",
        { mappings: { [conversation.fingerprint]: { kind: "create", path: tmpDir } } },
        IMPORT_RPC_TIMEOUT_MS,
      );
      expect(validate.result.valid).toBe(true);

      const imported = await rpc.request(
        "cowork/conversationImport/import",
        {
          sources: [{ source: "codex", path: statePath }],
          selected: [{ source: "codex", fingerprint: conversation.fingerprint }],
          defaultProvider: "openai",
          defaultModel: "gpt-5.5",
        },
        IMPORT_RPC_TIMEOUT_MS,
      );
      expect(imported.result.imported).toHaveLength(1);
      expect(imported.result.imported[0]).toEqual(
        expect.objectContaining({
          source: "codex",
          fingerprint: conversation.fingerprint,
          workspacePath: tmpDir,
          title: "Codex import fixture",
        }),
      );

      const duplicate = await rpc.request(
        "cowork/conversationImport/import",
        {
          sources: [{ source: "codex", path: statePath }],
          selected: [{ source: "codex", fingerprint: conversation.fingerprint }],
        },
        IMPORT_RPC_TIMEOUT_MS,
      );
      expect(duplicate.result.skipped).toEqual([
        expect.objectContaining({
          source: "codex",
          fingerprint: conversation.fingerprint,
          existingThreadId: imported.result.imported[0].threadId,
          reason: "already_imported",
        }),
      ]);
      rpc.close();
    } finally {
      await stopTestServer(server);
    }
  }, 20_000);

  test("previews, imports, and dedupes Cowork backup conversations", async () => {
    const tmpDir = await makeTmpProject("agent-harness-cowork-conversation-import-");
    const fakeHome = await makeTmpProject("agent-harness-cowork-conversation-import-home-");
    const backup = await writeCoworkConversationBackup(fakeHome, tmpDir);

    const { server, url } = await startAgentServer(serverOpts(tmpDir, { homedir: fakeHome }));
    try {
      const rpc = await connectJsonRpc(url);
      const sources = await rpc.request(
        "cowork/conversationImport/sources/list",
        { includeCowork: true, explicitPaths: [backup.rootDir] },
        IMPORT_RPC_TIMEOUT_MS,
      );
      expect(sources.result.sources).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            source: "cowork",
            path: backup.dbPath,
            available: true,
            conversationCount: 1,
          }),
        ]),
      );

      const sourceRequest = { source: "cowork" as const, path: backup.rootDir };
      const preview = await rpc.request(
        "cowork/conversationImport/preview",
        { sources: [sourceRequest], limit: 10 },
        IMPORT_RPC_TIMEOUT_MS,
      );
      expect(preview.result.conversations).toHaveLength(1);
      const conversation = preview.result.conversations[0];
      expect(conversation).toEqual(
        expect.objectContaining({
          source: "cowork",
          sourceId: "cowork-backup-thread-1",
          title: "Cowork backup import fixture",
          mapping: expect.objectContaining({ status: "matched", workspacePath: tmpDir }),
          alreadyImportedThreadId: null,
        }),
      );

      const imported = await rpc.request(
        "cowork/conversationImport/import",
        {
          sources: [sourceRequest],
          selected: [{ source: "cowork", fingerprint: conversation.fingerprint }],
          defaultProvider: "openai",
          defaultModel: "gpt-5.5",
        },
        IMPORT_RPC_TIMEOUT_MS,
      );
      expect(imported.result.imported).toHaveLength(1);
      expect(imported.result.imported[0]).toEqual(
        expect.objectContaining({
          source: "cowork",
          fingerprint: conversation.fingerprint,
          workspacePath: tmpDir,
          title: "Cowork backup import fixture",
        }),
      );

      const duplicate = await rpc.request(
        "cowork/conversationImport/import",
        {
          sources: [sourceRequest],
          selected: [{ source: "cowork", fingerprint: conversation.fingerprint }],
        },
        IMPORT_RPC_TIMEOUT_MS,
      );
      expect(duplicate.result.skipped).toEqual([
        expect.objectContaining({
          source: "cowork",
          fingerprint: conversation.fingerprint,
          existingThreadId: imported.result.imported[0].threadId,
          reason: "already_imported",
        }),
      ]);
      rpc.close();
    } finally {
      await stopTestServer(server);
    }
  }, 20_000);
});
