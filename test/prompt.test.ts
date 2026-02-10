import { describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { loadSystemPrompt, loadSubAgentPrompt } from "../src/prompt";
import type { AgentConfig } from "../src/types";

function repoRoot(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, "..");
}

async function makeTmpDirs() {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "agent-prompt-"));
  const cwd = path.join(tmp, "project");
  const home = path.join(tmp, "home");
  const builtIn = path.join(tmp, "built-in");
  await fs.mkdir(cwd, { recursive: true });
  await fs.mkdir(home, { recursive: true });
  await fs.mkdir(builtIn, { recursive: true });
  return { tmp, cwd, home, builtIn };
}

function makeConfig(overrides: Partial<AgentConfig> = {}): AgentConfig {
  const base: AgentConfig = {
    provider: "google",
    model: "test-model-id",
    subAgentModel: "test-sub-model",
    workingDirectory: "/test/working",
    outputDirectory: "/test/output",
    uploadsDirectory: "/test/uploads",
    userName: "TestUser",
    knowledgeCutoff: "End of May 2025",
    projectAgentDir: "/test/project/.agent",
    userAgentDir: "/test/home/.agent",
    builtInDir: repoRoot(),
    builtInConfigDir: path.join(repoRoot(), "config"),
    skillsDirs: [
      "/test/project/.agent/skills",
      "/test/home/.agent/skills",
      path.join(repoRoot(), "skills"),
    ],
    memoryDirs: ["/test/project/.agent/memory", "/test/home/.agent/memory"],
    configDirs: [
      "/test/project/.agent",
      "/test/home/.agent",
      path.join(repoRoot(), "config"),
    ],
  };
  return { ...base, ...overrides };
}

async function writeFile(p: string, content: string) {
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(p, content, "utf-8");
}

