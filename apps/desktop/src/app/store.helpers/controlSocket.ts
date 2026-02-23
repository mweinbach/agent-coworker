import { AgentSocket } from "../../lib/agentSocket";
import type { ClientMessage, ProviderName, ServerEvent } from "../../lib/wsProtocol";
import type { StoreGet, StoreSet } from "../store.helpers";
import type { Notification } from "../types";
import { RUNTIME } from "./runtimeState";

type ProviderStatusEvent = Extract<ServerEvent, { type: "provider_status" }>;
type ProviderStatus = ProviderStatusEvent["providers"][number];

type ControlSocketDeps = {
  nowIso: () => string;
  makeId: () => string;
  persist: (get: StoreGet) => void;
  pushNotification: (notifications: Notification[], entry: Notification) => Notification[];
  isProviderName: (value: unknown) => value is ProviderName;
};

export function createControlSocketHelpers(deps: ControlSocketDeps) {
  function ensureControlSocket(get: StoreGet, set: StoreSet, workspaceId: string) {
    const rt = get().workspaceRuntimeById[workspaceId];
    const url = rt?.serverUrl;
    if (!url) return;
    const resumeSessionId = rt?.controlSessionId ?? undefined;

    if (RUNTIME.controlSockets.has(workspaceId)) return;

    const socket = new AgentSocket({
      url,
      resumeSessionId,
      client: "desktop-control",
      version: "0.1.0",
      onEvent: (evt) => {
        if (evt.type === "server_hello") {
          set((s) => ({
            workspaceRuntimeById: {
              ...s.workspaceRuntimeById,
              [workspaceId]: {
                ...s.workspaceRuntimeById[workspaceId],
                controlSessionId: evt.sessionId,
                controlConfig: evt.config,
                controlSessionConfig: null,
              },
            },
            providerStatusRefreshing: true,
          }));

          try {
            socket.send({ type: "list_skills", sessionId: evt.sessionId });
            const selected = get().workspaceRuntimeById[workspaceId]?.selectedSkillName;
            if (selected) socket.send({ type: "read_skill", sessionId: evt.sessionId, skillName: selected });
            socket.send({ type: "provider_catalog_get", sessionId: evt.sessionId });
            socket.send({ type: "provider_auth_methods_get", sessionId: evt.sessionId });
            socket.send({ type: "refresh_provider_status", sessionId: evt.sessionId });
            socket.send({ type: "mcp_servers_get", sessionId: evt.sessionId });
          } catch {
            // ignore
          }
          return;
        }

        const controlSessionId = get().workspaceRuntimeById[workspaceId]?.controlSessionId;
        if (!controlSessionId || evt.sessionId !== controlSessionId) {
          return;
        }

        if (evt.type === "session_settings") {
          set((s) => ({
            workspaces: s.workspaces.map((workspace) =>
              workspace.id === workspaceId
                ? { ...workspace, defaultEnableMcp: evt.enableMcp }
                : workspace,
            ),
            workspaceRuntimeById: {
              ...s.workspaceRuntimeById,
              [workspaceId]: {
                ...s.workspaceRuntimeById[workspaceId],
                controlEnableMcp: evt.enableMcp,
              },
            },
          }));
          void deps.persist(get);
          return;
        }

        if (evt.type === "session_config") {
          set((s) => ({
            workspaces: s.workspaces.map((workspace) =>
              workspace.id === workspaceId
                ? { ...workspace, defaultSubAgentModel: evt.config.subAgentModel }
                : workspace,
            ),
            workspaceRuntimeById: {
              ...s.workspaceRuntimeById,
              [workspaceId]: {
                ...s.workspaceRuntimeById[workspaceId],
                controlSessionConfig: evt.config,
              },
            },
          }));
          void deps.persist(get);
          return;
        }

        if (evt.type === "mcp_servers") {
          set((s) => ({
            workspaceRuntimeById: {
              ...s.workspaceRuntimeById,
              [workspaceId]: {
                ...s.workspaceRuntimeById[workspaceId],
                mcpServers: evt.servers,
                mcpLegacy: evt.legacy,
                mcpFiles: evt.files,
                mcpWarnings: evt.warnings ?? [],
              },
            },
          }));
          return;
        }

        if (evt.type === "mcp_server_validation") {
          set((s) => ({
            workspaceRuntimeById: {
              ...s.workspaceRuntimeById,
              [workspaceId]: {
                ...s.workspaceRuntimeById[workspaceId],
                mcpValidationByName: {
                  ...s.workspaceRuntimeById[workspaceId].mcpValidationByName,
                  [evt.name]: evt,
                },
              },
            },
            notifications: deps.pushNotification(s.notifications, {
              id: deps.makeId(),
              ts: deps.nowIso(),
              kind: evt.ok ? "info" : "error",
              title: evt.ok ? `MCP validation passed: ${evt.name}` : `MCP validation failed: ${evt.name}`,
              detail: evt.message,
            }),
          }));
          return;
        }

        if (evt.type === "mcp_server_auth_challenge") {
          set((s) => ({
            workspaceRuntimeById: {
              ...s.workspaceRuntimeById,
              [workspaceId]: {
                ...s.workspaceRuntimeById[workspaceId],
                mcpLastAuthChallenge: evt,
              },
            },
            notifications: deps.pushNotification(s.notifications, {
              id: deps.makeId(),
              ts: deps.nowIso(),
              kind: "info",
              title: `MCP auth challenge: ${evt.name}`,
              detail: `${evt.challenge.instructions}${evt.challenge.url ? ` URL: ${evt.challenge.url}` : ""}`,
            }),
          }));
          return;
        }

        if (evt.type === "mcp_server_auth_result") {
          set((s) => ({
            workspaceRuntimeById: {
              ...s.workspaceRuntimeById,
              [workspaceId]: {
                ...s.workspaceRuntimeById[workspaceId],
                mcpLastAuthResult: evt,
              },
            },
            notifications: deps.pushNotification(s.notifications, {
              id: deps.makeId(),
              ts: deps.nowIso(),
              kind: evt.ok ? "info" : "error",
              title: evt.ok ? `MCP auth updated: ${evt.name}` : `MCP auth failed: ${evt.name}`,
              detail: evt.message,
            }),
          }));
          return;
        }

        if (evt.type === "skills_list") {
          set((s) => ({
            workspaceRuntimeById: {
              ...s.workspaceRuntimeById,
              [workspaceId]: (() => {
                const prev = s.workspaceRuntimeById[workspaceId];
                const selected = prev?.selectedSkillName ?? null;
                const exists = selected ? evt.skills.some((sk) => sk.name === selected) : true;
                return {
                  ...prev,
                  skills: evt.skills,
                  selectedSkillName: exists ? prev?.selectedSkillName ?? null : null,
                  selectedSkillContent: exists ? prev?.selectedSkillContent ?? null : null,
                };
              })(),
            },
          }));
          return;
        }

        if (evt.type === "skill_content") {
          set((s) => ({
            workspaceRuntimeById: {
              ...s.workspaceRuntimeById,
              [workspaceId]: {
                ...s.workspaceRuntimeById[workspaceId],
                selectedSkillName: evt.skill.name,
                selectedSkillContent: evt.content,
              },
            },
          }));
          return;
        }

        if (evt.type === "provider_status") {
          const byName: Partial<Record<ProviderName, ProviderStatus>> = {};
          for (const p of evt.providers) byName[p.provider] = p;
          const connected = evt.providers
            .filter((p) => p.authorized)
            .map((p) => p.provider)
            .filter((provider): provider is ProviderName => deps.isProviderName(provider));
          set((s) => ({
            providerStatusByName: { ...s.providerStatusByName, ...byName },
            providerStatusLastUpdatedAt: deps.nowIso(),
            providerStatusRefreshing: false,
            providerConnected: connected,
          }));
          return;
        }

        if (evt.type === "provider_catalog") {
          const connected = evt.connected.filter((provider): provider is ProviderName =>
            deps.isProviderName(provider),
          );
          set((s) => ({
            providerCatalog: evt.all,
            providerDefaultModelByProvider: evt.default,
            providerConnected: connected,
          }));
          return;
        }

        if (evt.type === "provider_auth_methods") {
          set(() => ({ providerAuthMethodsByProvider: evt.methods }));
          return;
        }

        if (evt.type === "provider_auth_challenge") {
          const command = evt.challenge.command ? ` Command: ${evt.challenge.command}` : "";
          const url = evt.challenge.url ? ` URL: ${evt.challenge.url}` : "";
          set((s) => ({
            providerLastAuthChallenge: evt,
            notifications: deps.pushNotification(s.notifications, {
              id: deps.makeId(),
              ts: deps.nowIso(),
              kind: "info",
              title: `Auth challenge: ${evt.provider}`,
              detail: `${evt.challenge.instructions}${url}${command}`,
            }),
          }));
          return;
        }

        if (evt.type === "provider_auth_result") {
          const title = evt.ok
            ? evt.mode === "oauth_pending"
              ? `Provider auth pending: ${evt.provider}`
              : `Provider connected: ${evt.provider}`
            : `Provider auth failed: ${evt.provider}`;
          set((s) => ({
            providerLastAuthResult: evt,
            notifications: deps.pushNotification(s.notifications, {
              id: deps.makeId(),
              ts: deps.nowIso(),
              kind: evt.ok ? "info" : "error",
              title,
              detail: evt.message,
            }),
          }));

          if (!evt.ok) return;

          const sid = get().workspaceRuntimeById[workspaceId]?.controlSessionId;
          if (!sid) return;

          set(() => ({ providerStatusRefreshing: true }));
          try {
            socket.send({ type: "refresh_provider_status", sessionId: sid });
            socket.send({ type: "provider_catalog_get", sessionId: sid });
          } catch {
            set(() => ({ providerStatusRefreshing: false }));
          }
          return;
        }

        if (evt.type === "error") {
          set((s) => ({
            notifications: deps.pushNotification(s.notifications, {
              id: deps.makeId(),
              ts: deps.nowIso(),
              kind: "error",
              title: "Control session error",
              detail: `${evt.source}/${evt.code}: ${evt.message}`,
            }),
            providerStatusRefreshing: false,
          }));
          return;
        }

        if (evt.type === "assistant_message") {
          const text = String(evt.text ?? "").trim();
          if (!text) return;
          set((s) => ({
            notifications: deps.pushNotification(s.notifications, {
              id: deps.makeId(),
              ts: deps.nowIso(),
              kind: "info",
              title: "Server message",
              detail: text,
            }),
          }));
        }
      },
      onClose: () => {
        RUNTIME.controlSockets.delete(workspaceId);
        set(() => ({
          providerStatusRefreshing: false,
          providerLastAuthChallenge: null,
        }));
      },
    });

    RUNTIME.controlSockets.set(workspaceId, socket);
    socket.connect();
  }

  function sendControl(get: StoreGet, workspaceId: string, build: (sessionId: string) => ClientMessage): boolean {
    const sock = RUNTIME.controlSockets.get(workspaceId);
    const sessionId = get().workspaceRuntimeById[workspaceId]?.controlSessionId;
    if (!sock || !sessionId) return false;
    return sock.send(build(sessionId));
  }

  return {
    ensureControlSocket,
    sendControl,
  };
}
