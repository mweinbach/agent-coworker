import { describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { expandCommandTemplate, listCommands, resolveCommand } from "../src/server/commands";
import type { AgentConfig } from "../src/types";

function repoRoot(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, "..");
}

function makeConfig(overrides?: Partial<AgentConfig>): AgentConfig {
  return {
    provider: "google",
    model: "gemini-3-flash-preview",
    preferredChildModel: "gemini-3-flash-preview",
    workingDirectory: "/tmp",
    outputDirectory: "/tmp/output",
    uploadsDirectory: "/tmp/uploads",
    userName: "",
    knowledgeCutoff: "unknown",
    projectAgentDir: "/tmp/.agent",
    userAgentDir: "/tmp/home/.agent",
    builtInDir: repoRoot(),
    builtInConfigDir: path.join(repoRoot(), "config"),
    skillsDirs: [],
    memoryDirs: [],
    configDirs: [],
    enableMcp: true,
    ...overrides,
  };
}

describe("server command helpers", () => {
  test("expandCommandTemplate supports $ARGUMENTS and numbered placeholders", () => {
    expect(expandCommandTemplate("Review: $ARGUMENTS", "HEAD~2..HEAD")).toBe(
      "Review: HEAD~2..HEAD",
    );

    // Last placeholder swallows remaining args for OpenCode parity.
    expect(expandCommandTemplate("$1 | $2", "one two three")).toBe("one | two three");
  });

  test("expandCommandTemplate preserves literal numbered markers in raw arguments", () => {
    expect(expandCommandTemplate("Review: $ARGUMENTS", "compare $2 to $3")).toBe(
      "Review: compare $2 to $3",
    );
  });

  test("expandCommandTemplate appends args when template has no placeholders", () => {
    expect(expandCommandTemplate("Do the thing", "with extra context")).toBe(
      "Do the thing\n\nwith extra context",
    );
  });

  test("listCommands includes built-in init/review", async () => {
    const commands = await listCommands(makeConfig());
    const names = commands.map((cmd) => cmd.name);

    expect(names.includes("init")).toBe(true);
    expect(names.includes("review")).toBe(true);
  });

  test("resolveCommand returns config-defined command templates", async () => {
    const config = makeConfig({
      command: {
        triage: {
          description: "triage issues",
          source: "command",
          template: "Triage these issues: $ARGUMENTS",
        },
      },
    });

    const command = await resolveCommand(config, "triage");
    expect(command).not.toBeNull();
    expect(command?.name).toBe("triage");
    expect(command?.description).toBe("triage issues");
    expect(command?.hints).toContain("$ARGUMENTS");
  });

  test("resolveCommand strips skill front matter and exposes skill metadata", async () => {
    const skillsRoot = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-command-skills-"));
    const skillDir = path.join(skillsRoot, "release-notes");
    await fs.mkdir(skillDir, { recursive: true });
    await fs.writeFile(
      path.join(skillDir, "SKILL.md"),
      `---
name: release-notes
description: Draft release notes
---
Summarize these commits for release notes.

$ARGUMENTS
`,
      "utf-8",
    );

    const command = await resolveCommand(makeConfig({ skillsDirs: [skillsRoot] }), "release-notes");
    expect(command).not.toBeNull();
    expect(command?.source).toBe("skill");
    expect(command?.description).toBe("Draft release notes");
    expect(command?.template).toBe("Summarize these commits for release notes.\n\n$ARGUMENTS");
    expect(command?.hints).toEqual(["$ARGUMENTS"]);
  });

  test("resolveCommand lets config commands override built-in command templates", async () => {
    const config = makeConfig({
      command: {
        review: {
          description: "custom review flow",
          source: "command",
          template: "Custom review for $1",
        },
      },
    });

    const command = await resolveCommand(config, "review");
    expect(command).not.toBeNull();
    expect(command?.source).toBe("command");
    expect(command?.description).toBe("custom review flow");
    expect(command?.template).toBe("Custom review for $1");
  });

  test("expandCommandTemplate preserves quoted arguments as single placeholder tokens", () => {
    expect(expandCommandTemplate("Compare $1 against $2", '"release branch" main')).toBe(
      "Compare release branch against main",
    );
  });
});
