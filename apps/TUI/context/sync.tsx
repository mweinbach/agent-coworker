import { createContext, createEffect, onCleanup, useContext, type JSX } from "solid-js";
import { createStore, produce } from "solid-js/store";
import type { ServerEvent } from "../../../src/server/protocol";
import {
  buildSessionCloseMessage,
  deriveHelloSessionState,
  reduceNonProviderEvent,
} from "./syncEventReducer";
import { createSyncModelStreamLifecycle } from "./syncModelStreamLifecycle";
import { createSocketLifecycle, type SocketLifecycle } from "./socketLifecycle";
import type { FeedItem, SyncActions, SyncContextValue, SyncState } from "./syncTypes";

export type {
  AskRequest,
  ApprovalRequest,
  FeedItem,
  ProviderCatalogState,
  ProviderAuthMethodsState,
  ProviderStatusesState,
  ProviderAuthChallengeState,
  ProviderAuthResultState,
  HarnessContextState,
  SkillsState,
  SessionBackupState,
  ToolDescriptor,
  ContextUsageSnapshot,
} from "./syncTypes";

export {
  shouldSuppressLegacyToolLogLine,
  shouldSuppressRawDebugLogLine,
  deriveHelloSessionState,
  buildSessionCloseMessage,
} from "./syncEventReducer";

const SyncContext = createContext<SyncContextValue>();

let feedSeq = 0;
function nextFeedId(): string {
  return `f_${++feedSeq}`;
}

