import { EventEmitter, requireOptionalNativeModule } from "expo-modules-core";

import {
  buildRelayHandshakeProofPayload,
  buildRelayPairingProof,
  computeRelayReconnectDelayMs,
  createRelaySharedKey,
  decodeRelaySecureEnvelope,
  encodeRelaySecureEnvelope,
  generateRelayKeyPair,
  isRelayHandshakeProofPayload,
  isValidRelayKeyPair,
  isValidRelayPublicKey,
  parseRelayControlMessage,
} from "../../../../../src/shared/mobileRelaySecurity";
import type {
  MockThreadRecord,
  NativeSecureTransportModule,
  PendingServerRequestRecord,
  PersistedPhoneIdentity,
  PersistedRelayTransportState,
  PersistedTrustedMacRecord,
  RemodexQrPairingPayload,
  RemodexSecureTransportEvents,
  RemodexSecureTransportState,
  RemodexTrustedMacSummary,
  RuntimeWebSocket,
  SecureStoreLike,
} from "./transportTypes";

export type {
  RemodexQrPairingPayload,
  RemodexSecureTransportState,
  RemodexTrustedMacSummary,
} from "./transportTypes";

const nativeModule =
  requireOptionalNativeModule<NativeSecureTransportModule>("RemodexSecureTransport");

const REMODEX_SECURE_TRANSPORT_STORAGE_KEY = "cowork.remodex.secureTransport";

let secureStorePromise: Promise<SecureStoreLike | null> | null = null;
let persistedRelayTransportState: PersistedRelayTransportState | null = null;

function nowIso(): string {
  return new Date().toISOString();
}

function normalizeNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function normalizeNonNegativeCounter(value: unknown): number {
  return Number.isSafeInteger(value) && typeof value === "number" && value >= 0 ? value : 0;
}

function normalizeRelayUrl(value: string): string {
  return value.replace(/\/+$/, "");
}

function buildRelaySocketHeaders(phoneIdentity: PersistedPhoneIdentity): Record<string, string> {
  return {
    // The hosted Remodex relay accepts `iphone` for the mobile peer role.
    "x-role": "iphone",
    "x-phone-device-id": phoneIdentity.phoneDeviceId,
    "x-phone-identity-public-key": phoneIdentity.phoneIdentityPublicKey,
  };
}

function randomToken(prefix: string): string {
  const cryptoObject =
    typeof globalThis === "object" && globalThis
      ? (globalThis as { crypto?: { randomUUID?: () => string } }).crypto
      : undefined;
  const suffix =
    typeof cryptoObject?.randomUUID === "function"
      ? cryptoObject.randomUUID()
      : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return `${prefix}-${suffix}`;
}

function cloneTrustedMacRecord(record: PersistedTrustedMacRecord): PersistedTrustedMacRecord {
  return {
    macDeviceId: record.macDeviceId,
    macIdentityPublicKey: record.macIdentityPublicKey,
    relay: record.relay,
    displayName: record.displayName,
    lastResolvedAt: record.lastResolvedAt,
    lastSessionId: record.lastSessionId,
    lastOutboundCounter: record.lastOutboundCounter,
    lastInboundCounter: record.lastInboundCounter,
  };
}

function clonePersistedRelayTransportState(
  state: PersistedRelayTransportState,
): PersistedRelayTransportState {
  return {
    phoneIdentity: state.phoneIdentity
      ? {
          phoneDeviceId: state.phoneIdentity.phoneDeviceId,
          phoneIdentityPublicKey: state.phoneIdentity.phoneIdentityPublicKey,
          phoneIdentityPrivateKey: state.phoneIdentity.phoneIdentityPrivateKey,
        }
      : null,
    trustedMacs: state.trustedMacs.map(cloneTrustedMacRecord),
  };
}

function createEmptyPersistedRelayTransportState(): PersistedRelayTransportState {
  return {
    phoneIdentity: null,
    trustedMacs: [],
  };
}

function normalizePersistedTrustedMacRecord(value: unknown): PersistedTrustedMacRecord | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  const macDeviceId = normalizeNonEmptyString(record.macDeviceId);
  const macIdentityPublicKey = normalizeNonEmptyString(record.macIdentityPublicKey);
  const relay = normalizeNonEmptyString(record.relay);
  if (
    !macDeviceId ||
    !macIdentityPublicKey ||
    !relay ||
    !isValidRelayPublicKey(macIdentityPublicKey)
  ) {
    return null;
  }
  return {
    macDeviceId,
    macIdentityPublicKey,
    relay,
    displayName: normalizeNonEmptyString(record.displayName),
    lastResolvedAt: normalizeNonEmptyString(record.lastResolvedAt),
    lastSessionId: normalizeNonEmptyString(record.lastSessionId),
    lastOutboundCounter: normalizeNonNegativeCounter(record.lastOutboundCounter),
    lastInboundCounter: normalizeNonNegativeCounter(record.lastInboundCounter),
  };
}

function normalizePersistedRelayTransportState(value: unknown): PersistedRelayTransportState {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return createEmptyPersistedRelayTransportState();
  }
  const record = value as Record<string, unknown>;
  const phoneIdentityValue = record.phoneIdentity;
  const phoneIdentity =
    phoneIdentityValue &&
    typeof phoneIdentityValue === "object" &&
    !Array.isArray(phoneIdentityValue)
      ? (() => {
          const phoneRecord = phoneIdentityValue as Record<string, unknown>;
          const phoneDeviceId = normalizeNonEmptyString(phoneRecord.phoneDeviceId);
          const phoneIdentityPublicKey = normalizeNonEmptyString(
            phoneRecord.phoneIdentityPublicKey,
          );
          const phoneIdentityPrivateKey = normalizeNonEmptyString(
            phoneRecord.phoneIdentityPrivateKey,
          );
          if (
            !phoneDeviceId ||
            !phoneIdentityPublicKey ||
            !phoneIdentityPrivateKey ||
            !isValidRelayKeyPair({
              publicKeyBase64: phoneIdentityPublicKey,
              privateKeyBase64: phoneIdentityPrivateKey,
            })
          ) {
            return null;
          }
          return {
            phoneDeviceId,
            phoneIdentityPublicKey,
            phoneIdentityPrivateKey,
          };
        })()
      : null;
  const trustedMacs = Array.isArray(record.trustedMacs)
    ? record.trustedMacs
        .map((entry) => normalizePersistedTrustedMacRecord(entry))
        .filter((entry): entry is PersistedTrustedMacRecord => entry !== null)
    : [];
  return {
    phoneIdentity,
    trustedMacs: phoneIdentity ? trustedMacs : [],
  };
}