// ---------------------------------------------------------------------------
// loadSystemPrompt
// ---------------------------------------------------------------------------
describe("loadSystemPrompt", () => {
  test("loads system.md from builtInDir/prompts/", async () => {
    const config = makeConfig();
    const prompt = await loadSystemPrompt(config);
    expect(prompt).toBeDefined();
    expect(typeof prompt).toBe("string");
    expect(prompt.length).toBeGreaterThan(100);
  });

  test("replaces {{workingDirectory}} template variable", async () => {
    const config = makeConfig({ workingDirectory: "/my/custom/working/dir" });
    const prompt = await loadSystemPrompt(config);
    expect(prompt).toContain("/my/custom/working/dir");
    expect(prompt).not.toContain("{{workingDirectory}}");
  });

  test("replaces {{outputDirectory}} template variable", async () => {
    const config = makeConfig({ outputDirectory: "/my/custom/output/dir" });
    const prompt = await loadSystemPrompt(config);
    expect(prompt).toContain("/my/custom/output/dir");
    expect(prompt).not.toContain("{{outputDirectory}}");
  });

  test("replaces {{uploadsDirectory}} template variable", async () => {
    const config = makeConfig({ uploadsDirectory: "/my/custom/uploads/dir" });
    const prompt = await loadSystemPrompt(config);
    expect(prompt).toContain("/my/custom/uploads/dir");
    expect(prompt).not.toContain("{{uploadsDirectory}}");
  });

  test("replaces {{modelName}} template variable", async () => {
    const config = makeConfig({ model: "super-unique-model-name-xyz" });
    const prompt = await loadSystemPrompt(config);
    expect(prompt).toContain("super-unique-model-name-xyz");
    expect(prompt).not.toContain("{{modelName}}");
  });

  test("replaces {{userName}} template variable", async () => {
    const config = makeConfig({ userName: "DistinctUserName42" });
    const prompt = await loadSystemPrompt(config);
    expect(prompt).toContain("DistinctUserName42");
    expect(prompt).not.toContain("{{userName}}");
  });

  test("replaces {{userName}} with empty string when not set", async () => {
    const config = makeConfig({ userName: "" });
    const prompt = await loadSystemPrompt(config);
    // Should not contain the template variable
    expect(prompt).not.toContain("{{userName}}");
  });

  test("replaces {{currentDate}} template variable", async () => {
    const config = makeConfig();
    const prompt = await loadSystemPrompt(config);
    expect(prompt).not.toContain("{{currentDate}}");
    // The date should be a readable string like "Friday, February 7, 2026"
    const today = new Date();
    const yearStr = today.getFullYear().toString();
    expect(prompt).toContain(yearStr);
  });

  test("replaces {{currentYear}} template variable", async () => {
    const config = makeConfig();
    const prompt = await loadSystemPrompt(config);
    expect(prompt).not.toContain("{{currentYear}}");
    const year = new Date().getFullYear().toString();
    expect(prompt).toContain(year);
  });

  test("replaces {{knowledgeCutoff}} template variable", async () => {
    const config = makeConfig({ knowledgeCutoff: "UniqueKnowledgeCutoff2099" });
    const prompt = await loadSystemPrompt(config);
    expect(prompt).toContain("UniqueKnowledgeCutoff2099");
    expect(prompt).not.toContain("{{knowledgeCutoff}}");
  });

  test("replaces {{skillsDirectory}} template variable if present in template", async () => {
    const config = makeConfig();
    const prompt = await loadSystemPrompt(config);
    // The template variable should not remain unreplaced
    expect(prompt).not.toContain("{{skillsDirectory}}");
  });

  test("no unreplaced template variables remain", async () => {
    const config = makeConfig();
    const prompt = await loadSystemPrompt(config);
    // Check that no {{...}} patterns remain
    const unreplaced = prompt.match(/\{\{[a-zA-Z]+\}\}/g);
    expect(unreplaced).toBeNull();
  });

  test("appends skills section when skills are found", async () => {
    const { tmp } = await makeTmpDirs();
    const skillsDir = path.join(tmp, "test-skills");

    // Create a skill directory with SKILL.md
    const skillMdPath = path.join(skillsDir, "test-skill", "SKILL.md");
    await writeFile(skillMdPath, "# Test Skill Description\n\nSome content.\nTRIGGERS: trigger1, trigger2");

    const config = makeConfig({
      skillsDirs: [skillsDir],
    });

    const prompt = await loadSystemPrompt(config);
    expect(prompt).toContain("## Available Skills");
    expect(prompt).toContain("test-skill");
    expect(prompt).toContain("Test Skill Description");
    expect(prompt).toContain("aliases: trigger1");
    expect(prompt).toContain("trigger2");
  });

  test("appends multiple skills when multiple skill dirs exist", async () => {
    const { tmp } = await makeTmpDirs();
    const skillsDir = path.join(tmp, "multi-skills");

    await writeFile(
      path.join(skillsDir, "skill-a", "SKILL.md"),
      "# Skill A Description\n\nContent A.\nTRIGGERS: alpha, bravo"
    );

    await writeFile(
      path.join(skillsDir, "skill-b", "SKILL.md"),
      "# Skill B Description\n\nContent B.\nTRIGGERS: charlie, delta"
    );

    const config = makeConfig({
      skillsDirs: [skillsDir],
    });

    const prompt = await loadSystemPrompt(config);
    expect(prompt).toContain("skill-a");
    expect(prompt).toContain("Skill A Description");
    expect(prompt).toContain("skill-b");
    expect(prompt).toContain("Skill B Description");
  });

  test("skips skills section when no skills are discovered", async () => {
    const { tmp } = await makeTmpDirs();
    // Empty skills directory - no skill subdirectories
    const emptySkillsDir = path.join(tmp, "empty-skills");
    await fs.mkdir(emptySkillsDir, { recursive: true });

    const config = makeConfig({
      skillsDirs: [emptySkillsDir],
    });

    const prompt = await loadSystemPrompt(config);
    expect(prompt).not.toContain("## Available Skills");
  });

  test("skips skills section when skills dirs do not exist", async () => {
    const config = makeConfig({
      skillsDirs: [
        "/nonexistent/path/skills1",
        "/nonexistent/path/skills2",
      ],
    });

    const prompt = await loadSystemPrompt(config);
    expect(prompt).not.toContain("## Available Skills");
  });

  test("appends hot cache (AGENT.md) when found in project dir", async () => {
    const { tmp } = await makeTmpDirs();
    const projectAgentDir = path.join(tmp, "project", ".agent");
    const userAgentDir = path.join(tmp, "home", ".agent");

    await writeFile(
      path.join(projectAgentDir, "AGENT.md"),
      "This is the project hot cache content."
    );

    const config = makeConfig({
      projectAgentDir,
      userAgentDir,
      skillsDirs: ["/nonexistent/skills"],
    });

    const prompt = await loadSystemPrompt(config);
    expect(prompt).toContain("## Memory (loaded from previous sessions)");
    expect(prompt).toContain("This is the project hot cache content.");
  });

  test("appends hot cache (AGENT.md) when found in user dir (fallback)", async () => {
    const { tmp } = await makeTmpDirs();
    const projectAgentDir = path.join(tmp, "project-no-cache", ".agent");
    const userAgentDir = path.join(tmp, "home", ".agent");

    // Only user dir has AGENT.md, not project dir
    await writeFile(
      path.join(userAgentDir, "AGENT.md"),
      "This is the user hot cache content."
    );

    const config = makeConfig({
      projectAgentDir,
      userAgentDir,
      skillsDirs: ["/nonexistent/skills"],
    });

    const prompt = await loadSystemPrompt(config);
    expect(prompt).toContain("## Memory (loaded from previous sessions)");
    expect(prompt).toContain("This is the user hot cache content.");
  });

  test("project AGENT.md takes priority over user AGENT.md", async () => {
    const { tmp } = await makeTmpDirs();
    const projectAgentDir = path.join(tmp, "project", ".agent");
    const userAgentDir = path.join(tmp, "home", ".agent");

    await writeFile(
      path.join(projectAgentDir, "AGENT.md"),
      "PROJECT cache wins."
    );

    await writeFile(
      path.join(userAgentDir, "AGENT.md"),
      "USER cache loses."
    );

    const config = makeConfig({
      projectAgentDir,
      userAgentDir,
      skillsDirs: ["/nonexistent/skills"],
    });

    const prompt = await loadSystemPrompt(config);
    expect(prompt).toContain("PROJECT cache wins.");
    expect(prompt).not.toContain("USER cache loses.");
  });

  test("skips hot cache section when no AGENT.md exists", async () => {
    const { tmp } = await makeTmpDirs();
    const projectAgentDir = path.join(tmp, "project-empty", ".agent");
    const userAgentDir = path.join(tmp, "home-empty", ".agent");

    const config = makeConfig({
      projectAgentDir,
      userAgentDir,
      skillsDirs: ["/nonexistent/skills"],
    });

    const prompt = await loadSystemPrompt(config);
    expect(prompt).not.toContain("## Memory (loaded from previous sessions)");
  });

  test("skips hot cache section when AGENT.md is empty/whitespace", async () => {
    const { tmp } = await makeTmpDirs();
    const projectAgentDir = path.join(tmp, "project", ".agent");
    const userAgentDir = path.join(tmp, "home", ".agent");

    await writeFile(path.join(projectAgentDir, "AGENT.md"), "   \n  \n  ");

    const config = makeConfig({
      projectAgentDir,
      userAgentDir,
      skillsDirs: ["/nonexistent/skills"],
    });

    const prompt = await loadSystemPrompt(config);
    expect(prompt).not.toContain("## Memory (loaded from previous sessions)");
  });

  test("uses real system.md from repo and all variables get replaced", async () => {
    const config = makeConfig();
    const prompt = await loadSystemPrompt(config);

    // Verify the prompt contains expected structural elements from system.md
    expect(prompt).toContain("# Environment");
    expect(prompt).toContain("# Core Behavior");
    expect(prompt).toContain("# Tools");
  });

  test("skills section includes source annotation", async () => {
    const { tmp } = await makeTmpDirs();
    const skillsDir = path.join(tmp, "src-skills");

    await writeFile(
      path.join(skillsDir, "annotated-skill", "SKILL.md"),
      "# Annotated Skill\n\nContent.\nTRIGGERS: foo"
    );

    const config = makeConfig({
      skillsDirs: [skillsDir],
    });

    const prompt = await loadSystemPrompt(config);
    expect(prompt).toContain("source: project");
  });

  test("skills section includes trigger annotations", async () => {
    const { tmp } = await makeTmpDirs();
    const skillsDir = path.join(tmp, "trigger-skills");

    await writeFile(
      path.join(skillsDir, "xlsx", "SKILL.md"),
      "# Excel Spreadsheet Skill\n\nContent."
    );

    const config = makeConfig({
      skillsDirs: [skillsDir],
    });

    const prompt = await loadSystemPrompt(config);
    // xlsx has default triggers: spreadsheet, excel, .xlsx, csv, data table, chart
    expect(prompt).toContain("spreadsheet");
    expect(prompt).toContain("excel");
  });
});

