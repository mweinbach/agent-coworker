import fs from "node:fs/promises";
import path from "node:path";

import { discoverSkills, stripSkillFrontMatter } from "../../skills";
import { createTools } from "../../tools";
import { expandCommandTemplate, listCommands as listServerCommands, resolveCommand } from "../commands";
import type { SessionContext } from "./SessionContext";

export class SkillManager {
  constructor(
    private readonly context: SessionContext,
    private readonly handlers: {
      sendUserMessage: (text: string, clientMessageId?: string, displayText?: string) => Promise<void>;
    }
  ) {}

  listTools() {
    const toolMap = createTools({
      config: this.context.state.config,
      log: () => {},
      askUser: async () => "",
      approveCommand: async () => false,
    });

    const tools = Object.entries(toolMap)
      .map(([name, def]) => {
        const raw = typeof def?.description === "string" ? def.description : "";
        const description = raw.split("\n")[0] || name;
        return { name, description };
      })
      .sort((a, b) => a.name.localeCompare(b.name));

    this.context.emit({ type: "tools", sessionId: this.context.id, tools });
  }

  async listCommands() {
    try {
      const commands = await listServerCommands(this.context.state.config);
      this.context.emit({ type: "commands", sessionId: this.context.id, commands });
    } catch (err) {
      this.context.emitError("internal_error", "session", `Failed to list commands: ${String(err)}`);
    }
  }

  async executeCommand(nameRaw: string, argumentsText = "", clientMessageId?: string) {
    const name = nameRaw.trim();
    if (!name) {
      this.context.emitError("validation_failed", "session", "Command name is required");
      return;
    }

    const resolved = await resolveCommand(this.context.state.config, name);
    if (!resolved) {
      this.context.emitError("validation_failed", "session", `Unknown command: ${name}`);
      return;
    }

    const expanded = expandCommandTemplate(resolved.template, argumentsText);
    if (!expanded.trim()) {
      this.context.emitError("validation_failed", "session", `Command "${name}" expanded to empty prompt`);
      return;
    }

    const trimmedArgs = argumentsText.trim();
    const slashText = `/${resolved.name}${trimmedArgs ? ` ${trimmedArgs}` : ""}`;
    await this.handlers.sendUserMessage(expanded, clientMessageId, slashText);
  }

  async listSkills() {
    try {
      const skills = await discoverSkills(this.context.state.config.skillsDirs, { includeDisabled: true });
      this.context.emit({ type: "skills_list", sessionId: this.context.id, skills });
    } catch (err) {
      this.context.emitError("internal_error", "session", `Failed to list skills: ${String(err)}`);
    }
  }

  async readSkill(skillNameRaw: string) {
    const skillName = skillNameRaw.trim();
    if (!skillName) {
      this.context.emitError("validation_failed", "session", "Skill name is required");
      return;
    }

    try {
      const skills = await discoverSkills(this.context.state.config.skillsDirs, { includeDisabled: true });
      const skill = skills.find((s) => s.name === skillName);
      if (!skill) {
        this.context.emitError("validation_failed", "session", `Skill "${skillName}" not found.`);
        return;
      }

      const content = await fs.readFile(skill.path, "utf-8");
      this.context.emit({ type: "skill_content", sessionId: this.context.id, skill, content: stripSkillFrontMatter(content) });
    } catch (err) {
      this.context.emitError("internal_error", "session", `Failed to read skill: ${String(err)}`);
    }
  }

