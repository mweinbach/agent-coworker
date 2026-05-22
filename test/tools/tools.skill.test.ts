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
  createNotebookEditTool,
  createReadTool,
  createSkillTool,
  createTodoWriteTool,
  createTools,
  createWebFetchTool,
  createWebSearchTool,
  createWriteTool,
  currentTodos,
  describe,
  expect,
  fs,
  getAiCoworkerPaths,
  listSessionToolNames,
  makeConfig,
  makeCtx,
  mock,
  onTodoChange,
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

describe("skill tool", () => {
  function skillDoc(name: string, description: string, body: string): string {
    return ["---", `name: "${name}"`, `description: "${description}"`, "---", "", body].join("\n");
  }

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

    const t: any = createSkillTool(ctx);
    const res: string = await t.execute({ skillName: "xlsx" });
    expect(res).toContain("XLSX Skill");
    expect(res).toContain("Instructions here.");
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
    expect(res1).toBe("Cached content");

    // Modify the file on disk
    await fs.writeFile(
      path.join(skillDir, "SKILL.md"),
      skillDoc("cached-skill-unique", "Cached skill.", "Modified content"),
      "utf-8",
    );

    // Second call should reflect updated on-disk content.
    const res2: string = await t.execute({ skillName: "cached-skill-unique" });
    expect(res2).toBe("Modified content");
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
    expect(res).toBe("First dir");
  });

  test("hides the a2ui skill when the workspace A2UI feature flag is disabled", async () => {
    const dir = await tmpDir();
    const skillDir = path.join(dir, "skills", "a2ui");
    await fs.mkdir(skillDir, { recursive: true });
    await fs.writeFile(
      path.join(skillDir, "SKILL.md"),
      skillDoc("a2ui", "A2UI helper skill.", "# A2UI Skill\nDo not load when disabled."),
      "utf-8",
    );

    const config = makeConfig(dir, {
      skillsDirs: [path.join(dir, "skills")],
      enableA2ui: true,
      featureFlags: {
        workspace: {
          a2ui: false,
        },
      },
    });
    const ctx = makeCtx(dir);
    ctx.config = config;

    const t: any = createSkillTool(ctx);
    const res: string = await t.execute({ skillName: "a2ui" });
    expect(res).toContain("not found");
  });

  test("loads the a2ui skill when the workspace A2UI feature flag is enabled", async () => {
    await withEnv("COWORK_EXPERIMENTAL_A2UI", "1", async () => {
      const dir = await tmpDir();
      const skillDir = path.join(dir, "skills", "a2ui");
      await fs.mkdir(skillDir, { recursive: true });
      await fs.writeFile(
        path.join(skillDir, "SKILL.md"),
        skillDoc("a2ui", "A2UI helper skill.", "# A2UI Skill\nProtocol guidance."),
        "utf-8",
      );

      const config = makeConfig(dir, {
        skillsDirs: [path.join(dir, "skills")],
        enableA2ui: false,
        featureFlags: {
          workspace: {
            a2ui: true,
          },
        },
      });
      const ctx = makeCtx(dir);
      ctx.config = config;

      const t: any = createSkillTool(ctx);
      const res: string = await t.execute({ skillName: "a2ui" });
      expect(res).toContain("Protocol guidance.");
    });
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