export function SyncProvider(props: { serverUrl: string; children: JSX.Element }) {
  const [state, setState] = createStore<SyncState>({
    status: "connecting",
    sessionId: null,
    sessionTitle: null,
    provider: "",
    model: "",
    cwd: "",
    enableMcp: true,
    tools: [],
    commands: [],
    providerCatalog: [],
    providerDefault: {},
    providerConnected: [],
    providerAuthMethods: {},
    providerStatuses: [],
    providerAuthChallenge: null,
    providerAuthResult: null,
    observabilityEnabled: false,
    observabilityConfig: null,
    observabilityHealth: null,
    harnessContext: null,
    skills: [],
    backup: null,
    contextUsage: null,
    sessionSummaries: [],
    busy: false,
    feed: [],
    todos: [],
    pendingAsk: null,
    pendingApproval: null,
  });

  const pendingTools = new Map<string, string[]>();
  const sentMessageIds = new Set<string>();

  function updateFeedItem(id: string, update: (item: FeedItem) => FeedItem) {
    setState("feed", (feed) =>
      feed.map((item) => {
        if (item.id !== id) return item;
        return update(item);
      })
    );
  }

  const modelStreamLifecycle = createSyncModelStreamLifecycle({
    nextFeedId,
    appendFeedItem: (item) => {
      setState("feed", (feed) => [...feed, item]);
    },
    updateFeedItem,
    setContextUsage: (usage) => {
      setState("contextUsage", usage);
    },
    clearPendingTools: () => {
      pendingTools.clear();
    },
  });

  let socketLifecycle: SocketLifecycle;

  function handleEvent(evt: ServerEvent) {
    if (evt.type === "server_hello") {
      const helloState = deriveHelloSessionState(evt);
      if (!helloState.isResume) {
        feedSeq = 0;
        sentMessageIds.clear();
      }

      pendingTools.clear();
      modelStreamLifecycle.reset();
      socketLifecycle.setLatestSessionId(evt.sessionId);

      setState(produce((syncState) => {
        syncState.status = "connected";
        syncState.sessionId = evt.sessionId;
        syncState.sessionTitle = helloState.isResume ? syncState.sessionTitle : null;
        syncState.provider = evt.config.provider;
        syncState.model = evt.config.model;
        syncState.cwd = evt.config.workingDirectory;
        syncState.busy = helloState.busy;

        if (helloState.isResume) {
          syncState.feed = [...syncState.feed, { id: nextFeedId(), type: "system", line: `resumed: ${evt.sessionId}` }];
          if (helloState.clearPendingAsk) syncState.pendingAsk = null;
          if (helloState.clearPendingApproval) syncState.pendingApproval = null;
        } else {
          syncState.enableMcp = true;
          syncState.tools = [];
          syncState.commands = [];
          syncState.providerCatalog = [];
          syncState.providerDefault = {};
          syncState.providerConnected = [];
          syncState.providerAuthMethods = {};
          syncState.providerStatuses = [];
          syncState.providerAuthChallenge = null;
          syncState.providerAuthResult = null;
          syncState.observabilityEnabled = false;
          syncState.observabilityConfig = null;
          syncState.observabilityHealth = null;
          syncState.harnessContext = null;
          syncState.skills = [];
          syncState.backup = null;
          syncState.contextUsage = null;
          syncState.sessionSummaries = [];
          syncState.feed = [{ id: nextFeedId(), type: "system", line: `connected: ${evt.sessionId}` }];
          syncState.todos = [];
          syncState.pendingAsk = null;
          syncState.pendingApproval = null;
        }
      }));

      socketLifecycle.send({ type: "list_tools", sessionId: evt.sessionId });
      socketLifecycle.send({ type: "list_commands", sessionId: evt.sessionId });
      socketLifecycle.send({ type: "provider_catalog_get", sessionId: evt.sessionId });
      socketLifecycle.send({ type: "provider_auth_methods_get", sessionId: evt.sessionId });
      socketLifecycle.send({ type: "refresh_provider_status", sessionId: evt.sessionId });
      socketLifecycle.send({ type: "list_skills", sessionId: evt.sessionId });
      socketLifecycle.send({ type: "session_backup_get", sessionId: evt.sessionId });
      socketLifecycle.send({ type: "harness_context_get", sessionId: evt.sessionId });
      socketLifecycle.send({ type: "list_sessions", sessionId: evt.sessionId });
      return;
    }

    const currentSessionId = state.sessionId;
    if (!currentSessionId || evt.sessionId !== currentSessionId) return;

    if (reduceNonProviderEvent(evt, {
      setState,
      nextFeedId,
      pendingTools,
      sentMessageIds,
      modelStreamLifecycle,
      resetFeedSequence: () => {
        feedSeq = 0;
      },
    })) {
      return;
    }

    switch (evt.type) {
      case "provider_catalog":
        setState("providerCatalog", evt.all);
        setState("providerDefault", evt.default);
        break;

      case "provider_auth_methods":
        setState("providerAuthMethods", evt.methods);
        break;

      case "provider_status":
        setState("providerStatuses", evt.providers);
        setState("providerConnected", evt.providers.filter((provider) => provider.authorized).map((provider) => provider.provider));
        break;

      case "provider_auth_challenge": {
        setState("providerAuthChallenge", evt);
        const url = evt.challenge.url ? ` url=${evt.challenge.url}` : "";
        const command = evt.challenge.command ? ` command=${evt.challenge.command}` : "";
        setState("feed", (feed) => [...feed, {
          id: nextFeedId(),
          type: "system",
          line: `provider auth challenge: ${evt.provider}/${evt.methodId} (${evt.challenge.method})${url}${command}`,
        }]);
        break;
      }

      case "provider_auth_result":
        setState("providerAuthResult", evt);
        if (evt.ok) {
          setState("feed", (feed) => [...feed, {
            id: nextFeedId(),
            type: "system",
            line: `provider auth: ${evt.provider}/${evt.methodId} (${evt.mode ?? "ok"})`,
          }]);
        } else {
          setState("feed", (feed) => [...feed, {
            id: nextFeedId(),
            type: "error",
            message: evt.message,
            code: "provider_error",
            source: "provider",
          }]);
        }
        break;

      default:
        setState("feed", (feed) => [...feed, {
          id: nextFeedId(),
          type: "system",
          line: `unhandled event: ${evt.type}`,
        }]);
        break;
    }
  }

  socketLifecycle = createSocketLifecycle({
    serverUrl: props.serverUrl,
    onEvent: (evt) => {
      handleEvent(evt);
    },
    onClose: () => {
      modelStreamLifecycle.reset();
      if (state.sessionId) socketLifecycle.setLatestSessionId(state.sessionId);
      setState("status", "disconnected");
    },
    onOpen: () => {
      setState("status", "connecting");
    },
  });

  createEffect(() => {
    socketLifecycle.connect(socketLifecycle.getLatestSessionId() ?? undefined);

    onCleanup(() => {
      const closeMessage = buildSessionCloseMessage(state.sessionId ?? socketLifecycle.getLatestSessionId());
      if (closeMessage) socketLifecycle.send(closeMessage);
      socketLifecycle.disconnect({ clearLatestSessionId: true });
    });
  });

  const actions: SyncActions = {
    sendMessage(text: string): boolean {
      const sessionId = state.sessionId;
      if (!sessionId || !socketLifecycle.hasSocket()) return false;

      const clientMessageId = `cm_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      sentMessageIds.add(clientMessageId);
      setState("feed", (feed) => [...feed, { id: nextFeedId(), type: "message", role: "user", text }]);
      return socketLifecycle.send({
        type: "user_message",
        sessionId,
        text,
        clientMessageId,
      });
    },

    answerAsk(requestId: string, answer: string) {
      const sessionId = state.sessionId;
      if (!sessionId || !socketLifecycle.hasSocket()) return;
      socketLifecycle.send({
        type: "ask_response",
        sessionId,
        requestId,
        answer,
      });
      setState("pendingAsk", null);
    },

    respondApproval(requestId: string, approved: boolean) {
      const sessionId = state.sessionId;
      if (!sessionId || !socketLifecycle.hasSocket()) return;
      socketLifecycle.send({
        type: "approval_response",
        sessionId,
        requestId,
        approved,
      });
      setState("pendingApproval", null);
    },

    setModel(provider: string, model: string) {
      const sessionId = state.sessionId;
      if (!sessionId || !socketLifecycle.hasSocket()) return;
      socketLifecycle.send({
        type: "set_model",
        sessionId,
        model,
        provider: provider as any,
      });
    },

    requestProviderCatalog() {
      const sessionId = state.sessionId;
      if (!sessionId || !socketLifecycle.hasSocket()) return;
      socketLifecycle.send({ type: "provider_catalog_get", sessionId });
    },

    requestProviderAuthMethods() {
      const sessionId = state.sessionId;
      if (!sessionId || !socketLifecycle.hasSocket()) return;
      socketLifecycle.send({ type: "provider_auth_methods_get", sessionId });
    },

    refreshProviderStatus() {
      const sessionId = state.sessionId;
      if (!sessionId || !socketLifecycle.hasSocket()) return;
      socketLifecycle.send({ type: "refresh_provider_status", sessionId });
    },

    authorizeProviderAuth(provider: string, methodId: string) {
      const sessionId = state.sessionId;
      if (!sessionId || !socketLifecycle.hasSocket()) return;
      socketLifecycle.send({
        type: "provider_auth_authorize",
        sessionId,
        provider: provider as any,
        methodId,
      });
    },

    callbackProviderAuth(provider: string, methodId: string, code?: string) {
      const sessionId = state.sessionId;
      if (!sessionId || !socketLifecycle.hasSocket()) return;
      socketLifecycle.send({
        type: "provider_auth_callback",
        sessionId,
        provider: provider as any,
        methodId,
        code,
      });
    },

    setProviderApiKey(provider: string, methodId: string, apiKey: string) {
      const sessionId = state.sessionId;
      if (!sessionId || !socketLifecycle.hasSocket()) return;
      socketLifecycle.send({
        type: "provider_auth_set_api_key",
        sessionId,
        provider: provider as any,
        methodId,
        apiKey,
      });
    },

    setEnableMcp(enabled: boolean) {
      const sessionId = state.sessionId;
      if (!sessionId || !socketLifecycle.hasSocket()) return;
      socketLifecycle.send({
        type: "set_enable_mcp",
        sessionId,
        enableMcp: enabled,
      });
      setState("enableMcp", enabled);
    },

    refreshTools() {
      const sessionId = state.sessionId;
      if (!sessionId || !socketLifecycle.hasSocket()) return;
      socketLifecycle.send({
        type: "list_tools",
        sessionId,
      });
    },

    refreshCommands() {
      const sessionId = state.sessionId;
      if (!sessionId || !socketLifecycle.hasSocket()) return;
      socketLifecycle.send({
        type: "list_commands",
        sessionId,
      });
    },

    requestHarnessContext() {
      const sessionId = state.sessionId;
      if (!sessionId || !socketLifecycle.hasSocket()) return;
      socketLifecycle.send({
        type: "harness_context_get",
        sessionId,
      });
    },

    setHarnessContext(context) {
      const sessionId = state.sessionId;
      if (!sessionId || !socketLifecycle.hasSocket()) return;
      socketLifecycle.send({
        type: "harness_context_set",
        sessionId,
        context,
      });
    },

    executeCommand(name: string, args = "", displayText?: string): boolean {
      const sessionId = state.sessionId;
      if (!sessionId || !socketLifecycle.hasSocket()) return false;

      const trimmedName = name.trim();
      if (!trimmedName) return false;

      const trimmedArgs = args.trim();
      const text = displayText ?? `/${trimmedName}${trimmedArgs ? ` ${trimmedArgs}` : ""}`;
      const clientMessageId = `cm_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      sentMessageIds.add(clientMessageId);

      setState("feed", (feed) => [...feed, { id: nextFeedId(), type: "message", role: "user", text }]);
      return socketLifecycle.send({
        type: "execute_command",
        sessionId,
        name: trimmedName,
        arguments: trimmedArgs || undefined,
        clientMessageId,
      });
    },

    requestSessions() {
      const sessionId = state.sessionId;
      if (!sessionId || !socketLifecycle.hasSocket()) return;
      socketLifecycle.send({ type: "list_sessions", sessionId });
    },

    resumeSession(targetSessionId: string) {
      const nextSessionId = targetSessionId.trim();
      if (!nextSessionId) return;

      const closeMessage = buildSessionCloseMessage(state.sessionId);
      if (closeMessage) socketLifecycle.send(closeMessage);

      setState("status", "connecting");
      socketLifecycle.restart(nextSessionId);
    },

    reset() {
      const sessionId = state.sessionId;
      if (!sessionId || !socketLifecycle.hasSocket()) return;
      socketLifecycle.send({ type: "reset", sessionId });
    },

    cancel() {
      const sessionId = state.sessionId;
      if (!sessionId || !socketLifecycle.hasSocket()) return;
      socketLifecycle.send({ type: "cancel", sessionId });
    },
  };

  return (
    <SyncContext.Provider value={{ state, actions }}>
      {props.children}
    </SyncContext.Provider>
  );
}

export function useSync(): SyncContextValue {
  const ctx = useContext(SyncContext);
  if (!ctx) throw new Error("useSync must be used within SyncProvider");
  return ctx;
}

export function useSyncState(): SyncState {
  return useSync().state;
}

export function useSyncActions(): SyncActions {
  return useSync().actions;
}