async function loadSecureStore(): Promise<SecureStoreLike | null> {
  if (secureStorePromise) {
    return await secureStorePromise;
  }
  secureStorePromise = (async () => {
    try {
      const module = await import("expo-secure-store");
      if (typeof module.getItemAsync === "function" && typeof module.setItemAsync === "function") {
        return module;
      }
    } catch {
      return null;
    }
    return null;
  })();
  return await secureStorePromise;
}

async function readPersistedRelayTransportState(): Promise<PersistedRelayTransportState> {
  if (persistedRelayTransportState) {
    return clonePersistedRelayTransportState(persistedRelayTransportState);
  }
  const secureStore = await loadSecureStore();
  if (!secureStore) {
    persistedRelayTransportState = createEmptyPersistedRelayTransportState();
    return clonePersistedRelayTransportState(persistedRelayTransportState);
  }
  try {
    const raw = await secureStore.getItemAsync(REMODEX_SECURE_TRANSPORT_STORAGE_KEY);
    persistedRelayTransportState = raw
      ? normalizePersistedRelayTransportState(JSON.parse(raw))
      : createEmptyPersistedRelayTransportState();
  } catch {
    persistedRelayTransportState = createEmptyPersistedRelayTransportState();
  }
  return clonePersistedRelayTransportState(persistedRelayTransportState);
}

async function writePersistedRelayTransportState(
  nextState: PersistedRelayTransportState,
): Promise<void> {
  const normalized = clonePersistedRelayTransportState(nextState);
  persistedRelayTransportState = normalized;
  const secureStore = await loadSecureStore();
  if (!secureStore) {
    return;
  }
  await secureStore.setItemAsync(REMODEX_SECURE_TRANSPORT_STORAGE_KEY, JSON.stringify(normalized));
}

function queueMessage(emitter: RemodexSecureTransportFallback, payload: unknown): void {
  queueMicrotask(() => {
    emitter.emitPlaintext(JSON.stringify(payload));
  });
}

class RemodexSecureTransportFallback extends EventEmitter<RemodexSecureTransportEvents> {
  private state: RemodexSecureTransportState = {
    status: "idle",
    transportMode: "fallback",
    connectedMacDeviceId: null,
    relay: null,
    sessionId: null,
    trustedMacs: [],
    lastError: null,
  };
  private threads: MockThreadRecord[] = [];
  private pendingServerRequests = new Map<string, PendingServerRequestRecord>();

  private emitStateChanged(): void {
    (
      this as unknown as {
        emit: (eventName: "stateChanged", payload: RemodexSecureTransportState) => void;
      }
    ).emit("stateChanged", this.state);
  }

  private emitSecureError(message: string): void {
    (
      this as unknown as { emit: (eventName: "secureError", payload: { message: string }) => void }
    ).emit("secureError", { message });
  }

  private emitSocketClosed(reason: string | null): void {
    (
      this as unknown as {
        emit: (eventName: "socketClosed", payload: { reason?: string | null }) => void;
      }
    ).emit("socketClosed", { reason });
  }

  emitPlaintext(text: string): void {
    (
      this as unknown as {
        emit: (eventName: "plaintextMessage", payload: { text: string }) => void;
      }
    ).emit("plaintextMessage", { text });
  }

  private ensureDemoThreads(): void {
    if (this.threads.length > 0) {
      return;
    }
    const createdAt = nowIso();
    this.threads = [
      {
        id: "mobile-demo-thread",
        title: "Remote Access Demo",
        createdAt,
        updatedAt: createdAt,
        lastEventSeq: 2,
        feed: [
          {
            id: "mobile-demo:system",
            kind: "system",
            ts: createdAt,
            line: "Remote Access demo thread hydrated from the secure transport fallback.",
          },
          {
            id: "mobile-demo:assistant:welcome",
            kind: "message",
            role: "assistant",
            ts: createdAt,
            text: "You are connected to the mock Remodex transport. Send a prompt to exercise the mobile JSON-RPC flow.",
          },
        ],
      },
    ];
  }

  private threadSummary(thread: MockThreadRecord) {
    const lastMessage = [...thread.feed].reverse().find((entry) => entry.kind === "message");
    return {
      id: thread.id,
      title: thread.title,
      preview: lastMessage?.text ?? "",
      modelProvider: "opencode",
      model: "mobile-fallback",
      cwd: "/workspace",
      createdAt: thread.createdAt,
      updatedAt: thread.updatedAt,
      messageCount: thread.feed.filter((entry) => entry.kind === "message").length,
      lastEventSeq: thread.lastEventSeq,
      status: { type: "idle" },
    };
  }

  private threadReadResult(thread: MockThreadRecord) {
    return {
      thread: this.threadSummary(thread),
      coworkSnapshot: {
        sessionId: thread.id,
        title: thread.title,
        titleSource: "manual",
        provider: "opencode",
        model: "mobile-fallback",
        sessionKind: "primary",
        createdAt: thread.createdAt,
        updatedAt: thread.updatedAt,
        messageCount: thread.feed.filter((entry) => entry.kind === "message").length,
        lastEventSeq: thread.lastEventSeq,
        feed: thread.feed,
        agents: [],
        todos: [],
        hasPendingAsk: false,
        hasPendingApproval: false,
      },
      journalTailSeq: thread.lastEventSeq,
    };
  }

  private emitThreadNotification(thread: MockThreadRecord): void {
    queueMessage(this, {
      method: "thread/started",
      params: {
        thread: this.threadSummary(thread),
      },
    });
  }

  private appendAssistantResolution(thread: MockThreadRecord, turnId: string, text: string): void {
    const ts = nowIso();
    const assistantItemId = `${turnId}:assistant:resolution`;
    thread.lastEventSeq += 1;
    thread.feed.push({
      id: assistantItemId,
      kind: "message",
      role: "assistant",
      ts,
      text,
    });
    thread.updatedAt = ts;
    queueMessage(this, {
      method: "item/started",
      params: {
        threadId: thread.id,
        turnId,
        item: {
          id: assistantItemId,
          type: "agentMessage",
          text: "",
        },
      },
    });
    queueMessage(this, {
      method: "item/agentMessage/delta",
      params: {
        threadId: thread.id,
        turnId,
        itemId: assistantItemId,
        delta: text,
      },
    });
    queueMessage(this, {
      method: "item/completed",
      params: {
        threadId: thread.id,
        turnId,
        item: {
          id: assistantItemId,
          type: "agentMessage",
          text,
        },
      },
    });
    queueMessage(this, {
      method: "turn/completed",
      params: {
        threadId: thread.id,
        turn: {
          id: turnId,
          status: "completed",
        },
      },
    });
  }

