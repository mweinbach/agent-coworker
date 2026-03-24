import { afterEach, describe, expect, test } from "bun:test";

import {
  __internal as citationMetadataInternal,
  enrichCitationAnnotations,
  enrichSessionSnapshotCitationsFromCache,
  enrichSessionSnapshotCitations,
} from "../src/server/citationMetadata";
import type { SessionSnapshot } from "../src/shared/sessionSnapshot";

const googleRedirectUrl = "https://vertexaisearch.cloud.google.com/grounding-api-redirect/example";
const resolvedArticleUrl = "https://www.foxnews.com/live-news/new-york-laguardia-plane-crash-march-23";
const resolvedArticleTitle = "LaGuardia collision: 2 pilots killed after Air Canada jet hits fire truck, forcing airport closure";

const originalFetchDescriptor = Object.getOwnPropertyDescriptor(globalThis, "fetch");

function installFetchStub(handler: typeof fetch): void {
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    writable: true,
    value: handler,
  });
}

function restoreFetchStub(): void {
  if (originalFetchDescriptor) {
    Object.defineProperty(globalThis, "fetch", originalFetchDescriptor);
  }
}

function makeHtmlResponse(finalUrl: string, html: string): Response {
  const response = new Response(html, {
    headers: {
      "content-type": "text/html; charset=utf-8",
    },
  });
  Object.defineProperty(response, "url", {
    configurable: true,
    value: finalUrl,
  });
  return response;
}

afterEach(() => {
  citationMetadataInternal.__testResetCitationCacheLimits();
  restoreFetchStub();
  citationMetadataInternal.clearCitationResolutionCache();
});

