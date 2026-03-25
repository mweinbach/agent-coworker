import { EventEmitter, requireOptionalNativeModule } from "expo-modules-core";

export type RemodexQrPairingPayload = {
  v: number;
  relay: string;
  sessionId: string;
  macDeviceId: string;
  macIdentityPublicKey: string;
  expiresAt: number;
};

export type RemodexTrustedMacSummary = {
  macDeviceId: string;
  macIdentityPublicKey: string;
  relay: string;
  displayName: string | null;
  lastResolvedAt: string | null;
};

export type RemodexSecureTransportState = {
  status: "idle" | "pairing" | "connecting" | "connected" | "reconnecting" | "error";
  transportMode: "native" | "fallback" | "unsupported";
  connectedMacDeviceId: string | null;
  relay: string | null;
  sessionId: string | null;
  trustedMacs: RemodexTrustedMacSummary[];
  lastError: string | null;
};

type RemodexSecureTransportEvents = {
  stateChanged: (state: RemodexSecureTransportState) => void;
  plaintextMessage: (event: { text: string }) => void;
  secureError: (event: { message: string }) => void;
  socketClosed: (event: { code?: number; reason?: string | null }) => void;
};

type NativeSecureTransportModule = {
  listTrustedMacs(): Promise<RemodexTrustedMacSummary[]>;
  forgetTrustedMac(macDeviceId: string): Promise<RemodexSecureTransportState>;
  connectFromQr(payload: RemodexQrPairingPayload): Promise<RemodexSecureTransportState>;
  connectTrusted(macDeviceId: string): Promise<RemodexSecureTransportState>;
  disconnect(): Promise<RemodexSecureTransportState>;
  sendPlaintext(text: string): Promise<void>;
  getState(): Promise<RemodexSecureTransportState>;
  addListener<EventName extends keyof RemodexSecureTransportEvents>(
    eventName: EventName,
    listener: RemodexSecureTransportEvents[EventName],
  ): { remove(): void };
  removeAllListeners(eventName: keyof RemodexSecureTransportEvents): void;
};

const nativeModule = requireOptionalNativeModule<NativeSecureTransportModule>("RemodexSecureTransport");

type SecureStoreLike = {
  getItemAsync(key: string): Promise<string | null>;
  setItemAsync(key: string, value: string): Promise<void>;
  deleteItemAsync?(key: string): Promise<void>;
};

type PersistedPhoneIdentity = {
  phoneDeviceId: string;
  phoneIdentityPublicKey: string;
};

type PersistedTrustedMacRecord = RemodexTrustedMacSummary & {
  lastSessionId: string | null;
};

type PersistedRelayTransportState = {
  phoneIdentity: PersistedPhoneIdentity | null;
  trustedMacs: PersistedTrustedMacRecord[];
};