  private resolvePendingServerRequest(requestId: string, result: unknown): void {
    const pending = this.pendingServerRequests.get(requestId);
    if (!pending) {
      return;
    }
    this.pendingServerRequests.delete(requestId);
    const thread = this.threads.find((entry) => entry.id === pending.threadId);
    if (!thread) {
      return;
    }
    let resolutionText = "Request resolved from mobile.";
    if (pending.kind === "approval") {
      const decision =
        result && typeof result === "object" && "decision" in result
          ? String((result as { decision?: unknown }).decision ?? "accept")
          : "accept";
      resolutionText =
        decision === "accept"
          ? `Approval accepted for command: ${pending.command}`
          : `Approval declined for command: ${pending.command}`;
    } else {
      const answer =
        result && typeof result === "object" && "answer" in result
          ? String((result as { answer?: unknown }).answer ?? "")
          : "";
      resolutionText = answer ? `Input provided: ${answer}` : "Input request resolved from mobile.";
    }
    queueMessage(this, {
      method: "serverRequest/resolved",
      params: {
        threadId: pending.threadId,
        requestId: pending.requestId,
      },
    });
    this.appendAssistantResolution(thread, pending.turnId, resolutionText);
  }

  async listTrustedMacs(): Promise<RemodexTrustedMacSummary[]> {
    return this.state.trustedMacs;
  }

  async forgetTrustedMac(macDeviceId: string): Promise<RemodexSecureTransportState> {
    this.state = {
      ...this.state,
      trustedMacs: this.state.trustedMacs.filter((entry) => entry.macDeviceId !== macDeviceId),
    };
    this.emitStateChanged();
    return this.state;
  }

  async connectFromQr(payload: RemodexQrPairingPayload): Promise<RemodexSecureTransportState> {
    this.ensureDemoThreads();
    const trustedMac: RemodexTrustedMacSummary = {
      macDeviceId: payload.macDeviceId,
      macIdentityPublicKey: payload.macIdentityPublicKey,
      relay: payload.relay,
      displayName: "Desktop bridge",
      lastResolvedAt: new Date().toISOString(),
    };
    this.state = {
      status: "connected",
      transportMode: "fallback",
      connectedMacDeviceId: payload.macDeviceId,
      relay: payload.relay,
      sessionId: payload.sessionId,
      trustedMacs: [trustedMac],
      lastError: null,
    };
    this.emitStateChanged();
    return this.state;
  }

  async connectTrusted(macDeviceId: string): Promise<RemodexSecureTransportState> {
    this.ensureDemoThreads();
    const trusted =
      this.state.trustedMacs.find((entry) => entry.macDeviceId === macDeviceId) ?? null;
    if (!trusted) {
      this.state = {
        ...this.state,
        status: "error",
        lastError: "Trusted desktop not found.",
      };
      this.emitSecureError(this.state.lastError ?? "Trusted desktop not found.");
      this.emitStateChanged();
      return this.state;
    }
    this.state = {
      ...this.state,
      status: "connected",
      transportMode: "fallback",
      connectedMacDeviceId: trusted.macDeviceId,
      relay: trusted.relay,
      sessionId: this.state.sessionId ?? `trusted-${trusted.macDeviceId}`,
      lastError: null,
    };
    this.emitStateChanged();
    return this.state;
  }

  async disconnect(): Promise<RemodexSecureTransportState> {
    this.state = {
      ...this.state,
      status: "idle",
      transportMode: "fallback",
      connectedMacDeviceId: null,
      relay: null,
      sessionId: null,
      lastError: null,
    };
    this.emitSocketClosed("manual disconnect");
    this.emitStateChanged();
    return this.state;
  }

