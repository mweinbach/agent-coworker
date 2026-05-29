import { describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import path from "node:path";
import { startAgentServer } from "../../src/server/startServer";
import { makeTmpProject, serverOpts, stopTestServer } from "../helpers/wsHarness";
import { connectJsonRpc } from "./control.harness";

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

describe("server JSON-RPC import methods", () => {
  test("lists, imports a codex plugin, and imports a codex skill", async () => {
    const tmpDir = await makeTmpProject("agent-harness-import-");
    const fakeHome = await makeTmpProject("agent-harness-import-home-");
    await writeCodexPlugin(fakeHome, "delta");
    await writeCodexSkill(fakeHome, "echo-skill");

    const { server, url } = await startAgentServer(serverOpts(tmpDir, { homedir: fakeHome }));
    try {
      const rpc = await connectJsonRpc(url);

      const listPlugins = await rpc.request("cowork/import/list", {
        cwd: tmpDir,
        source: "codex",
        kind: "plugin",
      });
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
      const importPluginResponse = await rpc.request("cowork/import/plugin", {
        cwd: tmpDir,
        source: "codex",
        sourcePath: deltaItem.sourcePath,
        conversionRequired: false,
        targetScope: "workspace",
      });
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

      const listSkills = await rpc.request("cowork/import/list", {
        cwd: tmpDir,
        source: "codex",
        kind: "skill",
      });
      const skillItem = listSkills.result.event.items.find((i: any) => i.id === "echo-skill");
      expect(skillItem).toBeDefined();

      const importSkillResponse = await rpc.request("cowork/import/skill", {
        cwd: tmpDir,
        source: "codex",
        sourcePath: skillItem.sourcePath,
        targetScope: "workspace",
      });
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
});
