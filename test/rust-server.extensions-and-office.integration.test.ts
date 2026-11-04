import { describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import path from "node:path";

import { connectRustJsonRpc, startRustTestServer } from "./helpers/rustServerHarness";
import { buildMinimalXlsxBuffer } from "./helpers/zipFixture";

describe("Rust cowork-server skills, MCP, OOXML spreadsheet, backups, and importer routes", () => {
  test("discovers workspace skills and manages MCP server configs over JSON-RPC", async () => {
    const srv = await startRustTestServer();
    try {
      const skillDir = path.join(srv.workspaceDir, ".cowork", "skills", "custom-wire-skill");
      await fs.mkdir(skillDir, { recursive: true });
      await fs.writeFile(
        path.join(skillDir, "SKILL.md"),
        [
          "---",
          'name: "custom-wire-skill"',
          'description: "Verifies Rust skill discovery over JSON-RPC"',
          "---",
          "",
          "# Custom Wire Skill",
          "Use this skill in integration tests.",
        ].join("\n"),
        "utf8",
      );

      const rpc = await connectRustJsonRpc(srv.wsUrl);
      const listSkillsRes = await rpc.request("cowork/skills/list", { cwd: srv.workspaceDir });
      expect(JSON.stringify(listSkillsRes)).toContain("custom-wire-skill");

      const singleSkill = await rpc.request("cowork/skills/read", {
        cwd: srv.workspaceDir,
        skillName: "custom-wire-skill",
      });
      expect(JSON.stringify(singleSkill)).toContain("Custom Wire Skill");

      await rpc.request("cowork/mcp/server/upsert", {
        cwd: srv.workspaceDir,
        scope: "workspace",
        server: {
          name: "echo-stdio",
          transport: {
            type: "stdio",
            command: "echo",
            args: ["hello"],
          },
          enabled: false,
        },
      });

      const mcpRead = await rpc.request("cowork/mcp/servers/read", { cwd: srv.workspaceDir });
      expect(JSON.stringify(mcpRead)).toContain("echo-stdio");

      await rpc.request("cowork/mcp/server/delete", {
        cwd: srv.workspaceDir,
        scope: "workspace",
        name: "echo-stdio",
      });
      rpc.close();
    } finally {
      await srv.stop();
    }
  }, 30_000);

  test("round-trips spreadsheet workbook read & patch, workspace backups, and importer sources over JSON-RPC", async () => {
    const srv = await startRustTestServer({
      env: { AGENT_BACKUPS_ENABLED: "1" },
    });
    try {
      const xlsxPath = path.join(srv.workspaceDir, "budget.xlsx");
      await fs.writeFile(
        xlsxPath,
        buildMinimalXlsxBuffer({
          sheetName: "Summary",
          rows: [["Item", "100"]],
        }),
      );

      const rpc = await connectRustJsonRpc(srv.wsUrl);
      const initialWb = await rpc.request<any>("cowork/workspace/spreadsheet/workbook", {
        cwd: srv.workspaceDir,
        path: xlsxPath,
      });
      expect(initialWb.ok).toBe(true);
      expect(initialWb.workbook.sheets.length).toBe(1);

      const patched = await rpc.request<any>("cowork/workspace/spreadsheet/patch", {
        cwd: srv.workspaceDir,
        path: xlsxPath,
        operations: [{ type: "cell", sheetName: "Summary", address: "B1", rawInput: "250" }],
        expectedFileVersion: initialWb.workbook.fileVersion,
      });
      expect(patched.ok).toBe(true);

      const reread = await rpc.request<any>("cowork/workspace/spreadsheet/workbook", {
        cwd: srv.workspaceDir,
        path: xlsxPath,
      });
      expect(reread.ok).toBe(true);
      const sheet = reread.workbook.sheets[0];
      expect(sheet.cells.find((c: any) => c.address === "B1")?.rawValue).toBe(250);

      // Start a thread so we can create & read a workspace backup checkpoint
      const started = await rpc.request<{ thread: { id: string } }>("thread/start", {
        cwd: srv.workspaceDir,
      });
      const checkpoint = await rpc.request("cowork/backups/workspace/checkpoint", {
        cwd: srv.workspaceDir,
        targetSessionId: started.thread.id,
      });
      expect(checkpoint).toBeDefined();

      const backupsRead = await rpc.request("cowork/backups/workspace/read", {
        cwd: srv.workspaceDir,
      });
      expect(backupsRead).toBeDefined();

      // Conversation importer discovery
      const discovered = await rpc.request<{ sources: unknown[] }>(
        "cowork/conversationImport/sources/list",
        {},
      );
      expect(Array.isArray(discovered.sources)).toBe(true);

      rpc.close();
    } finally {
      await srv.stop();
    }
  }, 30_000);
});