// ---------------------------------------------------------------------------
// loadSubAgentPrompt
// ---------------------------------------------------------------------------
describe("loadSubAgentPrompt", () => {
  test("loads explore prompt and returns non-empty string", async () => {
    const config = makeConfig();
    const prompt = await loadSubAgentPrompt(config, "explore");
    expect(typeof prompt).toBe("string");
    expect(prompt.length).toBeGreaterThan(0);
    expect(prompt).toContain("codebase");
  });

  test("loads research prompt and returns non-empty string", async () => {
    const config = makeConfig();
    const prompt = await loadSubAgentPrompt(config, "research");
    expect(typeof prompt).toBe("string");
    expect(prompt.length).toBeGreaterThan(0);
    expect(prompt).toContain("research");
  });

  test("explore prompt is different from research prompt", async () => {
    const config = makeConfig();
    const explore = await loadSubAgentPrompt(config, "explore");
    const research = await loadSubAgentPrompt(config, "research");
    expect(explore).not.toBe(research);
  });

  test("throws for non-existent agent type file", async () => {
    const config = makeConfig();
    await expect(
      loadSubAgentPrompt(config, "general")
    ).rejects.toThrow();
  });

  test("loads from builtInDir/prompts/sub-agents/ path", async () => {
    const { builtIn } = await makeTmpDirs();

    const promptContent = "Custom explore agent prompt for testing.";
    await writeFile(
      path.join(builtIn, "prompts", "sub-agents", "explore.md"),
      promptContent
    );

    const config = makeConfig({ builtInDir: builtIn });
    const prompt = await loadSubAgentPrompt(config, "explore");
    expect(prompt).toBe(promptContent);
  });
});

