import type { ServerEvent } from "../../protocol";
import type { AgentSession } from "../../session/AgentSession";
import { JSONRPC_ERROR_CODES } from "../protocol";

import { toJsonRpcParams } from "./shared";
import type { JsonRpcRequestHandlerMap, JsonRpcRouteContext } from "./types";

type JsonRpcSessionError = Extract<ServerEvent, { type: "error" }>;
type JsonRpcSessionOutcome<T extends ServerEvent> = T | JsonRpcSessionError;

async function captureWorkspaceControlEvent<T extends ServerEvent>(
  context: JsonRpcRouteContext,
  cwd: string,
  action: (session: AgentSession) => Promise<void> | void,
  predicate: (event: ServerEvent) => event is T,
): Promise<T> {
  return await context.workspaceControl.withSession(cwd, async (binding, session) =>
    await context.events.capture(
      binding,
      async () => await action(session),
      predicate,
    )
  );
}

async function captureWorkspaceControlOutcome<T extends ServerEvent>(
  context: JsonRpcRouteContext,
  cwd: string,
  action: (session: AgentSession) => Promise<void> | void,
  predicate: (event: ServerEvent) => event is T,
): Promise<JsonRpcSessionOutcome<T>> {
  return await context.workspaceControl.withSession(cwd, async (binding, session) =>
    await context.events.capture(
      binding,
      async () => await action(session),
      (event): event is JsonRpcSessionOutcome<T> => predicate(event) || context.utils.isSessionError(event),
    )
  );
}

async function captureWorkspaceControlMutationError(
  context: JsonRpcRouteContext,
  cwd: string,
  action: (session: AgentSession) => Promise<void> | void,
): Promise<JsonRpcSessionError | null> {
  return await context.workspaceControl.withSession(cwd, async (binding, session) =>
    await context.events.captureMutationOutcome(
      binding,
      async () => await action(session),
      context.utils.isSessionError,
    )
  );
}

function sendSessionMutationError(
  context: JsonRpcRouteContext,
  ws: Parameters<JsonRpcRouteContext["jsonrpc"]["send"]>[0],
  id: string | number | null,
  event: JsonRpcSessionError,
) {
  context.jsonrpc.sendError(ws, id, {
    code: JSONRPC_ERROR_CODES.invalidRequest,
    message: event.message,
  });
}