  async sendPlaintext(text: string): Promise<void> {
    let message: unknown;
    try {
      message = JSON.parse(text);
    } catch {
      this.emitPlaintext(text);
      return;
    }

    if (!message || typeof message !== "object" || Array.isArray(message)) {
      return;
    }

    const envelope = message as Record<string, unknown>;
    const method = typeof envelope.method === "string" ? envelope.method : "";
    const id =
      typeof envelope.id === "string" || typeof envelope.id === "number" ? envelope.id : null;

    if (!method && id !== null && ("result" in envelope || "error" in envelope)) {
      this.resolvePendingServerRequest(String(id), envelope.result);
      return;
    }

    if (!method) {
      return;
    }

    this.ensureDemoThreads();

    if (method === "initialize" && id !== null) {
      queueMessage(this, {
        id,
        result: {
          protocolVersion: "0.1",
          serverInfo: {
            name: "cowork-mobile-fallback",
            subprotocol: "cowork.jsonrpc.v1",
          },
          capabilities: {
            experimentalApi: false,
          },
          transport: {
            type: "websocket",
            protocolMode: "jsonrpc",
          },
        },
      });
      return;
    }

    if (method === "initialized") {
      for (const thread of this.threads) {
        this.emitThreadNotification(thread);
      }
      return;
    }

    if (method === "thread/list" && id !== null) {
      queueMessage(this, {
        id,
        result: {
          threads: this.threads.map((thread) => this.threadSummary(thread)),
        },
      });
      return;
    }

    if (method === "thread/read" && id !== null) {
      const params =
        envelope.params && typeof envelope.params === "object"
          ? (envelope.params as Record<string, unknown>)
          : {};
      const threadId = typeof params.threadId === "string" ? params.threadId : "";
      const thread = this.threads.find((entry) => entry.id === threadId) ?? this.threads[0];
      if (!thread) {
        queueMessage(this, {
          id,
          error: {
            code: -32000,
            message: "Unknown thread",
          },
        });
        return;
      }
      queueMessage(this, {
        id,
        result: this.threadReadResult(thread),
      });
      return;
    }

    if (method === "turn/start" && id !== null) {
      const params =
        envelope.params && typeof envelope.params === "object"
          ? (envelope.params as Record<string, unknown>)
          : {};
      const threadId =
        typeof params.threadId === "string"
          ? params.threadId
          : (this.threads[0]?.id ?? "mobile-demo-thread");
      const input = Array.isArray(params.input) ? params.input : [];
      const textPart = input.find(
        (entry) =>
          entry && typeof entry === "object" && (entry as Record<string, unknown>).type === "text",
      ) as { text?: unknown } | undefined;
      const prompt = typeof textPart?.text === "string" ? textPart.text : "Hello from mobile";
      const thread = this.threads.find((entry) => entry.id === threadId) ?? this.threads[0];
      if (!thread) {
        return;
      }

      const turnId = `turn-${Date.now()}`;
      const userItemId = `${turnId}:user`;
      const assistantItemId = `${turnId}:assistant`;
      const ts = nowIso();
      const userItem = {
        id: userItemId,
        type: "userMessage",
        content: [{ type: "text", text: prompt }],
      };
      const lowerPrompt = prompt.toLowerCase();
      const shouldRequestApproval = lowerPrompt.includes("approval");
      const shouldRequestInput = lowerPrompt.includes("input");
      const assistantItem = {
        id: assistantItemId,
        type: "agentMessage",
        text: `Mock remote reply: ${prompt}`,
      };

      thread.lastEventSeq += 1;
      thread.feed.push({
        id: userItemId,
        kind: "message",
        role: "user",
        ts,
        text: prompt,
      });
      thread.updatedAt = ts;

      queueMessage(this, {
        id,
        result: {
          turn: {
            id: turnId,
            threadId: thread.id,
            status: "running",
            items: [userItem],
          },
        },
      });
      queueMessage(this, {
        method: "turn/started",
        params: {
          threadId: thread.id,
          turn: {
            id: turnId,
            status: "running",
            items: [userItem],
          },
        },
      });
      queueMessage(this, {
        method: "item/started",
        params: {
          threadId: thread.id,
          turnId,
          item: userItem,
        },
      });
      queueMessage(this, {
        method: "item/completed",
        params: {
          threadId: thread.id,
          turnId,
          item: userItem,
        },
      });

      if (shouldRequestApproval) {
        const requestId = `approval-${Date.now()}`;
        this.pendingServerRequests.set(requestId, {
          kind: "approval",
          requestId,
          threadId: thread.id,
          turnId,
          itemId: `${turnId}:approval`,
          prompt,
          command: "demo approval command",
          reason: "Approval demo triggered by the mobile fallback transport.",
          dangerous: true,
        });
        queueMessage(this, {
          id: requestId,
          method: "item/commandExecution/requestApproval",
          params: {
            threadId: thread.id,
            turnId,
            requestId,
            itemId: `${turnId}:approval`,
            command: "demo approval command",
            dangerous: true,
            reason: "Approval demo triggered by the mobile fallback transport.",
          },
        });
        return;
      }

      if (shouldRequestInput) {
        const requestId = `ask-${Date.now()}`;
        this.pendingServerRequests.set(requestId, {
          kind: "ask",
          requestId,
          threadId: thread.id,
          turnId,
          itemId: `${turnId}:ask`,
          prompt,
          question: "Which follow-up should Cowork send back?",
          options: ["Continue", "More detail", "Stop"],
        });
        queueMessage(this, {
          id: requestId,
          method: "item/tool/requestUserInput",
          params: {
            threadId: thread.id,
            turnId,
            requestId,
            itemId: `${turnId}:ask`,
            question: "Which follow-up should Cowork send back?",
            options: ["Continue", "More detail", "Stop"],
          },
        });
        return;
      }

      thread.lastEventSeq += 1;
      thread.feed.push({
        id: assistantItemId,
        kind: "message",
        role: "assistant",
        ts,
        text: assistantItem.text,
      });
      queueMessage(this, {
        method: "item/started",
        params: {
          threadId: thread.id,
          turnId,
          item: {
            id: assistantItemId,
            type: "agentMessage",
            text: "",
          },
        },
      });
      queueMessage(this, {
        method: "item/agentMessage/delta",
        params: {
          threadId: thread.id,
          turnId,
          itemId: assistantItemId,
          delta: assistantItem.text,
        },
      });
      queueMessage(this, {
        method: "item/completed",
        params: {
          threadId: thread.id,
          turnId,
          item: assistantItem,
        },
      });
      queueMessage(this, {
        method: "turn/completed",
        params: {
          threadId: thread.id,
          turn: {
            id: turnId,
            status: "completed",
          },
        },
      });
      return;
    }

    if (method === "turn/start" && id !== null) {
      // unreachable placeholder to satisfy exhaustive flow
    }

    if (method === "turn/start" && id !== null) {
      return;
    }

    if (method === "turn/interrupt" && id !== null) {
      const params =
        envelope.params && typeof envelope.params === "object"
          ? (envelope.params as Record<string, unknown>)
          : {};
      const threadId =
        typeof params.threadId === "string"
          ? params.threadId
          : (this.threads[0]?.id ?? "mobile-demo-thread");
      const thread = this.threads.find((entry) => entry.id === threadId) ?? this.threads[0];
      if (thread) {
        const ts = nowIso();
        thread.lastEventSeq += 1;
        thread.feed.push({
          id: `interrupt:${thread.lastEventSeq}`,
          kind: "system",
          ts,
          line: "Interrupt requested from Cowork Mobile.",
        });
        thread.updatedAt = ts;
      }
      queueMessage(this, {
        id,
        result: {},
      });
      return;
    }
  }

  async getState(): Promise<RemodexSecureTransportState> {
    return this.state;
  }
}

class RemodexSecureTransportRelay extends EventEmitter<RemodexSecureTransportEvents> {
  private state: RemodexSecureTransportState = {
    status: "idle",
    transportMode: "native",
    connectedMacDeviceId: null,
    relay: null,
    sessionId: null,
    trustedMacs: [],
    lastError: null,
  };
  private socket: RuntimeWebSocket | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private currentTarget: PersistedTrustedMacRecord | null = null;
  private currentPairingSecret: string | null = null;
  private disconnecting = false;
  private sharedKey: Uint8Array | null = null;
  private secureChannelReady = false;
  private outboundCounter = 0;
  private lastInboundCounter = 0;
  private reconnectAttempts = 0;
  private queuedOutboundMessages: string[] = [];
  private queuedInboundPlaintextMessages: string[] = [];
  private secureFinalizePromise: Promise<RemodexSecureTransportState> | null = null;
  private replayCounterPersistPending = false;
  private replayCounterPersistInFlight = false;

  private emitStateChanged(): void {
    (
      this as unknown as {
        emit: (eventName: "stateChanged", payload: RemodexSecureTransportState) => void;
      }
    ).emit("stateChanged", this.state);
  }

  private emitPlaintext(text: string): void {
    (
      this as unknown as {
        emit: (eventName: "plaintextMessage", payload: { text: string }) => void;
      }
    ).emit("plaintextMessage", { text });
  }

  private emitSecureError(message: string): void {
    (
      this as unknown as { emit: (eventName: "secureError", payload: { message: string }) => void }
    ).emit("secureError", { message });
  }

  private emitSocketClosed(reason: string | null, code?: number): void {
    (
      this as unknown as {
        emit: (
          eventName: "socketClosed",
          payload: { code?: number; reason?: string | null },
        ) => void;
      }
    ).emit("socketClosed", { code, reason });
  }

  private async readPersistedState(): Promise<PersistedRelayTransportState> {
    return await readPersistedRelayTransportState();
  }

