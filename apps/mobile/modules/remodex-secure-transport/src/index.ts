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

const fallbackModule = new RemodexSecureTransportFallback();
const transport = nativeModule ?? fallbackModule;

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
