import type { LegacyClientMessageHandlerMap } from "./dispatchClientMessage.shared";

export function createSkillsClientMessageHandlers(): Pick<
  LegacyClientMessageHandlerMap,
  | "list_skills"
  | "read_skill"
  | "disable_skill"
  | "enable_skill"
  | "delete_skill"
  | "skills_catalog_get"
  | "skill_installation_get"
  | "skill_install_preview"
  | "skill_install"
  | "skill_installation_enable"
  | "skill_installation_disable"
  | "skill_installation_delete"
  | "skill_installation_copy"
  | "skill_installation_check_update"
  | "skill_installation_update"
> {
  return {
    list_skills: ({ session }) =>
      void session.listSkills(),
    read_skill: ({ session, message }) =>
      void session.readSkill(message.skillName),
    disable_skill: ({ session, message }) =>
      void session.disableSkill(message.skillName),
    enable_skill: ({ session, message }) =>
      void session.enableSkill(message.skillName),
    delete_skill: ({ session, message }) =>
      void session.deleteSkill(message.skillName),
    skills_catalog_get: ({ session }) =>
      void session.getSkillsCatalog(),
    skill_installation_get: ({ session, message }) =>
      void session.getSkillInstallation(message.installationId),
    skill_install_preview: ({ session, message }) =>
      void session.previewSkillInstall(message.sourceInput, message.targetScope),
    skill_install: ({ session, message }) =>
      void session.installSkills(message.sourceInput, message.targetScope),
    skill_installation_enable: ({ session, message }) =>
      void session.enableSkillInstallation(message.installationId),
    skill_installation_disable: ({ session, message }) =>
      void session.disableSkillInstallation(message.installationId),
    skill_installation_delete: ({ session, message }) =>
      void session.deleteSkillInstallation(message.installationId),
    skill_installation_copy: ({ session, message }) =>
      void session.copySkillInstallation(message.installationId, message.targetScope),
    skill_installation_check_update: ({ session, message }) =>
      void session.checkSkillInstallationUpdate(message.installationId),
    skill_installation_update: ({ session, message }) =>
      void session.updateSkillInstallation(message.installationId),
  };
}