  private async writePersistedState(nextState: PersistedRelayTransportState): Promise<void> {
    await writePersistedRelayTransportState(nextState);
  }

  private async ensurePhoneIdentity(): Promise<PersistedPhoneIdentity> {
    const persistedState = await this.readPersistedState();
    if (persistedState.phoneIdentity) {
      return persistedState.phoneIdentity;
    }
    const keyPair = generateRelayKeyPair();
    const phoneIdentity: PersistedPhoneIdentity = {
      phoneDeviceId: randomToken("phone"),
      phoneIdentityPublicKey: keyPair.publicKeyBase64,
      phoneIdentityPrivateKey: keyPair.privateKeyBase64,
    };
    await this.writePersistedState({
      ...persistedState,
      phoneIdentity,
    });
    return phoneIdentity;
  }

  private async listTrustedMacRecords(): Promise<PersistedTrustedMacRecord[]> {
    const persistedState = await this.readPersistedState();
    return persistedState.trustedMacs;
  }

  private async upsertTrustedMacRecord(
    record: PersistedTrustedMacRecord,
  ): Promise<PersistedTrustedMacRecord[]> {
    const persistedState = await this.readPersistedState();
    const remaining = persistedState.trustedMacs.filter(
      (entry) => entry.macDeviceId !== record.macDeviceId,
    );
    const trustedMacs = [record, ...remaining];
    await this.writePersistedState({
      ...persistedState,
      trustedMacs,
    });
    return trustedMacs;
  }

  private async removeTrustedMacRecord(macDeviceId: string): Promise<PersistedTrustedMacRecord[]> {
    const persistedState = await this.readPersistedState();
    const trustedMacs = persistedState.trustedMacs.filter(
      (entry) => entry.macDeviceId !== macDeviceId,
    );
    await this.writePersistedState({
      ...persistedState,
      trustedMacs,
    });
    return trustedMacs;
  }

  private queuePersistReplayCounters(): void {
    this.replayCounterPersistPending = true;
    if (this.replayCounterPersistInFlight) {
      return;
    }
    this.replayCounterPersistInFlight = true;
    void this.flushPersistReplayCounters();
  }

  private async flushPersistReplayCounters(): Promise<void> {
    try {
      while (this.replayCounterPersistPending) {
        this.replayCounterPersistPending = false;
        await this.persistReplayCountersOnce();
      }
    } finally {
      this.replayCounterPersistInFlight = false;
      if (this.replayCounterPersistPending) {
        this.replayCounterPersistInFlight = true;
        void this.flushPersistReplayCounters();
      }
    }
  }

  private async persistReplayCountersOnce(): Promise<void> {
    const target = this.currentTarget;
    const sessionId = target?.lastSessionId;
    if (!target || !sessionId) {
      return;
    }
    const persistedState = await this.readPersistedState();
    const targetIndex = persistedState.trustedMacs.findIndex(
      (entry) => entry.macDeviceId === target.macDeviceId,
    );
    if (targetIndex < 0) {
      return;
    }
    const existingRecord = persistedState.trustedMacs[targetIndex];
    if (!existingRecord || existingRecord.lastSessionId !== sessionId) {
      return;
    }
    const nextOutboundCounter = Math.max(existingRecord.lastOutboundCounter, this.outboundCounter);
    const nextInboundCounter = Math.max(existingRecord.lastInboundCounter, this.lastInboundCounter);
    if (
      nextOutboundCounter === existingRecord.lastOutboundCounter &&
      nextInboundCounter === existingRecord.lastInboundCounter
    ) {
      return;
    }
    const updatedRecord: PersistedTrustedMacRecord = {
      ...existingRecord,
      lastOutboundCounter: nextOutboundCounter,
      lastInboundCounter: nextInboundCounter,
    };
    const trustedMacs = [...persistedState.trustedMacs];
    trustedMacs[targetIndex] = updatedRecord;
    await this.writePersistedState({
      ...persistedState,
      trustedMacs,
    });
    if (
      this.currentTarget &&
      this.currentTarget.macDeviceId === updatedRecord.macDeviceId &&
      this.currentTarget.lastSessionId === updatedRecord.lastSessionId
    ) {
      this.currentTarget = updatedRecord;
    }
  }

  private setState(
    nextState: Partial<RemodexSecureTransportState>,
    options: { emitSecureError?: string | null } = {},
  ): RemodexSecureTransportState {
    this.state = {
      ...this.state,
      ...nextState,
      trustedMacs: nextState.trustedMacs ?? this.state.trustedMacs,
    };
    this.emitStateChanged();
    if (options.emitSecureError) {
      this.emitSecureError(options.emitSecureError);
    }
    return this.state;
  }

  private clearReconnectTimer(): void {
    if (!this.reconnectTimer) {
      return;
    }
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
  }

  private resetSecureChannel(opts: { clearQueue: boolean; resetCounters?: boolean }): void {
    this.sharedKey = null;
    this.secureChannelReady = false;
    this.secureFinalizePromise = null;
    if (opts.resetCounters ?? true) {
      this.outboundCounter = 0;
      this.lastInboundCounter = 0;
    }
    if (opts.clearQueue) {
      this.queuedOutboundMessages = [];
    }
    this.queuedInboundPlaintextMessages = [];
  }

  private sendControlMessage(payload: Record<string, unknown>): boolean {
    if (!this.socket || this.socket.readyState !== 1) {
      return false;
    }
    this.socket.send(JSON.stringify(payload));
    return true;
  }

  private queueOrSendApplicationMessage(text: string): void {
    if (
      !this.socket ||
      this.socket.readyState !== 1 ||
      !this.sharedKey ||
      !this.secureChannelReady
    ) {
      this.queuedOutboundMessages.push(text);
      return;
    }
    this.sendSecureEnvelope(text);
  }

  private sendSecureEnvelope(text: string): boolean {
    if (!this.socket || this.socket.readyState !== 1 || !this.sharedKey) {
      return false;
    }
    const envelope = encodeRelaySecureEnvelope({
      sharedKey: this.sharedKey,
      sender: "phone",
      counter: ++this.outboundCounter,
      plaintext: text,
    });
    this.socket.send(JSON.stringify(envelope));
    this.queuePersistReplayCounters();
    return true;
  }

  private sendHandshakeProofToDesktop(): boolean {
    return this.sendSecureEnvelope(buildRelayHandshakeProofPayload());
  }

  private flushQueuedOutboundMessages(): void {
    if (
      !this.socket ||
      this.socket.readyState !== 1 ||
      !this.sharedKey ||
      !this.secureChannelReady ||
      this.queuedOutboundMessages.length === 0
    ) {
      return;
    }
    const queuedMessages = [...this.queuedOutboundMessages];
    this.queuedOutboundMessages = [];
    for (const message of queuedMessages) {
      this.queueOrSendApplicationMessage(message);
    }
  }