// ---------------------------------------------------------------------------
// loadHotCache (tested indirectly through loadSystemPrompt)
// ---------------------------------------------------------------------------
describe("loadHotCache (tested indirectly)", () => {
  test("returns AGENT.md content from project dir", async () => {
    const { tmp } = await makeTmpDirs();
    const projectAgentDir = path.join(tmp, "project", ".agent");
    const userAgentDir = path.join(tmp, "home", ".agent");

    await writeFile(
      path.join(projectAgentDir, "AGENT.md"),
      "Project-level memory content here."
    );

    const config = makeConfig({
      projectAgentDir,
      userAgentDir,
      skillsDirs: ["/nonexistent/skills"],
    });

    const prompt = await loadSystemPrompt(config);
    expect(prompt).toContain("Project-level memory content here.");
  });

  test("falls back to user dir when project dir has no AGENT.md", async () => {
    const { tmp } = await makeTmpDirs();
    const projectAgentDir = path.join(tmp, "no-project", ".agent");
    const userAgentDir = path.join(tmp, "home", ".agent");

    await writeFile(
      path.join(userAgentDir, "AGENT.md"),
      "User-level memory fallback content."
    );

    const config = makeConfig({
      projectAgentDir,
      userAgentDir,
      skillsDirs: ["/nonexistent/skills"],
    });

    const prompt = await loadSystemPrompt(config);
    expect(prompt).toContain("User-level memory fallback content.");
  });

  test("returns empty when no AGENT.md exists anywhere", async () => {
    const { tmp } = await makeTmpDirs();
    const projectAgentDir = path.join(tmp, "empty-project", ".agent");
    const userAgentDir = path.join(tmp, "empty-home", ".agent");

    const config = makeConfig({
      projectAgentDir,
      userAgentDir,
      skillsDirs: ["/nonexistent/skills"],
    });

    const prompt = await loadSystemPrompt(config);
    // No memory section should be appended
    expect(prompt).not.toContain("## Memory");
  });

  test("AGENT.md with rich markdown content is preserved", async () => {
    const { tmp } = await makeTmpDirs();
    const projectAgentDir = path.join(tmp, "rich-project", ".agent");
    const userAgentDir = path.join(tmp, "rich-home", ".agent");

    const richContent = [
      "# Project Notes",
      "",
      "## Key Contacts",
      "- Alice: alice@example.com (PM)",
      "- Bob: bob@example.com (Lead)",
      "",
      "## Acronyms",
      "- API: Application Programming Interface",
      "- CI: Continuous Integration",
    ].join("\n");

    await writeFile(path.join(projectAgentDir, "AGENT.md"), richContent);

    const config = makeConfig({
      projectAgentDir,
      userAgentDir,
      skillsDirs: ["/nonexistent/skills"],
    });

    const prompt = await loadSystemPrompt(config);
    expect(prompt).toContain("# Project Notes");
    expect(prompt).toContain("alice@example.com");
    expect(prompt).toContain("CI: Continuous Integration");
  });

  test("hot cache combined with skills in same prompt", async () => {
    const { tmp } = await makeTmpDirs();
    const projectAgentDir = path.join(tmp, "combo-project", ".agent");
    const userAgentDir = path.join(tmp, "combo-home", ".agent");
    const skillsDir = path.join(tmp, "combo-skills");

    await writeFile(
      path.join(projectAgentDir, "AGENT.md"),
      "Hot cache content present."
    );

    await writeFile(
      path.join(skillsDir, "combo-skill", "SKILL.md"),
      "# Combo Skill\n\nContent.\nTRIGGERS: combo"
    );

    const config = makeConfig({
      projectAgentDir,
      userAgentDir,
      skillsDirs: [skillsDir],
    });

    const prompt = await loadSystemPrompt(config);

    // Both sections should be present
    expect(prompt).toContain("## Available Skills");
    expect(prompt).toContain("combo-skill");
    expect(prompt).toContain("## Memory (loaded from previous sessions)");
    expect(prompt).toContain("Hot cache content present.");

    // Skills section should come before memory section
    const skillsIndex = prompt.indexOf("## Available Skills");
    const memoryIndex = prompt.indexOf("## Memory (loaded from previous sessions)");
    expect(skillsIndex).toBeLessThan(memoryIndex);
  });
});
