import { discoverSkills } from "../../src/skills";
import { loadSkillBodyByName } from "../../src/skills/loadSkillBody";
import {
  afterEach,
  bashInternal,
  beforeEach,
  createAskTool,
  createBashTool,
  createEditTool,
  createGlobTool,
  createGrepTool,
  createMemoryTool,
  createReadTool,
  createSkillTool,
  createTodoWriteTool,
  createTools,
  createWebFetchTool,
  createWebSearchTool,
  createWriteTool,
  describe,
  expect,
  fs,
  getAiCoworkerPaths,
  listSessionToolNames,
  makeConfig,
  makeCtx,
  mock,
  os,
  path,
  test,
  tmpDir,
  webFetchInternal,
  webSafetyInternal,
  withAuthHome,
  withEnv,
  writeConnectionStore,
  z,
} from "./tools.harness";

const repoRoot = path.resolve(import.meta.dir, "../..");

describe("skill tool", () => {
  function skillDoc(name: string, description: string, body: string): string {
    return ["---", `name: "${name}"`, `description: "${description}"`, "---", "", body].join("\n");
  }

  test("discovers and loads the bundled memories skill when advanced memory is on", async () => {
    const dir = await tmpDir();
    const config = makeConfig(dir, {
      skillsDirs: [path.join(repoRoot, "skills")],
      builtInDir: repoRoot,
      advancedMemory: true,
    });

    const discovered = await discoverSkills(config.skillsDirs);
    expect(discovered.find((skill) => skill.name === "memories")).toMatchObject({
      name: "memories",
      description: expect.stringContaining("long-term memories"),
      enabled: true,
    });

    const loaded = await loadSkillBodyByName(config, "memories");
    expect(loaded?.body).toContain("manageMemory");
    expect(loaded?.body).toContain("Writes always go to the active memory folder");
  });

  test("hides the bundled memories skill when advanced memory is off", async () => {
    const dir = await tmpDir();
    const config = makeConfig(dir, {
      skillsDirs: [path.join(repoRoot, "skills")],
      builtInDir: repoRoot,
    });

    expect(await loadSkillBodyByName(config, "memories")).toBeNull();
  });

  test("loads skill from SKILL.md in directory", async () => {
    const dir = await tmpDir();
    const skillDir = path.join(dir, "skills", "xlsx");
    await fs.mkdir(skillDir, { recursive: true });
    await fs.writeFile(
      path.join(skillDir, "SKILL.md"),
      skillDoc("xlsx", "Spreadsheet helper skill.", "# XLSX Skill\nInstructions here."),
      "utf-8",
    );

    const config = makeConfig(dir);
    config.skillsDirs = [path.join(dir, "skills")];
    const ctx = makeCtx(dir);
    ctx.config = config;
    const onSkillUsed = mock(async () => {});
    ctx.onSkillUsed = onSkillUsed;

    const t: any = createSkillTool(ctx);
    const res: string = await t.execute({ skillName: "xlsx" });
    expect(res).toContain("XLSX Skill");
    expect(res).toContain("Instructions here.");
    expect(onSkillUsed).toHaveBeenCalledTimes(1);
    expect(onSkillUsed).toHaveBeenCalledWith({
      skillName: "xlsx",
      kind: "tool",
      source: "skill-tool",
      skillPath: path.join(skillDir, "SKILL.md"),
      skillSource: "project",
    });
  });

  test("does not load non-spec flat file layout", async () => {
    const dir = await tmpDir();
    const skillsDir = path.join(dir, "skills");
    await fs.mkdir(skillsDir, { recursive: true });
    await fs.writeFile(path.join(skillsDir, "pdf.md"), "# PDF Skill Content", "utf-8");

    const config = makeConfig(dir);
    config.skillsDirs = [skillsDir];
    const ctx = makeCtx(dir);
    ctx.config = config;

    const t: any = createSkillTool(ctx);
    const res: string = await t.execute({ skillName: "pdf" });
    expect(res).toContain("not found");
    expect(res).toContain("do not guess a SKILL.md path");
  });

  test("returns 'not found' for missing skill", async () => {
    const dir = await tmpDir();
    const config = makeConfig(dir);
    config.skillsDirs = [path.join(dir, "skills")];
    const ctx = makeCtx(dir);
    ctx.config = config;

    const t: any = createSkillTool(ctx);
    const res: string = await t.execute({ skillName: "nonexistent" });
    expect(res).toContain("not found");
  });

  test("reloads modified skill content when file changes", async () => {
    const dir = await tmpDir();
    const skillDir = path.join(dir, "skills-cache-test", "cached-skill-unique");
    await fs.mkdir(skillDir, { recursive: true });
    await fs.writeFile(
      path.join(skillDir, "SKILL.md"),
      skillDoc("cached-skill-unique", "Cached skill.", "Cached content"),
      "utf-8",
    );

    const config = makeConfig(dir);
    config.skillsDirs = [path.join(dir, "skills-cache-test")];
    const ctx = makeCtx(dir);
    ctx.config = config;

    const t: any = createSkillTool(ctx);
    // First call reads from disk
    const res1: string = await t.execute({ skillName: "cached-skill-unique" });
    // Project-scope skill bodies are framed as untrusted, so assert containment.
    expect(res1).toContain("Cached content");

    // Modify the file on disk
    await fs.writeFile(
      path.join(skillDir, "SKILL.md"),
      skillDoc("cached-skill-unique", "Cached skill.", "Modified content"),
      "utf-8",
    );

    // Second call should reflect updated on-disk content.
    const res2: string = await t.execute({ skillName: "cached-skill-unique" });
    expect(res2).toContain("Modified content");
  });

  test("searches multiple skillsDirs in order", async () => {
    const dir = await tmpDir();
    const dir1 = path.join(dir, "s1-order-test");
    const dir2 = path.join(dir, "s2-order-test");
    await fs.mkdir(path.join(dir1, "myskill-order"), { recursive: true });
    await fs.mkdir(path.join(dir2, "myskill-order"), { recursive: true });
    await fs.writeFile(
      path.join(dir1, "myskill-order", "SKILL.md"),
      skillDoc("myskill-order", "First version.", "First dir"),
      "utf-8",
    );
    await fs.writeFile(
      path.join(dir2, "myskill-order", "SKILL.md"),
      skillDoc("myskill-order", "Second version.", "Second dir"),
      "utf-8",
    );

    const config = makeConfig(dir);
    config.skillsDirs = [dir1, dir2];
    const ctx = makeCtx(dir);
    ctx.config = config;

    const t: any = createSkillTool(ctx);
    const res: string = await t.execute({ skillName: "myskill-order" });
    expect(res).toContain("First dir");
    expect(res).not.toContain("Second dir");
  });

  test("profile skill allowlist filters descriptions and blocks hidden skill loads", async () => {
    const dir = await tmpDir();
    const skillsDir = path.join(dir, "skills");
    await fs.mkdir(path.join(skillsDir, "documents"), { recursive: true });
    await fs.mkdir(path.join(skillsDir, "presentations"), { recursive: true });
    await fs.writeFile(
      path.join(skillsDir, "documents", "SKILL.md"),
      skillDoc("documents", "Document helper.", "Document guidance."),
      "utf-8",
    );
    await fs.writeFile(
      path.join(skillsDir, "presentations", "SKILL.md"),
      skillDoc("presentations", "Deck helper.", "Presentation guidance."),
      "utf-8",
    );

    const config = makeConfig(dir, { skillsDirs: [skillsDir] });
    const logs: string[] = [];
    const ctx = makeCtx(dir, {
      config,
      log: (line) => logs.push(line),
      availableSkills: [
        { name: "documents", description: "Document helper." },
        { name: "presentations", description: "Deck helper." },
      ],
      agentProfile: {
        id: "docs-only",
        ref: "workspace:docs-only",
        scope: "workspace",
        displayName: "Docs Only",
        description: "",
        baseRole: "worker",
        prompt: "",
        allowedBuiltInTools: ["skill"],
        allowedMcpServers: [],
        skillNames: ["documents"],
        resolvedAt: "2026-06-02T12:00:00.000Z",
      },
    });

    const t: any = createSkillTool(ctx);
    expect(t.description).toContain('"documents"');
    expect(t.description).not.toContain('"presentations"');
    await expect(t.execute({ skillName: "documents" })).resolves.toContain("Document guidance.");
    await expect(t.execute({ skillName: "presentations" })).resolves.toContain(
      'Skill "presentations" is not available to this subagent profile.',
    );
    expect(logs).toContain('tool< skill {"ok":false,"reason":"profile_blocked"}');
  });

  test("appends deck-workspace hygiene guidance to presentations skill loads", async () => {
    const dir = await tmpDir();
    const skillDir = path.join(dir, "skills", "presentations");
    await fs.mkdir(skillDir, { recursive: true });
    await fs.writeFile(
      path.join(skillDir, "SKILL.md"),
      skillDoc(
        "presentations",
        "Presentations helper skill.",
        "# Presentations Skill\nBuild decks here.",
      ),
      "utf-8",
    );

    const config = makeConfig(dir);
    config.skillsDirs = [path.join(dir, "skills")];
    const ctx = makeCtx(dir);
    ctx.config = config;

    const t: any = createSkillTool(ctx);
    const res: string = await t.execute({ skillName: "presentations" });
    expect(res).toContain("Build decks here.");
    expect(res).toContain("## Cowork Addendum");
    expect(res).toContain("do not create `package.json`, lockfiles, or `node_modules`");
    expect(res).toContain("shared Cowork cache");
  });

  test("loads built-in presentations when project/global/user skill dirs are empty", async () => {
    const dir = await tmpDir();
    const projectSkills = path.join(dir, "project-skills");
    const globalSkills = path.join(dir, "global-skills");
    const userSkills = path.join(dir, "user-skills");
    const builtInSkills = path.join(dir, "built-in-skills");
    await fs.mkdir(projectSkills, { recursive: true });
    await fs.mkdir(globalSkills, { recursive: true });
    await fs.mkdir(userSkills, { recursive: true });
    await fs.mkdir(path.join(builtInSkills, "presentations"), { recursive: true });
    await fs.writeFile(
      path.join(builtInSkills, "presentations", "SKILL.md"),
      skillDoc(
        "presentations",
        "Built-in presentations skill.",
        "# Presentations Skill\nBuilt-in deck workflow.",
      ),
      "utf-8",
    );

    const config = makeConfig(dir, {
      skillsDirs: [projectSkills, globalSkills, userSkills, builtInSkills],
    });
    const ctx = makeCtx(dir);
    ctx.config = config;

    const t: any = createSkillTool(ctx);
    const res: string = await t.execute({ skillName: "presentations" });
    expect(res).toContain("Built-in deck workflow.");
    expect(res).toContain("## Cowork Addendum");
  });

  test("returns not found when skillsDirs is empty", async () => {
    const dir = await tmpDir();
    const config = makeConfig(dir);
    config.skillsDirs = [];
    const ctx = makeCtx(dir);
    ctx.config = config;

    const t: any = createSkillTool(ctx);
    const res: string = await t.execute({ skillName: "anything" });
    expect(res).toContain("not found");
  });
});

// ---------------------------------------------------------------------------
// memory tool
// ---------------------------------------------------------------------------