type RuntimeWebSocket = {
  readonly readyState: number;
  close(code?: number, reason?: string): void;
  send(data: string): void;
  onopen: ((event: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onerror: ((event: { message?: string }) => void) | null;
  onclose: ((event: { code?: number; reason?: string | null }) => void) | null;
};

const REMODEX_SECURE_TRANSPORT_STORAGE_KEY = "cowork.remodex.secureTransport";
const RELAY_RECONNECT_DELAY_MS = 1_000;

let secureStorePromise: Promise<SecureStoreLike | null> | null = null;
let persistedRelayTransportState: PersistedRelayTransportState | null = null;

type MockFeedItem =
  | {
      id: string;
      kind: "message";
      role: "user" | "assistant";
      ts: string;
      text: string;
    }
  | {
      id: string;
      kind: "system";
      ts: string;
      line: string;
    };

type MockThreadRecord = {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  lastEventSeq: number;
  feed: MockFeedItem[];
};

type PendingServerRequestRecord =
  | {
      kind: "approval";
      requestId: string;
      threadId: string;
      turnId: string;
      itemId: string;
      prompt: string;
      command: string;
      dangerous: boolean;
      reason: string;
    }
  | {
      kind: "ask";
      requestId: string;
      threadId: string;
      turnId: string;
      itemId: string;
      prompt: string;
      question: string;
      options?: string[];
    };

function nowIso(): string {
  return new Date().toISOString();
}

function normalizeNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
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
  const cryptoObject = typeof globalThis === "object" && globalThis
    ? (globalThis as { crypto?: { randomUUID?: () => string } }).crypto
    : undefined;
  const suffix = typeof cryptoObject?.randomUUID === "function"
    ? cryptoObject.randomUUID()
    : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return `${prefix}-${suffix}`;
}

function encodeBase64Ascii(value: string): string {
  if (typeof globalThis.btoa === "function") {
    return globalThis.btoa(value);
  }
  return value;
}

function cloneTrustedMacRecord(record: PersistedTrustedMacRecord): PersistedTrustedMacRecord {
  return {
    macDeviceId: record.macDeviceId,
    macIdentityPublicKey: record.macIdentityPublicKey,
    relay: record.relay,
    displayName: record.displayName,
    lastResolvedAt: record.lastResolvedAt,
    lastSessionId: record.lastSessionId,
  };
}

function clonePersistedRelayTransportState(state: PersistedRelayTransportState): PersistedRelayTransportState {
  return {
    phoneIdentity: state.phoneIdentity
      ? {
          phoneDeviceId: state.phoneIdentity.phoneDeviceId,
          phoneIdentityPublicKey: state.phoneIdentity.phoneIdentityPublicKey,
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
  if (!macDeviceId || !macIdentityPublicKey || !relay) {
    return null;
  }
  return {
    macDeviceId,
    macIdentityPublicKey,
    relay,
    displayName: normalizeNonEmptyString(record.displayName),
    lastResolvedAt: normalizeNonEmptyString(record.lastResolvedAt),
    lastSessionId: normalizeNonEmptyString(record.lastSessionId),
  };
}

function normalizePersistedRelayTransportState(value: unknown): PersistedRelayTransportState {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return createEmptyPersistedRelayTransportState();
  }
  const record = value as Record<string, unknown>;
  const phoneIdentityValue = record.phoneIdentity;
  const phoneIdentity = phoneIdentityValue && typeof phoneIdentityValue === "object" && !Array.isArray(phoneIdentityValue)
    ? (() => {
        const phoneRecord = phoneIdentityValue as Record<string, unknown>;
        const phoneDeviceId = normalizeNonEmptyString(phoneRecord.phoneDeviceId);
        const phoneIdentityPublicKey = normalizeNonEmptyString(phoneRecord.phoneIdentityPublicKey);
        if (!phoneDeviceId || !phoneIdentityPublicKey) {
          return null;
        }
        return {
          phoneDeviceId,
          phoneIdentityPublicKey,
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
    trustedMacs,
  };
}

async function loadSecureStore(): Promise<SecureStoreLike | null> {
  if (secureStorePromise) {
    return await secureStorePromise;
  }
  secureStorePromise = (async () => {
    try {
      const module = await import("expo-secure-store");
      if (
        typeof module.getItemAsync === "function"
        && typeof module.setItemAsync === "function"
      ) {
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

async function writePersistedRelayTransportState(nextState: PersistedRelayTransportState): Promise<void> {
  const normalized = clonePersistedRelayTransportState(nextState);
  persistedRelayTransportState = normalized;
  const secureStore = await loadSecureStore();
  if (!secureStore) {
    return;
  }
  await secureStore.setItemAsync(REMODEX_SECURE_TRANSPORT_STORAGE_KEY, JSON.stringify(normalized));
}

function queueMessage(
  emitter: RemodexSecureTransportFallback,
  payload: unknown,
): void {
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
    (this as unknown as { emit: (eventName: "stateChanged", payload: RemodexSecureTransportState) => void }).emit(
      "stateChanged",
      this.state,
    );
  }

  private emitSecureError(message: string): void {
    (this as unknown as { emit: (eventName: "secureError", payload: { message: string }) => void }).emit(
      "secureError",
      { message },
    );
  }

  private emitSocketClosed(reason: string | null): void {
    (this as unknown as { emit: (eventName: "socketClosed", payload: { reason?: string | null }) => void }).emit(
      "socketClosed",
      { reason },
    );
  }

  emitPlaintext(text: string): void {
    (this as unknown as { emit: (eventName: "plaintextMessage", payload: { text: string }) => void }).emit(
      "plaintextMessage",
      { text },
    );
  }

  private ensureDemoThreads(): void {
    if (this.threads.length > 0) {
      return;
    }
    const createdAt = nowIso();
    this.threads = [{
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
    }];
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

  private appendAssistantResolution(
    thread: MockThreadRecord,
    turnId: string,
    text: string,
  ): void {
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

  private resolvePendingServerRequest(
    requestId: string,
    result: unknown,
  ): void {
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
      const decision = result && typeof result === "object" && "decision" in result
        ? String((result as { decision?: unknown }).decision ?? "accept")
        : "accept";
      resolutionText = decision === "accept"
        ? `Approval accepted for command: ${pending.command}`
        : `Approval declined for command: ${pending.command}`;
    } else {
      const answer = result && typeof result === "object" && "answer" in result
        ? String((result as { answer?: unknown }).answer ?? "")
        : "";
      resolutionText = answer
        ? `Input provided: ${answer}`
        : "Input request resolved from mobile.";
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
    const trusted = this.state.trustedMacs.find((entry) => entry.macDeviceId === macDeviceId) ?? null;
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
    const id = typeof envelope.id === "string" || typeof envelope.id === "number"
      ? envelope.id
      : null;

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
      const params = envelope.params && typeof envelope.params === "object"
        ? envelope.params as Record<string, unknown>
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
      const params = envelope.params && typeof envelope.params === "object"
        ? envelope.params as Record<string, unknown>
        : {};
      const threadId = typeof params.threadId === "string" ? params.threadId : this.threads[0]?.id ?? "mobile-demo-thread";
      const input = Array.isArray(params.input) ? params.input : [];
      const textPart = input.find((entry) => entry && typeof entry === "object" && (entry as Record<string, unknown>).type === "text") as
        | { text?: unknown }
        | undefined;
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
      const params = envelope.params && typeof envelope.params === "object"
        ? envelope.params as Record<string, unknown>
        : {};
      const threadId = typeof params.threadId === "string" ? params.threadId : this.threads[0]?.id ?? "mobile-demo-thread";
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
  private disconnecting = false;

  private emitStateChanged(): void {
    (this as unknown as { emit: (eventName: "stateChanged", payload: RemodexSecureTransportState) => void }).emit(
      "stateChanged",
      this.state,
    );
  }

  private emitPlaintext(text: string): void {
    (this as unknown as { emit: (eventName: "plaintextMessage", payload: { text: string }) => void }).emit(
      "plaintextMessage",
      { text },
    );
  }

  private emitSecureError(message: string): void {
    (this as unknown as { emit: (eventName: "secureError", payload: { message: string }) => void }).emit(
      "secureError",
      { message },
    );
  }

  private emitSocketClosed(reason: string | null, code?: number): void {
    (this as unknown as { emit: (eventName: "socketClosed", payload: { code?: number; reason?: string | null }) => void }).emit(
      "socketClosed",
      { code, reason },
    );
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
    const phoneIdentity: PersistedPhoneIdentity = {
      phoneDeviceId: randomToken("phone"),
      phoneIdentityPublicKey: encodeBase64Ascii(randomToken("phone-public-key")),
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

  private async upsertTrustedMacRecord(record: PersistedTrustedMacRecord): Promise<PersistedTrustedMacRecord[]> {
    const persistedState = await this.readPersistedState();
    const remaining = persistedState.trustedMacs.filter((entry) => entry.macDeviceId !== record.macDeviceId);
    const trustedMacs = [record, ...remaining];
    await this.writePersistedState({
      ...persistedState,
      trustedMacs,
    });
    return trustedMacs;
  }

  private async removeTrustedMacRecord(macDeviceId: string): Promise<PersistedTrustedMacRecord[]> {
    const persistedState = await this.readPersistedState();
    const trustedMacs = persistedState.trustedMacs.filter((entry) => entry.macDeviceId !== macDeviceId);
    await this.writePersistedState({
      ...persistedState,
      trustedMacs,
    });
    return trustedMacs;
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

  private buildSocketUrl(relay: string, sessionId: string): string {
    return `${normalizeRelayUrl(relay)}/${sessionId}`;
  }

  private createSocket(relay: string, sessionId: string, phoneIdentity: PersistedPhoneIdentity): RuntimeWebSocket {
    const url = this.buildSocketUrl(relay, sessionId);
    const WebSocketConstructor = globalThis.WebSocket as unknown as {
      new (url: string, protocols?: string | string[], options?: { headers?: Record<string, string> }): RuntimeWebSocket;
    } | undefined;
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

  private async handleRelayControlMessage(text: string): Promise<boolean> {
    let parsed: Record<string, unknown> | null = null;
    try {
      parsed = JSON.parse(text) as Record<string, unknown>;
    } catch {
      return false;
    }

    const kind = typeof parsed.kind === "string" ? parsed.kind : "";
    if (!kind) {
      return false;
    }

    if (kind === "relayMacRegistration") {
      const registration = parsed.registration && typeof parsed.registration === "object" && !Array.isArray(parsed.registration)
        ? parsed.registration as Record<string, unknown>
        : null;
      const macDeviceId = normalizeNonEmptyString(registration?.macDeviceId);
      const macIdentityPublicKey = normalizeNonEmptyString(registration?.macIdentityPublicKey);
      const relay = this.state.relay;
      if (!macDeviceId || !macIdentityPublicKey || !relay) {
        return true;
      }
      const updatedRecord: PersistedTrustedMacRecord = {
        macDeviceId,
        macIdentityPublicKey,
        relay,
        displayName: normalizeNonEmptyString(registration?.displayName),
        lastResolvedAt: nowIso(),
        lastSessionId: normalizeNonEmptyString(registration?.sessionId) ?? this.state.sessionId,
      };
      const trustedMacs = await this.upsertTrustedMacRecord(updatedRecord);
      if (this.currentTarget?.macDeviceId === macDeviceId) {
        this.currentTarget = updatedRecord;
      }
      this.setState({
        connectedMacDeviceId: macDeviceId,
        trustedMacs,
      });
      return true;
    }

    if (
      kind === "serverHello"
      || kind === "clientAuth"
      || kind === "resumeState"
      || kind === "clientHello"
      || kind === "secureReady"
    ) {
      return true;
    }

    if (kind === "secureError") {
      const message = normalizeNonEmptyString(parsed.message) ?? "Secure relay error.";
      this.setState(
        {
          status: "error",
          lastError: message,
        },
        { emitSecureError: message },
      );
      return true;
    }

    return false;
  }

  private async openSocket(target: PersistedTrustedMacRecord, sessionId: string): Promise<RemodexSecureTransportState> {
    const phoneIdentity = await this.ensurePhoneIdentity();
    this.disconnecting = true;
    this.clearReconnectTimer();
    const previousSocket = this.socket;
    this.socket = null;
    previousSocket?.close();
    this.disconnecting = false;

    this.currentTarget = {
      ...target,
      lastSessionId: sessionId,
    };
    const trustedMacs = await this.upsertTrustedMacRecord(this.currentTarget);
    this.setState({
      status: "connecting",
      transportMode: "native",
      connectedMacDeviceId: target.macDeviceId,
      relay: target.relay,
      sessionId,
      trustedMacs,
      lastError: null,
    });

    const socket = this.createSocket(target.relay, sessionId, phoneIdentity);
    this.socket = socket;

    return await new Promise<RemodexSecureTransportState>((resolve) => {
      let settled = false;
      socket.onopen = () => {
        if (this.socket !== socket) {
          return;
        }
        socket.send(JSON.stringify({
          kind: "clientHello",
          phoneDeviceId: phoneIdentity.phoneDeviceId,
          phoneIdentityPublicKey: phoneIdentity.phoneIdentityPublicKey,
        }));
        socket.send(JSON.stringify({ kind: "secureReady" }));
        settled = true;
        resolve(this.setState({
          status: "connected",
          transportMode: "native",
          connectedMacDeviceId: target.macDeviceId,
          relay: target.relay,
          sessionId,
          lastError: null,
        }));
      };
      socket.onmessage = (event) => {
        if (this.socket !== socket) {
          return;
        }
        const text = typeof event.data === "string" ? event.data : String(event.data ?? "");
        void this.handleRelayControlMessage(text).then((handled) => {
          if (!handled) {
            this.emitPlaintext(text);
          }
        });
      };
      socket.onerror = (event) => {
        const message = normalizeNonEmptyString(event.message) ?? "Could not open the secure relay session.";
        if (!settled) {
          settled = true;
          resolve(this.setState(
            {
              status: "error",
              connectedMacDeviceId: target.macDeviceId,
              relay: target.relay,
              sessionId,
              lastError: message,
            },
            { emitSecureError: message },
          ));
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
        this.emitSocketClosed(event.reason ?? null, event.code);
        if (this.disconnecting) {
          return;
        }
        if (!this.currentTarget?.lastSessionId) {
          this.setState({
            status: "idle",
            lastError: null,
          });
          return;
        }
        this.setState({
          status: "reconnecting",
          lastError: event.reason ?? null,
        });
        this.clearReconnectTimer();
        this.reconnectTimer = setTimeout(() => {
          this.reconnectTimer = null;
          const reconnectTarget = this.currentTarget;
          if (!reconnectTarget?.lastSessionId) {
            return;
          }
          void this.openSocket(reconnectTarget, reconnectTarget.lastSessionId);
        }, RELAY_RECONNECT_DELAY_MS);
      };
    });
  }

  async listTrustedMacs(): Promise<RemodexTrustedMacSummary[]> {
    return (await this.listTrustedMacRecords()).map(({ lastSessionId: _lastSessionId, ...record }) => record);
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
    if (!relay || !sessionId || !macDeviceId || !macIdentityPublicKey) {
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
    return await this.openSocket({
      macDeviceId,
      macIdentityPublicKey,
      relay,
      displayName: "Desktop bridge",
      lastResolvedAt: nowIso(),
      lastSessionId: sessionId,
    }, sessionId);
  }

  async connectTrusted(macDeviceId: string): Promise<RemodexSecureTransportState> {
    const trustedMac = (await this.listTrustedMacRecords()).find((entry) => entry.macDeviceId === macDeviceId) ?? null;
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
    return await this.openSocket(trustedMac, trustedMac.lastSessionId);
  }

  async disconnect(): Promise<RemodexSecureTransportState> {
    this.disconnecting = true;
    this.clearReconnectTimer();
    const socket = this.socket;
    this.socket = null;
    this.currentTarget = null;
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
    if (!this.socket || this.socket.readyState !== 1) {
      throw new Error("Secure relay is not connected.");
    }
    this.socket.send(text);
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
const preferNativeTransport = !preferDemoTransport
  && typeof process !== "undefined"
  && process.env?.COWORK_MOBILE_USE_NATIVE_TRANSPORT === "1"
  && nativeModule;
const transport = preferDemoTransport
  ? fallbackModule
  : preferNativeTransport
    ? nativeModule
    : relayModule;

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

export async function connectFromQr(payload: RemodexQrPairingPayload): Promise<RemodexSecureTransportState> {
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
};