  private flushQueuedInboundPlaintextMessages(): void {
    if (!this.secureChannelReady || this.queuedInboundPlaintextMessages.length === 0) {
      return;
    }
    const queuedMessages = [...this.queuedInboundPlaintextMessages];
    this.queuedInboundPlaintextMessages = [];
    for (const message of queuedMessages) {
      this.emitPlaintext(message);
    }
  }

  private emitProtocolError(message: string): void {
    this.setState(
      {
        status: "error",
        lastError: message,
      },
      { emitSecureError: message },
    );
    this.sendControlMessage({
      kind: "secureError",
      message,
    });
  }

  private buildSocketUrl(relay: string, sessionId: string): string {
    return `${normalizeRelayUrl(relay)}/${sessionId}`;
  }

  private createSocket(
    relay: string,
    sessionId: string,
    phoneIdentity: PersistedPhoneIdentity,
  ): RuntimeWebSocket {
    const url = this.buildSocketUrl(relay, sessionId);
    const WebSocketConstructor = globalThis.WebSocket as unknown as
      | {
          new (
            url: string,
            protocols?: string | string[],
            options?: { headers?: Record<string, string> },
          ): RuntimeWebSocket;
        }
      | undefined;
    if (!WebSocketConstructor) {
      throw new Error("This mobile build does not expose a WebSocket implementation.");
    }
    const headers = buildRelaySocketHeaders(phoneIdentity);
    try {
      return new WebSocketConstructor(url, undefined, { headers });
    } catch {
      return new WebSocketConstructor(url);
    }
  }

  private async handleRelayControlMessage(
    text: string,
    phoneIdentity: PersistedPhoneIdentity,
  ): Promise<{ handled: boolean; connected: boolean }> {
    const message = parseRelayControlMessage(text);
    if (!message) {
      return { handled: false, connected: false };
    }

    switch (message.kind) {
      case "relayMacRegistration": {
        const relay = this.state.relay;
        const currentTarget = this.currentTarget;
        if (!relay || !currentTarget) {
          return { handled: true, connected: false };
        }
        if (
          message.registration.macDeviceId !== currentTarget.macDeviceId ||
          message.registration.macIdentityPublicKey !== currentTarget.macIdentityPublicKey
        ) {
          this.emitProtocolError("The desktop relay identity changed unexpectedly.");
          return { handled: true, connected: false };
        }
        const sessionId = message.registration.sessionId ?? this.state.sessionId;
        const preserveReplayCounters = Boolean(
          sessionId && currentTarget.lastSessionId === sessionId,
        );
        const updatedRecord: PersistedTrustedMacRecord = {
          macDeviceId: message.registration.macDeviceId,
          macIdentityPublicKey: message.registration.macIdentityPublicKey,
          relay,
          displayName: message.registration.displayName,
          lastResolvedAt: nowIso(),
          lastSessionId: sessionId,
          lastOutboundCounter: preserveReplayCounters
            ? Math.max(currentTarget.lastOutboundCounter, this.outboundCounter)
            : 0,
          lastInboundCounter: preserveReplayCounters
            ? Math.max(currentTarget.lastInboundCounter, this.lastInboundCounter)
            : 0,
        };
        if (!sessionId) {
          this.emitProtocolError("The desktop relay session id is unavailable.");
          return { handled: true, connected: false };
        }
        this.currentTarget = updatedRecord;
        this.setState({
          connectedMacDeviceId: updatedRecord.macDeviceId,
        });
        if (this.secureChannelReady) {
          return { handled: true, connected: false };
        }
        try {
          this.sharedKey = createRelaySharedKey(
            phoneIdentity.phoneIdentityPrivateKey,
            message.registration.macIdentityPublicKey,
            sessionId,
          );
        } catch (error) {
          this.emitProtocolError(error instanceof Error ? error.message : String(error));
          return { handled: true, connected: false };
        }
        this.secureChannelReady = false;
        const clientHello = {
          kind: "clientHello",
          phoneDeviceId: phoneIdentity.phoneDeviceId,
          phoneIdentityPublicKey: phoneIdentity.phoneIdentityPublicKey,
          pairingProof: this.currentPairingSecret
            ? buildRelayPairingProof({
                pairingSecret: this.currentPairingSecret,
                sessionId,
                macDeviceId: updatedRecord.macDeviceId,
                phoneDeviceId: phoneIdentity.phoneDeviceId,
                phoneIdentityPublicKey: phoneIdentity.phoneIdentityPublicKey,
              })
            : undefined,
        };
        if (!this.sendControlMessage(clientHello)) {
          this.emitProtocolError("Could not send secure relay client hello.");
          return { handled: true, connected: false };
        }
        if (!this.sendHandshakeProofToDesktop()) {
          this.emitProtocolError("Could not send secure relay handshake proof.");
          return { handled: true, connected: false };
        }
        return { handled: true, connected: false };
      }
      case "secureReady":
        this.emitProtocolError("Plaintext secure-ready is no longer accepted.");
        return { handled: true, connected: false };
      case "secureError":
        this.setState(
          {
            status: "error",
            lastError: message.message,
          },
          { emitSecureError: message.message },
        );
        return { handled: true, connected: false };
      case "clientHello":
        this.emitProtocolError("Phone received an unexpected client hello control message.");
        return { handled: true, connected: false };
      case "serverHello":
      case "clientAuth":
      case "resumeState":
        return { handled: true, connected: false };
    }
  }

  private async finalizeSecureConnection(): Promise<RemodexSecureTransportState> {
    if (this.secureFinalizePromise) {
      return await this.secureFinalizePromise;
    }
    const target = this.currentTarget;
    if (!target) {
      throw new Error("Secure relay handshake is incomplete.");
    }
    const finalizePromise = (async () => {
      const replayAwareTarget: PersistedTrustedMacRecord = {
        ...target,
        lastOutboundCounter: Math.max(target.lastOutboundCounter, this.outboundCounter),
        lastInboundCounter: Math.max(target.lastInboundCounter, this.lastInboundCounter),
      };
      const trustedMacs = await this.upsertTrustedMacRecord(replayAwareTarget);
      if (
        !this.socket ||
        !this.currentTarget ||
        this.currentTarget.macDeviceId !== target.macDeviceId ||
        this.currentTarget.lastSessionId !== target.lastSessionId
      ) {
        return this.state;
      }
      this.currentTarget = replayAwareTarget;
      this.currentPairingSecret = null;
      this.secureChannelReady = true;
      this.reconnectAttempts = 0;
      const connectedState = this.setState({
        status: "connected",
        transportMode: "native",
        connectedMacDeviceId: target.macDeviceId,
        relay: target.relay,
        sessionId: target.lastSessionId ?? this.state.sessionId,
        trustedMacs,
        lastError: null,
      });
      this.flushQueuedOutboundMessages();
      this.flushQueuedInboundPlaintextMessages();
      return connectedState;
    })()
      .catch((error) => {
        this.queuedInboundPlaintextMessages = [];
        throw error;
      })
      .finally(() => {
        if (this.secureFinalizePromise === finalizePromise) {
          this.secureFinalizePromise = null;
        }
      });
    this.secureFinalizePromise = finalizePromise;
    return await finalizePromise;
  }

