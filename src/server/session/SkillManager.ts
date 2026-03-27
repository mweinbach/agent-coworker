import fs from "node:fs/promises";

import type { SkillInstallationEntry, SkillMutationTargetScope } from "../../types";
import { getEffectiveInstallationByName } from "../../skills/catalog";
import { discoverSkills, stripSkillFrontMatter } from "../../skills";
import {
  buildSkillInstallPreview,
} from "../../skills/sourceResolver";
import {
  checkSkillInstallationUpdate,
  copySkillInstallationToScope,
  deleteSkillInstallation,
  disableSkillInstallation,
  enableSkillInstallation,
  getSkillCatalog,
  getSkillInstallationById,
  installSkillsFromSource,
  updateSkillInstallation,
} from "../../skills/operations";
import { createTools } from "../../tools";
import { expandCommandTemplate, listCommands as listServerCommands, resolveCommand } from "../commands";
import type { SessionContext } from "./SessionContext";

export class SkillManager {
  constructor(
    private readonly context: SessionContext,
    private readonly handlers: {
      sendUserMessage: (text: string, clientMessageId?: string, displayText?: string, attachments?: import("../jsonrpc/routes/shared").FileAttachment[]) => Promise<void>;
    }
  ) {}

  private skillMutationPendingKey(action: string, id?: string): string {
    return id ? `${action}:${id}` : action;
  }

  private get mutationBlockReason(): string | null {
    return this.context.getSkillMutationBlockReason();
  }

  private async emitLegacySkillsList() {
    const skills = await discoverSkills(this.context.state.config.skillsDirs, { includeDisabled: true });
    this.context.state.discoveredSkills = skills
      .filter((skill) => skill.enabled)
      .map((skill) => ({ name: skill.name, description: skill.description }));
    this.context.emit({ type: "skills_list", sessionId: this.context.id, skills });
  }

  private async emitSkillsCatalog(clearedMutationPendingKeys: string[] = []) {
    const catalog = await getSkillCatalog(this.context.state.config);
    const mutationBlockedReason = this.mutationBlockReason;
    this.context.emit({
      type: "skills_catalog",
      sessionId: this.context.id,
      catalog,
      mutationBlocked: mutationBlockedReason !== null,
      ...(clearedMutationPendingKeys.length > 0 ? { clearedMutationPendingKeys } : {}),
      ...(mutationBlockedReason ? { mutationBlockedReason } : {}),
    });
  }

  private async readInstallationContent(installation: SkillInstallationEntry): Promise<string | null> {
    if (!installation.skillPath) {
      return null;
    }
    const content = await fs.readFile(installation.skillPath, "utf-8");
    return stripSkillFrontMatter(content);
  }

  private async emitInstallationDetail(installationId: string) {
    const installation = await getSkillInstallationById({
      config: this.context.state.config,
      installationId,
    });
    if (!installation) {
      this.context.emit({
        type: "skill_installation",
        sessionId: this.context.id,
        installation: null,
        content: null,
      });
      return;
    }

    const content = installation.skillPath ? await this.readInstallationContent(installation) : null;
    this.context.emit({
      type: "skill_installation",
      sessionId: this.context.id,
      installation,
      content,
    });
  }

  private async afterSuccessfulMutation({
    selectedInstallationId,
    clearedMutationPendingKeys = [],
  }: {
    selectedInstallationId?: string;
    clearedMutationPendingKeys?: string[];
  } = {}) {
    await this.context.refreshSkillsAcrossWorkspaceSessions();
    await this.emitLegacySkillsList();
    await this.listCommands();
    await this.emitSkillsCatalog(clearedMutationPendingKeys);
    if (selectedInstallationId) {
      await this.emitInstallationDetail(selectedInstallationId);
    }
  }

