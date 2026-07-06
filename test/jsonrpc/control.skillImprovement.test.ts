import { describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import path from "node:path";
import { startAgentServer } from "../../src/server/startServer";
import { makeTmpProject, serverOpts, stopTestServer } from "../helpers/wsHarness";
import { connectJsonRpc } from "./control.harness";

function skillDoc(name: string): string {
  return ["---", `name: "${name}"`, 'description: "Route test skill."', "---", "", "# Body"].join(
    "\n",
  );
}

async function startImprovementServer() {
  const tmpDir = await makeTmpProject();
  const skillDir = path.join(tmpDir, ".cowork", "skills", "route-skill");
  await fs.mkdir(skillDir, { recursive: true });
  await fs.writeFile(path.join(skillDir, "SKILL.md"), skillDoc("route-skill"), "utf-8");
  const { server, url } = await startAgentServer(
    serverOpts(tmpDir, {
      env: {
        AGENT_SKILL_IMPROVEMENT: "true",
      },
    }),
  );
  return { tmpDir, server, url };
}

describe("cowork/skills/improvement routes", () => {
  test("status returns a full skill_improvement_status event", async () => {
    const { tmpDir, server, url } = await startImprovementServer();
    try {
      const rpc = await connectJsonRpc(url);
      const response = await rpc.request("cowork/skills/improvement/status", { cwd: tmpDir });

      const event = response.result.event;
      expect(event.type).toBe("skill_improvement_status");
      expect(event.enabled).toBe(true);
      expect(event.scope).toBe("user");
      expect(event.pendingJobs).toEqual([]);
      expect(event.backups).toEqual([]);
      const skill = event.skills.find(
        (entry: { skillName: string }) => entry.skillName === "route-skill",
      );
      expect(skill).toMatchObject({
        skillName: "route-skill",
        sourceKind: "user",
        included: true,
        eligible: true,
        hasBackup: false,
      });
      rpc.close();
    } finally {
      await stopTestServer(server);
    }
  });

  test("run without usage evidence records a skipped history entry instead of improvising", async () => {
    const { tmpDir, server, url } = await startImprovementServer();
    try {
      const rpc = await connectJsonRpc(url);
      const response = await rpc.request("cowork/skills/improvement/run", {
        cwd: tmpDir,
        skillName: "route-skill",
      });

      const event = response.result.event;
      expect(event.type).toBe("skill_improvement_status");
      expect(event.runHistory[0]).toMatchObject({
        skillName: "route-skill",
        status: "skipped",
      });
      expect(event.runHistory[0].message).toContain("No recorded usage evidence");
      rpc.close();
    } finally {
      await stopTestServer(server);
    }
  });

  test("settings applied after startup are visible to the improvement service without a restart", async () => {
    const { tmpDir, server, url } = await startImprovementServer();
    try {
      const rpc = await connectJsonRpc(url);
      const before = await rpc.request("cowork/skills/improvement/status", { cwd: tmpDir });
      expect(before.result.event.scope).toBe("user");

      // Apply a scope change the way the desktop settings page does. The
      // service must observe it live — it previously served the boot-time
      // config snapshot until the server restarted.
      const applied = await rpc.request("cowork/session/defaults/apply", {
        cwd: tmpDir,
        config: { skillImprovementScope: "all" },
      });
      expect(applied.error).toBeUndefined();

      const after = await rpc.request("cowork/skills/improvement/status", { cwd: tmpDir });
      expect(after.result.event.scope).toBe("all");
      const routeSkill = after.result.event.skills.find(
        (entry: { skillName: string }) => entry.skillName === "route-skill",
      );
      expect(routeSkill).toMatchObject({ included: true });
      rpc.close();
    } finally {
      await stopTestServer(server);
    }
  });

  test("restore without a backup returns a JSON-RPC error and invalid params are rejected", async () => {
    const { tmpDir, server, url } = await startImprovementServer();
    try {
      const rpc = await connectJsonRpc(url);

      const missing = await rpc.request("cowork/skills/improvement/restore", {
        cwd: tmpDir,
        skillName: "route-skill",
      });
      expect(missing.error?.message).toContain("No skill improvement backup");

      const invalid = await rpc.request("cowork/skills/improvement/restore", {
        cwd: tmpDir,
        skillName: "",
      });
      expect(invalid.error).toBeDefined();
      rpc.close();
    } finally {
      await stopTestServer(server);
    }
  });
});