  private async openSocket(
    target: PersistedTrustedMacRecord,
    sessionId: string,
  ): Promise<RemodexSecureTransportState> {
    const phoneIdentity = await this.ensurePhoneIdentity();
    const preserveInMemoryReplayCounters =
      this.state.status === "reconnecting" &&
      this.currentTarget?.macDeviceId === target.macDeviceId &&
      this.currentTarget?.lastSessionId === sessionId;
    const preservePersistedReplayCounters =
      target.lastSessionId === sessionId &&
      (target.lastOutboundCounter > 0 || target.lastInboundCounter > 0);
    const preserveReplayCounters =
      preserveInMemoryReplayCounters || preservePersistedReplayCounters;
    this.disconnecting = true;
    this.clearReconnectTimer();
    this.resetSecureChannel({ clearQueue: false, resetCounters: !preserveReplayCounters });
    if (preserveReplayCounters) {
      this.outboundCounter = preserveInMemoryReplayCounters
        ? Math.max(this.outboundCounter, target.lastOutboundCounter)
        : target.lastOutboundCounter;
      this.lastInboundCounter = preserveInMemoryReplayCounters
        ? Math.max(this.lastInboundCounter, target.lastInboundCounter)
        : target.lastInboundCounter;
    }
    const previousSocket = this.socket;
    this.socket = null;
    previousSocket?.close();
    this.disconnecting = false;

    this.currentTarget = {
      ...target,
      lastSessionId: sessionId,
    };
    const trustedMacs = await this.listTrustedMacRecords();
    this.setState({
      status: "connecting",
      transportMode: "native",
      connectedMacDeviceId: target.macDeviceId,
      relay: target.relay,
      sessionId,
      trustedMacs,
      lastError: null,
    });

    let socket: RuntimeWebSocket;
    try {
      socket = this.createSocket(target.relay, sessionId, phoneIdentity);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return this.setState(
        {
          status: "error",
          transportMode: "native",
          connectedMacDeviceId: target.macDeviceId,
          relay: target.relay,
          sessionId,
          trustedMacs,
          lastError: message,
        },
        { emitSecureError: message },
      );
    }
    this.socket = socket;

    return await new Promise<RemodexSecureTransportState>((resolve) => {
      let settled = false;
      const settle = (state: RemodexSecureTransportState) => {
        if (settled) {
          return;
        }
        settled = true;
        resolve(state);
      };
      socket.onopen = () => {
        if (this.socket !== socket) {
          return;
        }
        this.reconnectAttempts = 0;
        this.setState({
          status: "connecting",
          transportMode: "native",
          connectedMacDeviceId: target.macDeviceId,
          relay: target.relay,
          sessionId,
          lastError: null,
        });
      };
      socket.onmessage = (event) => {
        if (this.socket !== socket) {
          return;
        }
        const text = typeof event.data === "string" ? event.data : String(event.data ?? "");
        void this.handleRelayControlMessage(text, phoneIdentity)
          .then(({ handled, connected }) => {
            if (handled) {
              if (connected || (!settled && this.state.status === "error")) {
                settle(this.state);
              }
              return;
            }
            if (!this.sharedKey) {
              this.emitProtocolError(
                "Rejected relay payload before the secure channel was established.",
              );
              if (!settled) {
                settle(this.state);
              }
              return;
            }
            const decoded = decodeRelaySecureEnvelope({
              sharedKey: this.sharedKey,
              rawMessage: text,
              expectedSender: "mac",
              lastAcceptedCounter: this.lastInboundCounter,
            });
            if (!decoded.ok) {
              this.emitProtocolError(decoded.error);
              if (!settled) {
                settle(this.state);
              }
              return;
            }
            this.lastInboundCounter = decoded.envelope.counter;
            this.queuePersistReplayCounters();
            if (!this.secureChannelReady) {
              if (!isRelayHandshakeProofPayload(decoded.plaintext)) {
                if (this.secureFinalizePromise) {
                  this.queuedInboundPlaintextMessages.push(decoded.plaintext);
                  return;
                }
                this.emitProtocolError(
                  "Rejected relay payload before the secure channel was established.",
                );
                if (!settled) {
                  settle(this.state);
                }
                return;
              }
              void this.finalizeSecureConnection()
                .then((connectedState) => {
                  if (!settled) {
                    settle(connectedState);
                  }
                })
                .catch((error) => {
                  this.emitProtocolError(error instanceof Error ? error.message : String(error));
                  if (!settled) {
                    settle(this.state);
                  }
                });
              return;
            }
            if (isRelayHandshakeProofPayload(decoded.plaintext)) {
              return;
            }
            this.emitPlaintext(decoded.plaintext);
          })
          .catch((error) => {
            this.emitProtocolError(error instanceof Error ? error.message : String(error));
            if (!settled) {
              settle(this.state);
            }
          });
      };
      socket.onerror = (event) => {
        const message =
          normalizeNonEmptyString(event.message) ?? "Could not open the secure relay session.";
        if (!settled) {
          settle(
            this.setState(
              {
                status: "error",
                connectedMacDeviceId: target.macDeviceId,
                relay: target.relay,
                sessionId,
                lastError: message,
              },
              { emitSecureError: message },
            ),
          );
          return;
        }
        this.setState(
          {
            status: "error",
            lastError: message,
          },
          { emitSecureError: message },
        );
      };
      socket.onclose = (event) => {
        if (this.socket !== socket) {
          return;
        }
        this.socket = null;
        this.resetSecureChannel({ clearQueue: false, resetCounters: false });
        this.emitSocketClosed(event.reason ?? null, event.code);
        if (this.disconnecting) {
          if (!settled) {
            settle(this.state);
          }
          return;
        }
        if (!this.currentTarget?.lastSessionId) {
          settle(
            this.setState({
              status: "idle",
              lastError: null,
            }),
          );
          return;
        }
        const reconnectState = this.setState({
          status: "reconnecting",
          lastError: event.reason ?? null,
        });
        if (!settled) {
          settle(reconnectState);
        }
        this.clearReconnectTimer();
        const reconnectAttempt = ++this.reconnectAttempts;
        const reconnectDelayMs = computeRelayReconnectDelayMs(reconnectAttempt);
        this.reconnectTimer = setTimeout(() => {
          this.reconnectTimer = null;
          const reconnectTarget = this.currentTarget;
          if (!reconnectTarget?.lastSessionId) {
            return;
          }
          void this.openSocket(reconnectTarget, reconnectTarget.lastSessionId).catch((error) => {
            const message = error instanceof Error ? error.message : String(error);
            this.setState(
              {
                status: "error",
                lastError: message,
              },
              { emitSecureError: message },
            );
          });
        }, reconnectDelayMs);
      };
    });
  }

