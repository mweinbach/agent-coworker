import { asRecord } from "../piRuntimeOptions";

function isNvidiaChatCompletionsUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.origin === "https://integrate.api.nvidia.com" && url.pathname === "/v1/chat/completions"
    );
  } catch {
    return false;
  }
}

export function normalizeNvidiaChatCompletionsBody(
  body: Record<string, unknown>,
): Record<string, unknown> {
  const next: Record<string, unknown> = { ...body };
  delete next.store;
  delete next.max_tokens;
  delete next.max_completion_tokens;
  delete next.reasoning_budget;
  delete next.reasoning_effort;
  delete next.enable_thinking;

  const chatTemplateKwargs = asRecord(body.chat_template_kwargs) ?? {};
  next.chat_template_kwargs = {
    ...chatTemplateKwargs,
    enable_thinking: true,
  };
  return next;
}

function requestUrlFromFetchInput(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

function decodeRequestBody(body: BodyInit | null | undefined): string | null {
  if (typeof body === "string") return body;
  if (body instanceof URLSearchParams) return body.toString();
  if (body instanceof ArrayBuffer) return new TextDecoder().decode(body);
  if (ArrayBuffer.isView(body)) {
    return new TextDecoder().decode(body);
  }
  return null;
}

async function maybeRewriteNvidiaFetchRequest(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<[RequestInfo | URL, RequestInit | undefined]> {
  const url = requestUrlFromFetchInput(input);
  if (!isNvidiaChatCompletionsUrl(url)) {
    return [input, init];
  }

  let rawBody = decodeRequestBody(init?.body);
  if (!rawBody && input instanceof Request && init?.body === undefined) {
    rawBody = await input.clone().text();
  }
  if (!rawBody) {
    return [input, init];
  }

  let parsedBody: Record<string, unknown> | null = null;
  try {
    parsedBody = asRecord(JSON.parse(rawBody));
  } catch {
    parsedBody = null;
  }
  if (!parsedBody) {
    return [input, init];
  }

  const rewrittenBody = JSON.stringify(normalizeNvidiaChatCompletionsBody(parsedBody));
  if (input instanceof Request && init === undefined) {
    return [new Request(input, { body: rewrittenBody }), undefined];
  }
  return [input, { ...(init ?? {}), body: rewrittenBody }];
}

const NVIDIA_FETCH_PATCH_STATE = Symbol.for("cowork.nvidia.fetchPatchState");

type NvidiaFetchPatchState = {
  refCount: number;
  originalFetch: typeof fetch;
};

export async function withPatchedNvidiaFetch<T>(run: () => Promise<T>): Promise<T> {
  const globalWithState = globalThis as typeof globalThis & {
    [NVIDIA_FETCH_PATCH_STATE]?: NvidiaFetchPatchState;
  };
  const existingState = globalWithState[NVIDIA_FETCH_PATCH_STATE];
  if (existingState) {
    existingState.refCount += 1;
    try {
      return await run();
    } finally {
      existingState.refCount -= 1;
      if (existingState.refCount === 0) {
        globalThis.fetch = existingState.originalFetch;
        delete globalWithState[NVIDIA_FETCH_PATCH_STATE];
      }
    }
  }

  const originalFetch = globalThis.fetch;
  const wrappedFetch = Object.assign(async (input: RequestInfo | URL, init?: RequestInit) => {
    const [nextInput, nextInit] = await maybeRewriteNvidiaFetchRequest(input, init);
    return originalFetch.call(globalThis, nextInput as RequestInfo | URL, nextInit as RequestInit);
  }, originalFetch);

  globalThis.fetch = wrappedFetch as typeof fetch;
  globalWithState[NVIDIA_FETCH_PATCH_STATE] = {
    refCount: 1,
    originalFetch,
  };

  try {
    return await run();
  } finally {
    const currentState = globalWithState[NVIDIA_FETCH_PATCH_STATE];
    if (currentState) {
      currentState.refCount -= 1;
      if (currentState.refCount === 0) {
        globalThis.fetch = currentState.originalFetch;
        delete globalWithState[NVIDIA_FETCH_PATCH_STATE];
      }
    }
  }
}