describe("citationMetadata", () => {
  test("enrichCitationAnnotations resolves opaque Google redirects to final article titles and urls", async () => {
    let fetchCalls = 0;
    installFetchStub(async (input: RequestInfo | URL) => {
      fetchCalls += 1;
      const url = input instanceof URL ? input.toString() : typeof input === "string" ? input : input.url;
      if (url.includes("/grounding-api-redirect/example")) {
        return new Response(null, {
          status: 302,
          headers: {
            location: resolvedArticleUrl,
          },
        });
      }

      return makeHtmlResponse(
        resolvedArticleUrl,
        `<html><head><meta property="og:title" content="${resolvedArticleTitle}"></head><body>ok</body></html>`,
      );
    });

    const annotations = await enrichCitationAnnotations([
      {
        type: "url_citation",
        url: googleRedirectUrl,
        title: "foxnews.com",
        start_index: 0,
        end_index: 6,
      },
      {
        type: "url_citation",
        url: googleRedirectUrl,
        title: "foxnews.com",
        start_index: 8,
        end_index: 12,
      },
    ]);

    expect(fetchCalls).toBe(2);
    expect(annotations).toEqual([
      {
        type: "url_citation",
        url: resolvedArticleUrl,
        title: resolvedArticleTitle,
        start_index: 0,
        end_index: 6,
      },
      {
        type: "url_citation",
        url: resolvedArticleUrl,
        title: resolvedArticleTitle,
        start_index: 8,
        end_index: 12,
      },
    ]);
  });

  test("enrichSessionSnapshotCitations only rewrites assistant annotations", async () => {
    installFetchStub(async (input: RequestInfo | URL) => {
      const url = input instanceof URL ? input.toString() : typeof input === "string" ? input : input.url;
      if (url.includes("/grounding-api-redirect/example")) {
        return new Response(null, {
          status: 302,
          headers: {
            location: resolvedArticleUrl,
          },
        });
      }

      return makeHtmlResponse(
        resolvedArticleUrl,
        `<html><head><title>${resolvedArticleTitle}</title></head><body>ok</body></html>`,
      );
    });

    const snapshot: SessionSnapshot = {
      sessionId: "thread-1",
      title: "Thread 1",
      titleSource: "manual",
      titleModel: null,
      provider: "google",
      model: "gemini-3-flash-preview",
      sessionKind: "root",
      parentSessionId: null,
      role: null,
      mode: null,
      depth: null,
      nickname: null,
      requestedModel: null,
      effectiveModel: null,
      requestedReasoningEffort: null,
      effectiveReasoningEffort: null,
      executionState: null,
      lastMessagePreview: null,
      createdAt: "2026-03-23T00:00:00.000Z",
      updatedAt: "2026-03-23T00:00:00.000Z",
      messageCount: 2,
      lastEventSeq: 2,
      feed: [
        {
          id: "assistant-1",
          kind: "message",
          role: "assistant",
          ts: "2026-03-23T00:00:01.000Z",
          text: "Answer",
          annotations: [
            {
              type: "url_citation",
              url: googleRedirectUrl,
              title: "foxnews.com",
              start_index: 0,
              end_index: 6,
            },
          ],
        },
        {
          id: "user-1",
          kind: "message",
          role: "user",
          ts: "2026-03-23T00:00:02.000Z",
          text: "Thanks",
          annotations: [
            {
              type: "url_citation",
              url: googleRedirectUrl,
              title: "foxnews.com",
              start_index: 0,
              end_index: 6,
            },
          ],
        },
      ],
      agents: [],
      todos: [],
      sessionUsage: null,
      lastTurnUsage: null,
      hasPendingAsk: false,
      hasPendingApproval: false,
    };

    const enriched = await enrichSessionSnapshotCitations(snapshot);
    const assistant = enriched.feed[0];
    const user = enriched.feed[1];

    expect(assistant).toEqual({
      id: "assistant-1",
      kind: "message",
      role: "assistant",
      ts: "2026-03-23T00:00:01.000Z",
      text: "Answer",
      annotations: [
        {
          type: "url_citation",
          url: resolvedArticleUrl,
          title: resolvedArticleTitle,
          start_index: 0,
          end_index: 6,
        },
      ],
    });
    expect(user).toEqual(snapshot.feed[1]);
  });

  test("enrichSessionSnapshotCitationsFromCache only rewrites assistant annotations from cached metadata", async () => {
    installFetchStub(async (input: RequestInfo | URL) => {
      const url = input instanceof URL ? input.toString() : typeof input === "string" ? input : input.url;
      if (url.includes("/grounding-api-redirect/example")) {
        return new Response(null, {
          status: 302,
          headers: {
            location: resolvedArticleUrl,
          },
        });
      }

      return makeHtmlResponse(
        resolvedArticleUrl,
        `<html><head><title>${resolvedArticleTitle}</title></head><body>ok</body></html>`,
      );
    });

    await enrichCitationAnnotations([
      {
        type: "url_citation",
        url: googleRedirectUrl,
        title: "foxnews.com",
        start_index: 0,
        end_index: 6,
      },
    ]);

    installFetchStub(async () => {
      throw new Error("cache-only snapshot enrichment should not fetch");
    });

    const snapshot: SessionSnapshot = {
      sessionId: "thread-1",
      title: "Thread 1",
      titleSource: "manual",
      titleModel: null,
      provider: "google",
      model: "gemini-3-flash-preview",
      sessionKind: "root",
      parentSessionId: null,
      role: null,
      mode: null,
      depth: null,
      nickname: null,
      requestedModel: null,
      effectiveModel: null,
      requestedReasoningEffort: null,
      effectiveReasoningEffort: null,
      executionState: null,
      lastMessagePreview: null,
      createdAt: "2026-03-23T00:00:00.000Z",
      updatedAt: "2026-03-23T00:00:00.000Z",
      messageCount: 2,
      lastEventSeq: 2,
      feed: [
        {
          id: "assistant-1",
          kind: "message",
          role: "assistant",
          ts: "2026-03-23T00:00:01.000Z",
          text: "Answer",
          annotations: [
            {
              type: "url_citation",
              url: googleRedirectUrl,
              title: "foxnews.com",
              start_index: 0,
              end_index: 6,
            },
          ],
        },
        {
          id: "user-1",
          kind: "message",
          role: "user",
          ts: "2026-03-23T00:00:02.000Z",
          text: "Thanks",
          annotations: [
            {
              type: "url_citation",
              url: googleRedirectUrl,
              title: "foxnews.com",
              start_index: 0,
              end_index: 6,
            },
          ],
        },
      ],
      agents: [],
      todos: [],
      sessionUsage: null,
      lastTurnUsage: null,
      hasPendingAsk: false,
      hasPendingApproval: false,
    };

    const enriched = enrichSessionSnapshotCitationsFromCache(snapshot);
    const assistant = enriched.feed[0];
    const user = enriched.feed[1];

    expect(assistant).toEqual({
      id: "assistant-1",
      kind: "message",
      role: "assistant",
      ts: "2026-03-23T00:00:01.000Z",
      text: "Answer",
      annotations: [
        {
          type: "url_citation",
          url: resolvedArticleUrl,
          title: resolvedArticleTitle,
          start_index: 0,
          end_index: 6,
        },
      ],
    });
    expect(user).toEqual(snapshot.feed[1]);
  });

  test("evicts oldest settled citation cache entries when over capacity", async () => {
    citationMetadataInternal.__testSetCitationCacheLimits({ maxSettled: 3 });
    installFetchStub(async (input: RequestInfo | URL) => {
      const u = typeof input === "string" ? input : input.url;
      const response = new Response(`<html><head><title>T ${u}</title></head></html>`, {
        headers: { "content-type": "text/html; charset=utf-8" },
      });
      Object.defineProperty(response, "url", { configurable: true, value: u });
      return response;
    });

    for (let i = 0; i < 5; i++) {
      await enrichCitationAnnotations([
        {
          type: "url_citation",
          url: `https://vertexaisearch.cloud.google.com/grounding-api-redirect/u${i}`,
          title: "host.test",
          start_index: 0,
          end_index: 1,
        },
      ]);
    }

    expect(citationMetadataInternal.__testGetSettledCacheSize()).toBe(3);
  });

  test("does not fetch citations for blocked private-network targets", async () => {
    let fetchCalls = 0;
    installFetchStub(async () => {
      fetchCalls += 1;
      throw new Error("blocked citation should not be fetched");
    });

    const annotations = await enrichCitationAnnotations([
      {
        type: "url_citation",
        url: "http://127.0.0.1/admin",
        title: "internal.test",
        start_index: 0,
        end_index: 6,
      },
    ]);

    expect(fetchCalls).toBe(0);
    expect(annotations).toEqual([
      {
        type: "url_citation",
        url: "http://127.0.0.1/admin",
        title: "internal.test",
        start_index: 0,
        end_index: 6,
      },
    ]);
  });

  test("blocks citation redirects to private-network targets", async () => {
    let fetchCalls = 0;
    installFetchStub(async () => {
      fetchCalls += 1;
      return new Response(null, {
        status: 302,
        headers: {
          location: "http://127.0.0.1/admin",
        },
      });
    });

    const annotations = await enrichCitationAnnotations([
      {
        type: "url_citation",
        url: googleRedirectUrl,
        title: "public.example",
        start_index: 0,
        end_index: 6,
      },
    ]);

    expect(fetchCalls).toBe(1);
    expect(annotations).toEqual([
      {
        type: "url_citation",
        url: googleRedirectUrl,
        title: "public.example",
        start_index: 0,
        end_index: 6,
      },
    ]);
  });

  test("follows allowed public citation redirects and resolves the final title", async () => {
    let fetchCalls = 0;
    installFetchStub(async (input: RequestInfo | URL) => {
      fetchCalls += 1;
      const url = input instanceof URL ? input.toString() : typeof input === "string" ? input : input.url;
      if (url.includes("/grounding-api-redirect/example")) {
        return new Response(null, {
          status: 302,
          headers: {
            location: "https://www.foxnews.com/live-news/new-york-laguardia-plane-crash-march-23",
          },
        });
      }

      return makeHtmlResponse(
        resolvedArticleUrl,
        `<html><head><title>${resolvedArticleTitle}</title></head><body>ok</body></html>`,
      );
    });

    const annotations = await enrichCitationAnnotations([
      {
        type: "url_citation",
        url: googleRedirectUrl,
        title: "public.example",
        start_index: 0,
        end_index: 6,
      },
    ]);

    expect(fetchCalls).toBe(2);
    expect(annotations).toEqual([
      {
        type: "url_citation",
        url: resolvedArticleUrl,
        title: resolvedArticleTitle,
        start_index: 0,
        end_index: 6,
      },
    ]);
  });
});
