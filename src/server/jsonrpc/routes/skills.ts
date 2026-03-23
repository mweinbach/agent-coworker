import type { ServerEvent } from "../../protocol";

import {
  captureWorkspaceControlMutationError,
  captureWorkspaceControlOutcome,
  sendSessionMutationError,
} from "./outcomes";
import { toJsonRpcParams } from "./shared";
import type { JsonRpcRequestHandlerMap, JsonRpcRouteContext } from "./types";

export function createSkillsRouteHandlers(
  context: JsonRpcRouteContext,
): JsonRpcRequestHandlerMap {
  return {
    "cowork/skills/catalog/read": async (ws, message) => {
      const params = toJsonRpcParams(message.params);
      const cwd = context.utils.requireWorkspacePath(params, message.method);
      const event = await captureWorkspaceControlOutcome(
        context,
        cwd,
        async (session) => await session.getSkillsCatalog(),
        (event): event is Extract<ServerEvent, { type: "skills_catalog" }> => event.type === "skills_catalog",
      );
      if (context.utils.isSessionError(event)) {
        sendSessionMutationError(context, ws, message.id, event);
        return;
      }
      context.jsonrpc.sendResult(ws, message.id, { event });
    },

    "cowork/skills/list": async (ws, message) => {
      const params = toJsonRpcParams(message.params);
      const cwd = context.utils.requireWorkspacePath(params, message.method);
      const event = await captureWorkspaceControlOutcome(
        context,
        cwd,
        async (session) => await session.listSkills(),
        (event): event is Extract<ServerEvent, { type: "skills_list" }> => event.type === "skills_list",
      );
      if (context.utils.isSessionError(event)) {
        sendSessionMutationError(context, ws, message.id, event);
        return;
      }
      context.jsonrpc.sendResult(ws, message.id, { event });
    },

    "cowork/skills/read": async (ws, message) => {
      const params = toJsonRpcParams(message.params);
      const cwd = context.utils.requireWorkspacePath(params, message.method);
      const skillName = typeof params.skillName === "string" ? params.skillName.trim() : "";
      const event = await captureWorkspaceControlOutcome(
        context,
        cwd,
        async (session) => await session.readSkill(skillName),
        (event): event is Extract<ServerEvent, { type: "skill_content" }> =>
          event.type === "skill_content" && event.skill.name === skillName,
      );
      if (context.utils.isSessionError(event)) {
        sendSessionMutationError(context, ws, message.id, event);
        return;
      }
      context.jsonrpc.sendResult(ws, message.id, { event });
    },

    "cowork/skills/disable": async (ws, message) => {
      const params = toJsonRpcParams(message.params);
      const cwd = context.utils.requireWorkspacePath(params, message.method);
      const skillName = typeof params.skillName === "string" ? params.skillName.trim() : "";
      const outcome = await captureWorkspaceControlMutationError(
        context,
        cwd,
        async (session) => await session.disableSkill(skillName),
      );
      if (outcome) {
        sendSessionMutationError(context, ws, message.id, outcome);
        return;
      }
      const event = await captureWorkspaceControlOutcome(
        context,
        cwd,
        async (session) => await session.listSkills(),
        (event): event is Extract<ServerEvent, { type: "skills_list" }> => event.type === "skills_list",
      );
      if (context.utils.isSessionError(event)) {
        sendSessionMutationError(context, ws, message.id, event);
        return;
      }
      context.jsonrpc.sendResult(ws, message.id, { event });
    },

    "cowork/skills/enable": async (ws, message) => {
      const params = toJsonRpcParams(message.params);
      const cwd = context.utils.requireWorkspacePath(params, message.method);
      const skillName = typeof params.skillName === "string" ? params.skillName.trim() : "";
      const outcome = await captureWorkspaceControlMutationError(
        context,
        cwd,
        async (session) => await session.enableSkill(skillName),
      );
      if (outcome) {
        sendSessionMutationError(context, ws, message.id, outcome);
        return;
      }
      const event = await captureWorkspaceControlOutcome(
        context,
        cwd,
        async (session) => await session.listSkills(),
        (event): event is Extract<ServerEvent, { type: "skills_list" }> => event.type === "skills_list",
      );
      if (context.utils.isSessionError(event)) {
        sendSessionMutationError(context, ws, message.id, event);
        return;
      }
      context.jsonrpc.sendResult(ws, message.id, { event });
    },

    "cowork/skills/delete": async (ws, message) => {
      const params = toJsonRpcParams(message.params);
      const cwd = context.utils.requireWorkspacePath(params, message.method);
      const skillName = typeof params.skillName === "string" ? params.skillName.trim() : "";
      const outcome = await captureWorkspaceControlMutationError(
        context,
        cwd,
        async (session) => await session.deleteSkill(skillName),
      );
      if (outcome) {
        sendSessionMutationError(context, ws, message.id, outcome);
        return;
      }
      const event = await captureWorkspaceControlOutcome(
        context,
        cwd,
        async (session) => await session.listSkills(),
        (event): event is Extract<ServerEvent, { type: "skills_list" }> => event.type === "skills_list",
      );
      if (context.utils.isSessionError(event)) {
        sendSessionMutationError(context, ws, message.id, event);
        return;
      }
      context.jsonrpc.sendResult(ws, message.id, { event });
    },

    "cowork/skills/installation/read": async (ws, message) => {
      const params = toJsonRpcParams(message.params);
      const cwd = context.utils.requireWorkspacePath(params, message.method);
      const installationId = typeof params.installationId === "string" ? params.installationId.trim() : "";
      const event = await captureWorkspaceControlOutcome(
        context,
        cwd,
        async (session) => await session.getSkillInstallation(installationId),
        (event): event is Extract<ServerEvent, { type: "skill_installation" }> => event.type === "skill_installation",
      );
      if (context.utils.isSessionError(event)) {
        sendSessionMutationError(context, ws, message.id, event);
        return;
      }
      context.jsonrpc.sendResult(ws, message.id, { event });
    },

    "cowork/skills/install/preview": async (ws, message) => {
      const params = toJsonRpcParams(message.params);
      const cwd = context.utils.requireWorkspacePath(params, message.method);
      const sourceInput = typeof params.sourceInput === "string" ? params.sourceInput : "";
      const targetScope = params.targetScope === "global" ? "global" : "project";
      const event = await captureWorkspaceControlOutcome(
        context,
        cwd,
        async (session) => await session.previewSkillInstall(sourceInput, targetScope),
        (event): event is Extract<ServerEvent, { type: "skill_install_preview" }> => event.type === "skill_install_preview",
      );
      if (context.utils.isSessionError(event)) {
        sendSessionMutationError(context, ws, message.id, event);
        return;
      }
      context.jsonrpc.sendResult(ws, message.id, { event });
    },

    "cowork/skills/install": async (ws, message) => {
      const params = toJsonRpcParams(message.params);
      const cwd = context.utils.requireWorkspacePath(params, message.method);
      const sourceInput = typeof params.sourceInput === "string" ? params.sourceInput : "";
      const targetScope = params.targetScope === "global" ? "global" : "project";
      const event = await captureWorkspaceControlOutcome(
        context,
        cwd,
        async (session) => await session.installSkills(sourceInput, targetScope),
        (event): event is Extract<ServerEvent, { type: "skills_catalog" }> => event.type === "skills_catalog",
      );
      if (context.utils.isSessionError(event)) {
        sendSessionMutationError(context, ws, message.id, event);
        return;
      }
      context.jsonrpc.sendResult(ws, message.id, { event });
    },

    "cowork/skills/installation/enable": async (ws, message) => {
      const params = toJsonRpcParams(message.params);
      const cwd = context.utils.requireWorkspacePath(params, message.method);
      const installationId = typeof params.installationId === "string" ? params.installationId.trim() : "";
      const event = await captureWorkspaceControlOutcome(
        context,
        cwd,
        async (session) => {
          await session.enableSkillInstallation(installationId);
        },
        (event): event is Extract<ServerEvent, { type: "skills_catalog" }> => event.type === "skills_catalog",
      );
      if (context.utils.isSessionError(event)) {
        sendSessionMutationError(context, ws, message.id, event);
        return;
      }
      context.jsonrpc.sendResult(ws, message.id, { event });
    },

    "cowork/skills/installation/disable": async (ws, message) => {
      const params = toJsonRpcParams(message.params);
      const cwd = context.utils.requireWorkspacePath(params, message.method);
      const installationId = typeof params.installationId === "string" ? params.installationId.trim() : "";
      const event = await captureWorkspaceControlOutcome(
        context,
        cwd,
        async (session) => {
          await session.disableSkillInstallation(installationId);
        },
        (event): event is Extract<ServerEvent, { type: "skills_catalog" }> => event.type === "skills_catalog",
      );
      if (context.utils.isSessionError(event)) {
        sendSessionMutationError(context, ws, message.id, event);
        return;
      }
      context.jsonrpc.sendResult(ws, message.id, { event });
    },

    "cowork/skills/installation/delete": async (ws, message) => {
      const params = toJsonRpcParams(message.params);
      const cwd = context.utils.requireWorkspacePath(params, message.method);
      const installationId = typeof params.installationId === "string" ? params.installationId.trim() : "";
      const event = await captureWorkspaceControlOutcome(
        context,
        cwd,
        async (session) => {
          await session.deleteSkillInstallation(installationId);
        },
        (event): event is Extract<ServerEvent, { type: "skills_catalog" }> => event.type === "skills_catalog",
      );
      if (context.utils.isSessionError(event)) {
        sendSessionMutationError(context, ws, message.id, event);
        return;
      }
      context.jsonrpc.sendResult(ws, message.id, { event });
    },

    "cowork/skills/installation/update": async (ws, message) => {
      const params = toJsonRpcParams(message.params);
      const cwd = context.utils.requireWorkspacePath(params, message.method);
      const installationId = typeof params.installationId === "string" ? params.installationId.trim() : "";
      const event = await captureWorkspaceControlOutcome(
        context,
        cwd,
        async (session) => {
          await session.updateSkillInstallation(installationId);
        },
        (event): event is Extract<ServerEvent, { type: "skills_catalog" }> => event.type === "skills_catalog",
      );
      if (context.utils.isSessionError(event)) {
        sendSessionMutationError(context, ws, message.id, event);
        return;
      }
      context.jsonrpc.sendResult(ws, message.id, { event });
    },

    "cowork/skills/installation/copy": async (ws, message) => {
      const params = toJsonRpcParams(message.params);
      const cwd = context.utils.requireWorkspacePath(params, message.method);
      const installationId = typeof params.installationId === "string" ? params.installationId.trim() : "";
      const targetScope = params.targetScope === "global" ? "global" : "project";
      const event = await captureWorkspaceControlOutcome(
        context,
        cwd,
        async (session) => await session.copySkillInstallation(installationId, targetScope),
        (event): event is Extract<ServerEvent, { type: "skills_catalog" }> => event.type === "skills_catalog",
      );
      if (context.utils.isSessionError(event)) {
        sendSessionMutationError(context, ws, message.id, event);
        return;
      }
      context.jsonrpc.sendResult(ws, message.id, { event });
    },

    "cowork/skills/installation/checkUpdate": async (ws, message) => {
      const params = toJsonRpcParams(message.params);
      const cwd = context.utils.requireWorkspacePath(params, message.method);
      const installationId = typeof params.installationId === "string" ? params.installationId.trim() : "";
      const event = await captureWorkspaceControlOutcome(
        context,
        cwd,
        async (session) => await session.checkSkillInstallationUpdate(installationId),
        (event): event is Extract<ServerEvent, { type: "skill_installation_update_check" }> =>
          event.type === "skill_installation_update_check",
      );
      if (context.utils.isSessionError(event)) {
        sendSessionMutationError(context, ws, message.id, event);
        return;
      }
      context.jsonrpc.sendResult(ws, message.id, { event });
    },
  };
}
