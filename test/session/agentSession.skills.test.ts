import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import {
  REAL_AGENT,
  AgentSession,
  ASK_SKIP_TOKEN,
  SessionCostTracker,
  createExperimentalA2uiSurfaceManager,
  createRuntime,
  defaultSupportedModel,
  fs,
  getSupportedModel,
  MAX_ATTACHMENT_BASE64_SIZE,
  MAX_ATTACHMENT_INLINE_BYTE_SIZE,
  MAX_TURN_ATTACHMENT_COUNT,
  MAX_TURN_ATTACHMENT_TOTAL_BASE64_SIZE,
  mockClosePooledCodexAppServerClient,
  mockConnectModelProvider,
  mockGenerateSessionTitle,
  mockGetAiCoworkerPaths,
  mockRunTurn,
  mockWritePersistedSessionSnapshot,
  os,
  path,
  resetAgentSessionMocks,
  makeSession,
  makeConfig,
  makeEmit,
  makeSessionBackupFactory,
  flushAsyncWork,
  waitForCondition,
  withEnv,
  isRecord,
} from "./agentSession.harness";
import type { TodoItem } from "./agentSession.harness";

describe("AgentSession", () => {
  beforeEach(async () => {
    await resetAgentSessionMocks();
  });

  afterAll(() => {
    mock.module("../../src/agent", () => REAL_AGENT);
    mock.restore();
  });

describe("skills", () => {
    async function makeTmpDir(prefix = "session-skills-test-"): Promise<string> {
      return await fs.mkdtemp(path.join(os.tmpdir(), prefix));
    }

    async function createSkill(parentDir: string, name: string, content: string): Promise<string> {
      const skillDir = path.join(parentDir, name);
      await fs.mkdir(skillDir, { recursive: true });
      const normalizedContent = content.trimStart().startsWith("---")
        ? content
        : ["---", `name: "${name}"`, `description: "${name} skill"`, "---", "", content].join("\n");
      await fs.writeFile(path.join(skillDir, "SKILL.md"), normalizedContent, "utf-8");
      return skillDir;
    }

    test("listSkills emits skills_list with discovered entries", async () => {
      const tmp = await makeTmpDir();
      await createSkill(tmp, "alpha", "# Alpha Skill\nTRIGGERS: a\n");

      const cfg: AgentConfig = { ...makeConfig(tmp), skillsDirs: [tmp] };
      const { session, events } = makeSession({ config: cfg });

      await session.listSkills();

      const evt = events.find((e) => e.type === "skills_list") as any;
      expect(evt).toBeDefined();
      expect(Array.isArray(evt.skills)).toBe(true);
      expect(evt.skills.some((s: any) => s.name === "alpha")).toBe(true);

      const alpha = evt.skills.find((s: any) => s.name === "alpha");
      expect(alpha.source).toBe("project");
      expect(alpha.enabled).toBe(true);
      expect(String(alpha.path)).toContain(path.join("alpha", "SKILL.md"));
    });

    test("readSkill emits skill_content with content", async () => {
      const tmp = await makeTmpDir();
      await createSkill(tmp, "alpha", "# Alpha Skill\nTRIGGERS: a\n");

      const cfg: AgentConfig = { ...makeConfig(tmp), skillsDirs: [tmp] };
      const { session, events } = makeSession({ config: cfg });

      await session.readSkill("alpha");

      const evt = events.find((e) => e.type === "skill_content") as any;
      expect(evt).toBeDefined();
      expect(evt.skill.name).toBe("alpha");
      expect(evt.skill.enabled).toBe(true);
      expect(String(evt.content)).toContain("# Alpha Skill");
    });

    test("readSkill missing skill emits error", async () => {
      const tmp = await makeTmpDir();
      const cfg: AgentConfig = { ...makeConfig(tmp), skillsDirs: [tmp] };
      const { session, events } = makeSession({ config: cfg });

      await session.readSkill("missing");

      const evt = events.find((e) => e.type === "error") as any;
      expect(evt).toBeDefined();
      expect(evt.message).toContain('Skill "missing" not found.');
    });

    test("disableSkill moves global skill to disabled-skills and marks it disabled", async () => {
      const root = await makeTmpDir();
      const project = path.join(root, "project-skills");
      const global = path.join(root, "skills");
      await fs.mkdir(project, { recursive: true });
      await fs.mkdir(global, { recursive: true });

      await createSkill(global, "alpha", "# Alpha Skill\nTRIGGERS: a\n");

      const cfg: AgentConfig = { ...makeConfig(root), skillsDirs: [project, global] };
      const { session, events } = makeSession({ config: cfg });

      await session.disableSkill("alpha");

      const evt = events.filter((e) => e.type === "skills_list").at(-1) as any;
      expect(evt).toBeDefined();
      const alpha = evt.skills.find((s: any) => s.name === "alpha");
      expect(alpha).toBeDefined();
      expect(alpha.source).toBe("global");
      expect(alpha.enabled).toBe(false);
      expect(String(alpha.path)).toContain(path.join("disabled-skills", "alpha", "SKILL.md"));
      await fs.access(path.join(root, "disabled-skills", "alpha", "SKILL.md"));
    });

    test("disableSkill while running emits Agent is busy and leaves the skill unchanged", async () => {
      const root = await makeTmpDir();
      const project = path.join(root, "project-skills");
      const global = path.join(root, "skills");
      await fs.mkdir(project, { recursive: true });
      await fs.mkdir(global, { recursive: true });
      await createSkill(global, "alpha", "# Alpha Skill\nTRIGGERS: a\n");

      const cfg: AgentConfig = { ...makeConfig(root), skillsDirs: [project, global] };
      const { session, events } = makeSession({ config: cfg });
      (session as any).state.running = true;

      await session.disableSkill("alpha");

      const evt = events.find((e) => e.type === "error") as any;
      expect(evt).toBeDefined();
      expect(evt.code).toBe("busy");
      expect(evt.message).toBe("Agent is busy");
      await fs.access(path.join(root, "skills", "alpha", "SKILL.md"));
      await expect(
        fs.access(path.join(root, "disabled-skills", "alpha", "SKILL.md")),
      ).rejects.toBeDefined();
    });

    test("enableSkill moves global skill back to skills and marks it enabled", async () => {
      const root = await makeTmpDir();
      const project = path.join(root, "project-skills");
      const global = path.join(root, "skills");
      const disabled = path.join(root, "disabled-skills");
      await fs.mkdir(project, { recursive: true });
      await fs.mkdir(disabled, { recursive: true });

      await createSkill(disabled, "alpha", "# Alpha Skill\nTRIGGERS: a\n");

      const cfg: AgentConfig = { ...makeConfig(root), skillsDirs: [project, global] };
      const { session, events } = makeSession({ config: cfg });

      await session.enableSkill("alpha");

      const evt = events.filter((e) => e.type === "skills_list").at(-1) as any;
      expect(evt).toBeDefined();
      const alpha = evt.skills.find((s: any) => s.name === "alpha");
      expect(alpha).toBeDefined();
      expect(alpha.source).toBe("global");
      expect(alpha.enabled).toBe(true);
      expect(String(alpha.path)).toContain(path.join("skills", "alpha", "SKILL.md"));
      await fs.access(path.join(root, "skills", "alpha", "SKILL.md"));
    });

    test("deleteSkill removes global skill directory", async () => {
      const root = await makeTmpDir();
      const project = path.join(root, "project-skills");
      const global = path.join(root, "skills");
      await fs.mkdir(project, { recursive: true });
      await fs.mkdir(global, { recursive: true });
      await createSkill(global, "alpha", "# Alpha Skill\nTRIGGERS: a\n");

      const cfg: AgentConfig = { ...makeConfig(root), skillsDirs: [project, global] };
      const { session, events } = makeSession({ config: cfg });

      await session.deleteSkill("alpha");

      const evt = events.filter((e) => e.type === "skills_list").at(-1) as any;
      expect(evt).toBeDefined();
      expect(evt.skills.some((s: any) => s.name === "alpha")).toBe(false);
      await expect(fs.access(path.join(root, "skills", "alpha"))).rejects.toBeDefined();
    });

    test("getSkillsCatalog emits non-deduped installation catalog", async () => {
      const root = await makeTmpDir();
      const project = path.join(root, ".cowork", "skills");
      const global = path.join(root, ".cowork", "skills");
      await fs.mkdir(project, { recursive: true });
      await fs.mkdir(global, { recursive: true });
      await createSkill(project, "alpha", "# Project Alpha");
      await createSkill(global, "alpha", "# Global Alpha");

      const cfg: AgentConfig = { ...makeConfig(root), skillsDirs: [project, global] };
      const { session, events } = makeSession({ config: cfg });

      await session.getSkillsCatalog();

      const evt = events.find((event) => event.type === "skills_catalog") as any;
      expect(evt).toBeDefined();
      expect(evt.catalog.installations).toHaveLength(2);
      expect(evt.catalog.effectiveSkills).toHaveLength(1);
      expect(evt.catalog.effectiveSkills[0]?.scope).toBe("project");
      expect(evt.clearedMutationPendingKeys).toBeUndefined();
    });

    test("installSkills installs a local skill into workspace scope and emits catalog/detail", async () => {
      const root = await makeTmpDir();
      const project = path.join(root, ".cowork", "skills");
      const sourceRoot = path.join(root, "incoming");
      await fs.mkdir(project, { recursive: true });
      await createSkill(sourceRoot, "alpha", "# Alpha Skill");

      const cfg: AgentConfig = { ...makeConfig(root), skillsDirs: [project] };
      const { session, events } = makeSession({ config: cfg });

      await session.installSkills(sourceRoot, "project");

      const catalogEvt = events.filter((event) => event.type === "skills_catalog").at(-1) as any;
      expect(catalogEvt).toBeDefined();
      expect(catalogEvt.catalog.effectiveSkills.some((skill: any) => skill.name === "alpha")).toBe(
        true,
      );
      expect(catalogEvt.clearedMutationPendingKeys).toEqual(["install:project"]);

      const detailEvt = events.filter((event) => event.type === "skill_installation").at(-1) as any;
      expect(detailEvt).toBeDefined();
      expect(detailEvt.installation?.name).toBe("alpha");
      await fs.access(path.join(project, "alpha", "SKILL.md"));
    });
  });
});