  async listTrustedMacs(): Promise<RemodexTrustedMacSummary[]> {
    return (await this.listTrustedMacRecords()).map(
      ({
        lastSessionId: _lastSessionId,
        lastOutboundCounter: _lastOutboundCounter,
        lastInboundCounter: _lastInboundCounter,
        ...record
      }) => record,
    );
  }

  async forgetTrustedMac(macDeviceId: string): Promise<RemodexSecureTransportState> {
    const trustedMacs = await this.removeTrustedMacRecord(macDeviceId);
    if (this.currentTarget?.macDeviceId === macDeviceId) {
      await this.disconnect();
      return this.setState({ trustedMacs });
    }
    return this.setState({ trustedMacs });
  }

  async connectFromQr(payload: RemodexQrPairingPayload): Promise<RemodexSecureTransportState> {
    const relay = normalizeNonEmptyString(payload.relay);
    const sessionId = normalizeNonEmptyString(payload.sessionId);
    const macDeviceId = normalizeNonEmptyString(payload.macDeviceId);
    const macIdentityPublicKey = normalizeNonEmptyString(payload.macIdentityPublicKey);
    const pairingSecret = normalizeNonEmptyString(payload.pairingSecret);
    if (
      !relay ||
      !sessionId ||
      !macDeviceId ||
      !macIdentityPublicKey ||
      !pairingSecret ||
      !isValidRelayPublicKey(macIdentityPublicKey)
    ) {
      return this.setState(
        {
          status: "error",
          transportMode: "native",
          connectedMacDeviceId: macDeviceId,
          relay,
          sessionId,
          lastError: "The pairing QR is missing relay connection details.",
        },
        { emitSecureError: "The pairing QR is missing relay connection details." },
      );
    }
    this.currentPairingSecret = pairingSecret;
    return await this.openSocket(
      {
        macDeviceId,
        macIdentityPublicKey,
        relay,
        displayName: "Desktop bridge",
        lastResolvedAt: nowIso(),
        lastSessionId: sessionId,
        lastOutboundCounter: 0,
        lastInboundCounter: 0,
      },
      sessionId,
    );
  }

  async connectTrusted(macDeviceId: string): Promise<RemodexSecureTransportState> {
    const trustedMac =
      (await this.listTrustedMacRecords()).find((entry) => entry.macDeviceId === macDeviceId) ??
      null;
    if (!trustedMac?.lastSessionId) {
      return this.setState(
        {
          status: "error",
          transportMode: "native",
          connectedMacDeviceId: macDeviceId,
          lastError: "This saved desktop needs a fresh pairing QR before it can reconnect.",
        },
        { emitSecureError: "This saved desktop needs a fresh pairing QR before it can reconnect." },
      );
    }
    this.currentPairingSecret = null;
    return await this.openSocket(trustedMac, trustedMac.lastSessionId);
  }

  async disconnect(): Promise<RemodexSecureTransportState> {
    this.disconnecting = true;
    this.clearReconnectTimer();
    this.resetSecureChannel({ clearQueue: true });
    const socket = this.socket;
    this.socket = null;
    this.currentTarget = null;
    this.currentPairingSecret = null;
    socket?.close(1000, "Disconnected");
    this.disconnecting = false;
    return this.setState({
      status: "idle",
      transportMode: "native",
      connectedMacDeviceId: null,
      relay: null,
      sessionId: null,
      lastError: null,
    });
  }

  async sendPlaintext(text: string): Promise<void> {
    if (
      !this.socket ||
      this.socket.readyState !== 1 ||
      !this.sharedKey ||
      !this.secureChannelReady
    ) {
      throw new Error("Secure relay is not connected.");
    }
    this.queueOrSendApplicationMessage(text);
  }

  async getState(): Promise<RemodexSecureTransportState> {
    const trustedMacs = await this.listTrustedMacs();
    if (this.state.trustedMacs.length !== trustedMacs.length) {
      this.state = {
        ...this.state,
        trustedMacs,
      };
    }
    return this.state;
  }
}

const fallbackModule = new RemodexSecureTransportFallback();
const relayModule = new RemodexSecureTransportRelay();
const preferDemoTransport = typeof globalThis === "object" && "Bun" in globalThis;
const preferNativeTransport =
  !preferDemoTransport &&
  typeof process !== "undefined" &&
  process.env?.COWORK_MOBILE_USE_NATIVE_TRANSPORT === "1" &&
  nativeModule;
const transport = preferDemoTransport
  ? fallbackModule
  : preferNativeTransport
    ? nativeModule
    : relayModule;

function resetRelayTransportTestState(): void {
  secureStorePromise = null;
  persistedRelayTransportState = null;
}

export function addRemodexListener<EventName extends keyof RemodexSecureTransportEvents>(
  eventName: EventName,
  listener: RemodexSecureTransportEvents[EventName],
) {
  return transport.addListener(eventName, listener as RemodexSecureTransportEvents[EventName]);
}

export async function listTrustedMacs(): Promise<RemodexTrustedMacSummary[]> {
  return await transport.listTrustedMacs();
}

export async function forgetTrustedMac(macDeviceId: string): Promise<RemodexSecureTransportState> {
  return await transport.forgetTrustedMac(macDeviceId);
}

export async function connectFromQr(
  payload: RemodexQrPairingPayload,
): Promise<RemodexSecureTransportState> {
  return await transport.connectFromQr(payload);
}

export async function connectTrusted(macDeviceId: string): Promise<RemodexSecureTransportState> {
  return await transport.connectTrusted(macDeviceId);
}

export async function disconnectTransport(): Promise<RemodexSecureTransportState> {
  return await transport.disconnect();
}

export async function sendPlaintext(text: string): Promise<void> {
  await transport.sendPlaintext(text);
}

export async function getTransportState(): Promise<RemodexSecureTransportState> {
  return await transport.getState();
}

export const __internal = {
  buildRelaySocketHeaders,
  RemodexSecureTransportRelay,
  resetRelayTransportTestState,
};
