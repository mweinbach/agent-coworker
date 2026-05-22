import { GoogleGenAI, type Interactions, type Operation } from "@google/genai";
import { DEFAULT_RESEARCH_AGENT_ID } from "./types";

type CreateResearchInteractionStreamOptions = {
  apiKey: string;
  input: string;
  previousInteractionId?: string;
  tools?: Interactions.Tool[];
  agentId?: Interactions.CreateAgentInteractionParamsStreaming["agent"];
  thinkingSummaries?: "auto" | "none";
  collaborativePlanning?: boolean;
  visualization?: "off" | "auto";
  signal?: AbortSignal;
};

type ResumeResearchInteractionStreamOptions = {
  apiKey: string;
  interactionId: string;
  lastEventId?: string | null;
  signal?: AbortSignal;
};

type FileSearchStoreUploadOptions = {
  apiKey: string;
  fileSearchStoreName: string;
  filePath: string;
  mimeType: string;
  displayName?: string;
  signal?: AbortSignal;
};

const googleClientCache = new Map<string, GoogleGenAI>();

function getGoogleClient(apiKey: string): GoogleGenAI {
  const cached = googleClientCache.get(apiKey);
  if (cached) {
    return cached;
  }
  const created = new GoogleGenAI({ apiKey });
  googleClientCache.set(apiKey, created);
  return created;
}

function asAsyncIterable<T>(value: unknown): AsyncIterable<T> {
  if (value && typeof (value as AsyncIterable<T>)[Symbol.asyncIterator] === "function") {
    return value as AsyncIterable<T>;
  }
  throw new Error("Expected a streaming interaction response from Google.");
}

function operationErrorMessage(
  operation: { error?: Record<string, unknown> } | null | undefined,
): string {
  const error = operation?.error;
  if (!error) {
    return "Google operation failed.";
  }
  const message = typeof error.message === "string" ? error.message.trim() : "";
  return message || JSON.stringify(error);
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("Aborted"));
      return;
    }
    const handle = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(handle);
      reject(new Error("Aborted"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

async function waitForOperation<T>(
  apiKey: string,
  operation: Operation<T>,
  signal?: AbortSignal,
): Promise<Operation<T>> {
  const client = getGoogleClient(apiKey);
  let current: Operation<T> = operation;

  while (!current.done) {
    await delay(750, signal);
    current = (await client.operations.get({ operation: current })) as unknown as Operation<T>;
  }

  if (current.error) {
    throw new Error(operationErrorMessage(current));
  }

  return current;
}

type LegacyResearchInteractionStreamEvent = {
  event_type: string;
  event_id?: string;
  interaction?: Interactions.Interaction;
  status?: Interactions.Interaction["status"];
  index?: number;
  content?: unknown;
  step?: unknown;
  delta?: unknown;
  error?: { message?: string; code?: string };
};

export type ResearchInteractionStreamEvent =
  | Interactions.InteractionSSEEvent
  | LegacyResearchInteractionStreamEvent;

export async function createResearchInteractionStream(
  opts: CreateResearchInteractionStreamOptions,
): Promise<AsyncIterable<ResearchInteractionStreamEvent>> {
  const client = getGoogleClient(opts.apiKey);
  const result = await client.interactions.create(
    {
      agent: opts.agentId ?? DEFAULT_RESEARCH_AGENT_ID,
      input: opts.input,
      background: true,
      stream: true,
      store: true,
      ...(opts.previousInteractionId
        ? { previous_interaction_id: opts.previousInteractionId }
        : {}),
      ...(opts.tools && opts.tools.length > 0 ? { tools: opts.tools } : {}),
      agent_config: {
        type: "deep-research",
        thinking_summaries: opts.thinkingSummaries ?? "auto",
        visualization: opts.visualization ?? "auto",
        ...(opts.collaborativePlanning ? { collaborative_planning: true } : {}),
      },
    },
    opts.signal ? { signal: opts.signal } : undefined,
  );

  return asAsyncIterable<ResearchInteractionStreamEvent>(result);
}

export async function resumeResearchInteractionStream(
  opts: ResumeResearchInteractionStreamOptions,
): Promise<AsyncIterable<ResearchInteractionStreamEvent>> {
  const client = getGoogleClient(opts.apiKey);
  const result = await client.interactions.get(
    opts.interactionId,
    {
      stream: true,
      ...(opts.lastEventId ? { last_event_id: opts.lastEventId } : {}),
    },
    opts.signal ? { signal: opts.signal } : undefined,
  );

  return asAsyncIterable<ResearchInteractionStreamEvent>(result);
}

export async function cancelResearchInteraction(opts: {
  apiKey: string;
  interactionId: string;
}): Promise<void> {
  const client = getGoogleClient(opts.apiKey);
  await client.interactions.cancel(opts.interactionId);
}

export async function createResearchFileSearchStore(opts: {
  apiKey: string;
  displayName: string;
  signal?: AbortSignal;
}): Promise<string> {
  const client = getGoogleClient(opts.apiKey);
  const store = await client.fileSearchStores.create({
    config: {
      displayName: opts.displayName,
      ...(opts.signal ? { abortSignal: opts.signal } : {}),
    },
  });
  if (!store.name) {
    throw new Error("Google did not return a file search store name.");
  }
  return store.name;
}

export async function uploadFileToResearchFileSearchStore(
  opts: FileSearchStoreUploadOptions,
): Promise<{ documentName?: string }> {
  const client = getGoogleClient(opts.apiKey);
  const operation = await client.fileSearchStores.uploadToFileSearchStore({
    fileSearchStoreName: opts.fileSearchStoreName,
    file: opts.filePath,
    config: {
      mimeType: opts.mimeType,
      ...(opts.displayName ? { displayName: opts.displayName } : {}),
      ...(opts.signal ? { abortSignal: opts.signal } : {}),
    },
  });

  const completed = await waitForOperation(opts.apiKey, operation, opts.signal);
  return {
    ...(typeof (completed.response as { documentName?: string } | undefined)?.documentName ===
    "string"
      ? { documentName: (completed.response as { documentName: string }).documentName }
      : {}),
  };
}

export async function deleteResearchFileSearchStore(opts: {
  apiKey: string;
  fileSearchStoreName: string;
}): Promise<void> {
  const client = getGoogleClient(opts.apiKey);
  await client.fileSearchStores.delete({ name: opts.fileSearchStoreName });
}