  async disableSkill(skillNameRaw: string) {
    const skillName = skillNameRaw.trim();
    if (!skillName) {
      this.context.emitError("validation_failed", "session", "Skill name is required");
      return;
    }
    if (this.context.state.running) {
      this.context.emitError("busy", "session", "Agent is busy");
      return;
    }

    const { enabledDir, disabledDir } = this.globalSkillsDirs();
    if (!enabledDir || !disabledDir) {
      this.context.emitError("validation_failed", "session", "Global skills directory is not configured.");
      return;
    }

    try {
      const skills = await discoverSkills(this.context.state.config.skillsDirs, { includeDisabled: true });
      const skill = skills.find((s) => s.name === skillName);
      if (!skill) {
        this.context.emitError("validation_failed", "session", `Skill "${skillName}" not found.`);
        return;
      }
      if (skill.source !== "global") {
        this.context.emitError("validation_failed", "session", "Only global skills can be disabled in v1.");
        return;
      }
      if (!skill.enabled) {
        await this.refreshSkillsList();
        return;
      }

      await fs.mkdir(disabledDir, { recursive: true });
      const from = path.join(enabledDir, skillName);
      const to = path.join(disabledDir, skillName);
      await fs.rename(from, to);
      await this.refreshSkillsList();
    } catch (err) {
      this.context.emitError("internal_error", "session", `Failed to disable skill: ${String(err)}`);
    }
  }

  async enableSkill(skillNameRaw: string) {
    const skillName = skillNameRaw.trim();
    if (!skillName) {
      this.context.emitError("validation_failed", "session", "Skill name is required");
      return;
    }
    if (this.context.state.running) {
      this.context.emitError("busy", "session", "Agent is busy");
      return;
    }

    const { enabledDir, disabledDir } = this.globalSkillsDirs();
    if (!enabledDir || !disabledDir) {
      this.context.emitError("validation_failed", "session", "Global skills directory is not configured.");
      return;
    }

    try {
      const skills = await discoverSkills(this.context.state.config.skillsDirs, { includeDisabled: true });
      const skill = skills.find((s) => s.name === skillName);
      if (!skill) {
        this.context.emitError("validation_failed", "session", `Skill "${skillName}" not found.`);
        return;
      }
      if (skill.source !== "global") {
        this.context.emitError("validation_failed", "session", "Only global skills can be enabled in v1.");
        return;
      }
      if (skill.enabled) {
        await this.refreshSkillsList();
        return;
      }

      await fs.mkdir(enabledDir, { recursive: true });
      const from = path.join(disabledDir, skillName);
      const to = path.join(enabledDir, skillName);
      await fs.rename(from, to);
      await this.refreshSkillsList();
    } catch (err) {
      this.context.emitError("internal_error", "session", `Failed to enable skill: ${String(err)}`);
    }
  }

  async deleteSkill(skillNameRaw: string) {
    const skillName = skillNameRaw.trim();
    if (!skillName) {
      this.context.emitError("validation_failed", "session", "Skill name is required");
      return;
    }
    if (this.context.state.running) {
      this.context.emitError("busy", "session", "Agent is busy");
      return;
    }

    try {
      const skills = await discoverSkills(this.context.state.config.skillsDirs, { includeDisabled: true });
      const skill = skills.find((s) => s.name === skillName);
      if (!skill) {
        this.context.emitError("validation_failed", "session", `Skill "${skillName}" not found.`);
        return;
      }
      if (skill.source !== "global") {
        this.context.emitError("validation_failed", "session", "Only global skills can be deleted in v1.");
        return;
      }

      const skillDir = path.dirname(skill.path);
      await fs.rm(skillDir, { recursive: true, force: true });
      await this.refreshSkillsList();
    } catch (err) {
      this.context.emitError("internal_error", "session", `Failed to delete skill: ${String(err)}`);
    }
  }

  private globalSkillsDirs(): { enabledDir: string | null; disabledDir: string | null } {
    const enabledDir = this.context.state.config.skillsDirs.length >= 2 ? this.context.state.config.skillsDirs[1]! : null;
    if (!enabledDir) return { enabledDir: null, disabledDir: null };
    return { enabledDir, disabledDir: path.join(path.dirname(enabledDir), "disabled-skills") };
  }

  private async refreshSkillsList() {
    const skills = await discoverSkills(this.context.state.config.skillsDirs, { includeDisabled: true });
    this.context.state.discoveredSkills = skills
      .filter((s) => s.enabled)
      .map((s) => ({ name: s.name, description: s.description }));
    this.context.emit({ type: "skills_list", sessionId: this.context.id, skills });
    await this.listCommands();
  }
}