  private async withSkillMutationLock<T>(task: () => Promise<T>): Promise<T | void> {
    if (this.context.state.running) {
      this.context.emitError("busy", "session", "Agent is busy");
      return;
    }
    const reason = this.mutationBlockReason;
    if (reason) {
      this.context.emitError("busy", "session", reason);
      return;
    }
    return await task();
  }

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
      await this.emitLegacySkillsList();
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
    await this.withSkillMutationLock(async () => {
      try {
        const catalog = await getSkillCatalog(this.context.state.config);
        const installation =
          catalog.installations.find((entry) => entry.name === skillName && entry.enabled)
          ?? catalog.installations.find((entry) => entry.name === skillName);
        if (!installation) {
          this.context.emitError("validation_failed", "session", `Skill "${skillName}" not found.`);
          return;
        }
        if (!installation.writable) {
          this.context.emitError(
            "validation_failed",
            "session",
            "Only workspace or global skills can be disabled directly.",
          );
          return;
        }
        const nextCatalog = await disableSkillInstallation({
          config: this.context.state.config,
          installation,
        });
        const nextInstallation = getEffectiveInstallationByName(nextCatalog, installation.name)
          ?? nextCatalog.installations.find((entry) => entry.name === installation.name)
          ?? null;
        await this.afterSuccessfulMutation({ selectedInstallationId: nextInstallation?.installationId });
      } catch (err) {
        this.context.emitError("internal_error", "session", `Failed to disable skill: ${String(err)}`);
      }
    });
  }

  async enableSkill(skillNameRaw: string) {
    const skillName = skillNameRaw.trim();
    if (!skillName) {
      this.context.emitError("validation_failed", "session", "Skill name is required");
      return;
    }
    await this.withSkillMutationLock(async () => {
      try {
        const catalog = await getSkillCatalog(this.context.state.config);
        const installation =
          catalog.installations.find((entry) => entry.name === skillName && !entry.enabled)
          ?? catalog.installations.find((entry) => entry.name === skillName);
        if (!installation) {
          this.context.emitError("validation_failed", "session", `Skill "${skillName}" not found.`);
          return;
        }
        if (!installation.writable) {
          this.context.emitError(
            "validation_failed",
            "session",
            "Only workspace or global skills can be enabled directly.",
          );
          return;
        }
        const nextCatalog = await enableSkillInstallation({
          config: this.context.state.config,
          installation,
        });
        const nextInstallation = getEffectiveInstallationByName(nextCatalog, installation.name)
          ?? nextCatalog.installations.find((entry) => entry.name === installation.name)
          ?? null;
        await this.afterSuccessfulMutation({ selectedInstallationId: nextInstallation?.installationId });
      } catch (err) {
        this.context.emitError("internal_error", "session", `Failed to enable skill: ${String(err)}`);
      }
    });
  }

  async deleteSkill(skillNameRaw: string) {
    const skillName = skillNameRaw.trim();
    if (!skillName) {
      this.context.emitError("validation_failed", "session", "Skill name is required");
      return;
    }
    await this.withSkillMutationLock(async () => {
      try {
        const catalog = await getSkillCatalog(this.context.state.config);
        const installation = catalog.installations.find((entry) => entry.name === skillName);
        if (!installation) {
          this.context.emitError("validation_failed", "session", `Skill "${skillName}" not found.`);
          return;
        }
        if (!installation.writable) {
          this.context.emitError(
            "validation_failed",
            "session",
            "Only workspace or global skills can be deleted directly.",
          );
          return;
        }
        await deleteSkillInstallation({
          config: this.context.state.config,
          installation,
        });
        await this.afterSuccessfulMutation();
      } catch (err) {
        this.context.emitError("internal_error", "session", `Failed to delete skill: ${String(err)}`);
      }
    });
  }

  async getSkillsCatalog() {
    try {
      await this.emitSkillsCatalog();
    } catch (err) {
      this.context.emitError("internal_error", "session", `Failed to get skill catalog: ${String(err)}`);
    }
  }

  async getSkillInstallation(installationId: string) {
    const normalizedInstallationId = installationId.trim();
    if (!normalizedInstallationId) {
      this.context.emitError("validation_failed", "session", "Installation ID is required");
      return;
    }

    try {
      await this.emitInstallationDetail(normalizedInstallationId);
    } catch (err) {
      this.context.emitError("internal_error", "session", `Failed to read skill installation: ${String(err)}`);
    }
  }

  async previewSkillInstall(sourceInput: string, targetScope: SkillMutationTargetScope) {
    try {
      const preview = await buildSkillInstallPreview({
        input: sourceInput,
        targetScope,
        catalog: await getSkillCatalog(this.context.state.config),
        cwd: this.context.state.config.workingDirectory,
      });
      this.context.emit({
        type: "skill_install_preview",
        sessionId: this.context.id,
        preview,
        fromUserPreviewRequest: true,
      });
    } catch (err) {
      this.context.emitError("internal_error", "session", `Failed to preview skill install: ${String(err)}`);
    }
  }

  async installSkills(sourceInput: string, targetScope: SkillMutationTargetScope) {
    await this.withSkillMutationLock(async () => {
      try {
        const result = await installSkillsFromSource({
          config: this.context.state.config,
          input: sourceInput,
          targetScope,
        });
        this.context.emit({
          type: "skill_install_preview",
          sessionId: this.context.id,
          preview: result.preview,
          fromUserPreviewRequest: false,
        });
        await this.afterSuccessfulMutation({
          selectedInstallationId: result.installationIds[0],
          clearedMutationPendingKeys: [this.skillMutationPendingKey(`install:${targetScope}`)],
        });
      } catch (err) {
        this.context.emitError("internal_error", "session", `Failed to install skills: ${String(err)}`);
      }
    });
  }

  async enableSkillInstallation(installationId: string) {
    await this.withSkillMutationLock(async () => {
      try {
        const installation = await getSkillInstallationById({
          config: this.context.state.config,
          installationId,
        });
        if (!installation) {
          this.context.emitError("validation_failed", "session", `Skill installation "${installationId}" was not found`);
          return;
        }
        await enableSkillInstallation({
          config: this.context.state.config,
          installation,
        });
        await this.afterSuccessfulMutation({
          selectedInstallationId: installationId,
          clearedMutationPendingKeys: [this.skillMutationPendingKey("enable", installationId)],
        });
      } catch (err) {
        this.context.emitError("internal_error", "session", `Failed to enable skill installation: ${String(err)}`);
      }
    });
  }

  async disableSkillInstallation(installationId: string) {
    await this.withSkillMutationLock(async () => {
      try {
        const installation = await getSkillInstallationById({
          config: this.context.state.config,
          installationId,
        });
        if (!installation) {
          this.context.emitError("validation_failed", "session", `Skill installation "${installationId}" was not found`);
          return;
        }
        await disableSkillInstallation({
          config: this.context.state.config,
          installation,
        });
        await this.afterSuccessfulMutation({
          selectedInstallationId: installationId,
          clearedMutationPendingKeys: [this.skillMutationPendingKey("disable", installationId)],
        });
      } catch (err) {
        this.context.emitError("internal_error", "session", `Failed to disable skill installation: ${String(err)}`);
      }
    });
  }

  async deleteSkillInstallation(installationId: string) {
    await this.withSkillMutationLock(async () => {
      try {
        const installation = await getSkillInstallationById({
          config: this.context.state.config,
          installationId,
        });
        if (!installation) {
          this.context.emitError("validation_failed", "session", `Skill installation "${installationId}" was not found`);
          return;
        }
        await deleteSkillInstallation({
          config: this.context.state.config,
          installation,
        });
        await this.afterSuccessfulMutation({
          clearedMutationPendingKeys: [this.skillMutationPendingKey("delete", installationId)],
        });
      } catch (err) {
        this.context.emitError("internal_error", "session", `Failed to delete skill installation: ${String(err)}`);
      }
    });
  }

  async copySkillInstallation(installationId: string, targetScope: SkillMutationTargetScope) {
    await this.withSkillMutationLock(async () => {
      try {
        const installation = await getSkillInstallationById({
          config: this.context.state.config,
          installationId,
        });
        if (!installation) {
          this.context.emitError("validation_failed", "session", `Skill installation "${installationId}" was not found`);
          return;
        }
        const result = await copySkillInstallationToScope({
          config: this.context.state.config,
          installation,
          targetScope,
        });
        await this.afterSuccessfulMutation({
          selectedInstallationId: result.installationId,
          clearedMutationPendingKeys: [this.skillMutationPendingKey(`copy:${targetScope}`, installationId)],
        });
      } catch (err) {
        this.context.emitError("internal_error", "session", `Failed to copy skill installation: ${String(err)}`);
      }
    });
  }

  async checkSkillInstallationUpdate(installationId: string) {
    try {
      const installation = await getSkillInstallationById({
        config: this.context.state.config,
        installationId,
      });
      if (!installation) {
        this.context.emitError("validation_failed", "session", `Skill installation "${installationId}" was not found`);
        return;
      }
      const result = await checkSkillInstallationUpdate({
        config: this.context.state.config,
        installation,
      });
      this.context.emit({
        type: "skill_installation_update_check",
        sessionId: this.context.id,
        result,
      });
    } catch (err) {
      this.context.emitError("internal_error", "session", `Failed to check for skill update: ${String(err)}`);
    }
  }

  async updateSkillInstallation(installationId: string) {
    await this.withSkillMutationLock(async () => {
      try {
        const installation = await getSkillInstallationById({
          config: this.context.state.config,
          installationId,
        });
        if (!installation) {
          this.context.emitError("validation_failed", "session", `Skill installation "${installationId}" was not found`);
          return;
        }
        const result = await updateSkillInstallation({
          config: this.context.state.config,
          installation,
        });
        this.context.emit({
          type: "skill_install_preview",
          sessionId: this.context.id,
          preview: result.preview,
          fromUserPreviewRequest: false,
        });
        await this.afterSuccessfulMutation({
          selectedInstallationId: installationId,
          clearedMutationPendingKeys: [this.skillMutationPendingKey("update", installationId)],
        });
      } catch (err) {
        this.context.emitError("internal_error", "session", `Failed to update skill installation: ${String(err)}`);
      }
    });
  }
}