export function createSkillsMemoryAndWorkspaceBackupRouteHandlers(
  context: JsonRpcRouteContext,
): JsonRpcRequestHandlerMap {
  return {
    "cowork/skills/catalog/read": async (ws, message) => {
      const params = toJsonRpcParams(message.params);
      const cwd = context.utils.requireWorkspacePath(params, message.method);
      const event = await captureWorkspaceControlEvent(
        context,
        cwd,
        async (session) => await session.getSkillsCatalog(),
        (event): event is Extract<ServerEvent, { type: "skills_catalog" }> => event.type === "skills_catalog",
      );
      context.jsonrpc.sendResult(ws, message.id, { event });
    },

    "cowork/skills/list": async (ws, message) => {
      const params = toJsonRpcParams(message.params);
      const cwd = context.utils.requireWorkspacePath(params, message.method);
      const event = await captureWorkspaceControlEvent(
        context,
        cwd,
        async (session) => await session.listSkills(),
        (event): event is Extract<ServerEvent, { type: "skills_list" }> => event.type === "skills_list",
      );
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
      const event = await captureWorkspaceControlEvent(
        context,
        cwd,
        async (session) => await session.listSkills(),
        (event): event is Extract<ServerEvent, { type: "skills_list" }> => event.type === "skills_list",
      );
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
      const event = await captureWorkspaceControlEvent(
        context,
        cwd,
        async (session) => await session.listSkills(),
        (event): event is Extract<ServerEvent, { type: "skills_list" }> => event.type === "skills_list",
      );
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
      const event = await captureWorkspaceControlEvent(
        context,
        cwd,
        async (session) => await session.listSkills(),
        (event): event is Extract<ServerEvent, { type: "skills_list" }> => event.type === "skills_list",
      );
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
      const event = await captureWorkspaceControlEvent(
        context,
        cwd,
        async (session) => await session.previewSkillInstall(sourceInput, targetScope),
        (event): event is Extract<ServerEvent, { type: "skill_install_preview" }> => event.type === "skill_install_preview",
      );
      context.jsonrpc.sendResult(ws, message.id, { event });
    },

    "cowork/skills/install": async (ws, message) => {
      const params = toJsonRpcParams(message.params);
      const cwd = context.utils.requireWorkspacePath(params, message.method);
      const sourceInput = typeof params.sourceInput === "string" ? params.sourceInput : "";
      const targetScope = params.targetScope === "global" ? "global" : "project";
      const event = await captureWorkspaceControlEvent(
        context,
        cwd,
        async (session) => await session.installSkills(sourceInput, targetScope),
        (event): event is Extract<ServerEvent, { type: "skills_catalog" }> => event.type === "skills_catalog",
      );
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
      const event = await captureWorkspaceControlEvent(
        context,
        cwd,
        async (session) => await session.copySkillInstallation(installationId, targetScope),
        (event): event is Extract<ServerEvent, { type: "skills_catalog" }> => event.type === "skills_catalog",
      );
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

    "cowork/memory/list": async (ws, message) => {
      const params = toJsonRpcParams(message.params);
      const cwd = context.utils.requireWorkspacePath(params, message.method);
      const scope = params.scope === "user" ? "user" : params.scope === "workspace" ? "workspace" : undefined;
      const event = await captureWorkspaceControlOutcome(
        context,
        cwd,
        async (session) => await session.emitMemories(scope),
        (event): event is Extract<ServerEvent, { type: "memory_list" }> => event.type === "memory_list",
      );
      if (context.utils.isSessionError(event)) {
        sendSessionMutationError(context, ws, message.id, event);
        return;
      }
      context.jsonrpc.sendResult(ws, message.id, { event });
    },

    "cowork/memory/upsert": async (ws, message) => {
      const params = toJsonRpcParams(message.params);
      const cwd = context.utils.requireWorkspacePath(params, message.method);
      const scope = params.scope === "user" ? "user" : "workspace";
      const id = typeof params.id === "string" && params.id.trim() ? params.id.trim() : undefined;
      const content = typeof params.content === "string" ? params.content : "";
      const event = await captureWorkspaceControlOutcome(
        context,
        cwd,
        async (session) => await session.upsertMemory(scope, id, content),
        (event): event is Extract<ServerEvent, { type: "memory_list" }> => event.type === "memory_list",
      );
      if (context.utils.isSessionError(event)) {
        sendSessionMutationError(context, ws, message.id, event);
        return;
      }
      context.jsonrpc.sendResult(ws, message.id, { event });
    },

    "cowork/memory/delete": async (ws, message) => {
      const params = toJsonRpcParams(message.params);
      const cwd = context.utils.requireWorkspacePath(params, message.method);
      const scope = params.scope === "user" ? "user" : "workspace";
      const id = typeof params.id === "string" ? params.id.trim() : "";
      const event = await captureWorkspaceControlOutcome(
        context,
        cwd,
        async (session) => await session.deleteMemory(scope, id),
        (event): event is Extract<ServerEvent, { type: "memory_list" }> => event.type === "memory_list",
      );
      if (context.utils.isSessionError(event)) {
        sendSessionMutationError(context, ws, message.id, event);
        return;
      }
      context.jsonrpc.sendResult(ws, message.id, { event });
    },

    "cowork/backups/workspace/read": async (ws, message) => {
      const params = toJsonRpcParams(message.params);
      const cwd = context.utils.requireWorkspacePath(params, message.method);
      const event = await captureWorkspaceControlOutcome(
        context,
        cwd,
        async (session) => await session.listWorkspaceBackups(),
        (event): event is Extract<ServerEvent, { type: "workspace_backups" }> => event.type === "workspace_backups",
      );
      if (context.utils.isSessionError(event)) {
        sendSessionMutationError(context, ws, message.id, event);
        return;
      }
      context.jsonrpc.sendResult(ws, message.id, { event });
    },

    "cowork/backups/workspace/delta/read": async (ws, message) => {
      const params = toJsonRpcParams(message.params);
      const cwd = context.utils.requireWorkspacePath(params, message.method);
      const targetSessionId = typeof params.targetSessionId === "string" ? params.targetSessionId.trim() : "";
      const checkpointId = typeof params.checkpointId === "string" ? params.checkpointId.trim() : "";
      const event = await captureWorkspaceControlOutcome(
        context,
        cwd,
        async (session) => await session.getWorkspaceBackupDelta(targetSessionId, checkpointId),
        (event): event is Extract<ServerEvent, { type: "workspace_backup_delta" }> => event.type === "workspace_backup_delta",
      );
      if (context.utils.isSessionError(event)) {
        sendSessionMutationError(context, ws, message.id, event);
        return;
      }
      context.jsonrpc.sendResult(ws, message.id, { event });
    },

    "cowork/backups/workspace/checkpoint": async (ws, message) => {
      const params = toJsonRpcParams(message.params);
      const cwd = context.utils.requireWorkspacePath(params, message.method);
      const targetSessionId = typeof params.targetSessionId === "string" ? params.targetSessionId.trim() : "";
      const event = await captureWorkspaceControlOutcome(
        context,
        cwd,
        async (session) => {
          await session.createWorkspaceBackupCheckpoint(targetSessionId);
        },
        (event): event is Extract<ServerEvent, { type: "workspace_backups" }> => event.type === "workspace_backups",
      );
      if (context.utils.isSessionError(event)) {
        sendSessionMutationError(context, ws, message.id, event);
        return;
      }
      context.jsonrpc.sendResult(ws, message.id, { event });
    },

    "cowork/backups/workspace/restore": async (ws, message) => {
      const params = toJsonRpcParams(message.params);
      const cwd = context.utils.requireWorkspacePath(params, message.method);
      const targetSessionId = typeof params.targetSessionId === "string" ? params.targetSessionId.trim() : "";
      const checkpointId = typeof params.checkpointId === "string" && params.checkpointId.trim()
        ? params.checkpointId.trim()
        : undefined;
      const event = await captureWorkspaceControlOutcome(
        context,
        cwd,
        async (session) => {
          await session.restoreWorkspaceBackup(targetSessionId, checkpointId);
        },
        (event): event is Extract<ServerEvent, { type: "workspace_backups" }> => event.type === "workspace_backups",
      );
      if (context.utils.isSessionError(event)) {
        sendSessionMutationError(context, ws, message.id, event);
        return;
      }
      context.jsonrpc.sendResult(ws, message.id, { event });
    },

    "cowork/backups/workspace/deleteCheckpoint": async (ws, message) => {
      const params = toJsonRpcParams(message.params);
      const cwd = context.utils.requireWorkspacePath(params, message.method);
      const targetSessionId = typeof params.targetSessionId === "string" ? params.targetSessionId.trim() : "";
      const checkpointId = typeof params.checkpointId === "string" && params.checkpointId.trim()
        ? params.checkpointId.trim()
        : undefined;
      const event = await captureWorkspaceControlOutcome(
        context,
        cwd,
        async (session) => {
          if (checkpointId) {
            await session.deleteWorkspaceBackupCheckpoint(targetSessionId, checkpointId);
          }
        },
        (event): event is Extract<ServerEvent, { type: "workspace_backups" }> => event.type === "workspace_backups",
      );
      if (context.utils.isSessionError(event)) {
        sendSessionMutationError(context, ws, message.id, event);
        return;
      }
      context.jsonrpc.sendResult(ws, message.id, { event });
    },

    "cowork/backups/workspace/deleteEntry": async (ws, message) => {
      const params = toJsonRpcParams(message.params);
      const cwd = context.utils.requireWorkspacePath(params, message.method);
      const targetSessionId = typeof params.targetSessionId === "string" ? params.targetSessionId.trim() : "";
      const event = await captureWorkspaceControlOutcome(
        context,
        cwd,
        async (session) => {
          await session.deleteWorkspaceBackupEntry(targetSessionId);
        },
        (event): event is Extract<ServerEvent, { type: "workspace_backups" }> => event.type === "workspace_backups",
      );
      if (context.utils.isSessionError(event)) {
        sendSessionMutationError(context, ws, message.id, event);
        return;
      }
      context.jsonrpc.sendResult(ws, message.id, { event });
    },
  };
}
