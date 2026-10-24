import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  __internal as citationMetadataInternal,
  enrichCitationAnnotations,
  enrichSessionSnapshotCitations,
  enrichSessionSnapshotCitationsFromCache,
} from "../src/server/citationMetadata";
import type { SessionSnapshot } from "../src/shared/sessionSnapshot";
import { __internal as webSafetyInternal } from "../src/utils/webSafety";

const googleRedirectUrl = "https://vertexaisearch.cloud.google.com/grounding-api-redirect/example";
const resolvedArticleUrl =
  "https://www.foxnews.com/live-news/new-york-laguardia-plane-crash-march-23";
const resolvedArticleTitle =
  "LaGuardia collision: 2 pilots killed after Air Canada jet hits fire truck, forcing airport closure";

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

beforeEach(() => {
  webSafetyInternal.setDnsLookup(async (hostname) => {
    if (hostname === "127.0.0.1" || hostname === "localhost" || hostname.endsWith(".internal")) {
      return [{ address: "127.0.0.1", family: 4 }];
    }
    return [{ address: "93.184.216.34", family: 4 }]; // example.com public IP (non-blocked)
  });
});

afterEach(() => {
  webSafetyInternal.resetDnsLookup();
  citationMetadataInternal.__testResetCitationCacheLimits();
  restoreFetchStub();
  citationMetadataInternal.clearCitationResolutionCache();
});

describe("citationMetadata", () => {
  test("enrichCitationAnnotations resolves opaque Google redirects to final article titles and urls", async () => {
    let fetchCalls = 0;
    installFetchStub(async (input: RequestInfo | URL) => {
      fetchCalls += 1;
      const url =
        input instanceof URL ? input.toString() : typeof input === "string" ? input : input.url;
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
      const url =
        input instanceof URL ? input.toString() : typeof input === "string" ? input : input.url;
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
      taskType: null,
      targetPaths: null,
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
      const url =
        input instanceof URL ? input.toString() : typeof input === "string" ? input : input.url;
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
      taskType: null,
      targetPaths: null,
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

  test("caps active citation resolutions without caching skipped work", async () => {
    citationMetadataInternal.__testSetCitationCacheLimits({ maxInflight: 2 });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let fetchCalls = 0;
    installFetchStub(async () => {
      fetchCalls += 1;
      await gate;
      return makeHtmlResponse("https://example.com/article", "<title>Article</title>");
    });
    const references = Array.from({ length: 5 }, (_, index) => ({
      type: "url_citation",
      url: `https://example.com/article-${index}`,
    }));
    const pending = enrichCitationAnnotations(references);

    try {
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(fetchCalls).toBe(2);
      expect(citationMetadataInternal.__testGetInflightCacheSize()).toBe(2);
    } finally {
      release();
      await pending;
    }

    const retried = await enrichCitationAnnotations([references[2]]);
    expect(fetchCalls).toBe(3);
    expect(retried?.[0]?.title).toBe("Article");
  });

  test("cancels redirect and non-HTML response bodies", async () => {
    const cancelled: string[] = [];
    let fetchCalls = 0;
    installFetchStub(async () => {
      fetchCalls += 1;
      const kind = fetchCalls === 1 ? "redirect" : "image";
      const body = new ReadableStream({
        cancel: () => {
          cancelled.push(kind);
        },
      });
      return kind === "redirect"
        ? new Response(body, {
            status: 302,
            headers: { location: "https://example.com/image.png" },
          })
        : new Response(body, { headers: { "content-type": "image/png" } });
    });

    await enrichCitationAnnotations([{ type: "url_citation", url: googleRedirectUrl }]);

    expect(cancelled).toEqual(["redirect", "image"]);
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
      const url =
        input instanceof URL ? input.toString() : typeof input === "string" ? input : input.url;
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

  test("sends TLS server name only for DNS-named HTTPS citation fetches", async () => {
    const calls: Array<{ url: string; host: string | null; tls: unknown }> = [];
    installFetchStub(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url =
        input instanceof URL ? input.toString() : typeof input === "string" ? input : input.url;
      const headers = new Headers(init?.headers);
      calls.push({
        url,
        host: headers.get("host"),
        tls: (init as { tls?: unknown } | undefined)?.tls,
      });
      if (url.includes("/grounding-api-redirect/sni")) {
        return new Response(null, {
          status: 302,
          headers: { location: "https://www.foxnews.com/live-news/sni-article" },
        });
      }
      if (url.includes("/sni-article")) {
        return makeHtmlResponse(
          "https://www.foxnews.com/live-news/sni-article",
          "<html><head><title>SNI Article</title></head><body>ok</body></html>",
        );
      }
      if (url.includes("/literal-ipv4")) {
        return makeHtmlResponse(
          "https://93.184.216.34/literal-ipv4",
          "<html><head><title>IPv4 Literal</title></head></html>",
        );
      }
      if (url.includes("/literal-ipv6")) {
        return makeHtmlResponse(
          "https://[2001:4860:4860::8888]/literal-ipv6",
          "<html><head><title>IPv6 Literal</title></head></html>",
        );
      }
      return makeHtmlResponse(
        "http://example.com/plain-citation",
        "<html><head><title>Plain Citation</title></head></html>",
      );
    });

    const redirect = await enrichCitationAnnotations([
      {
        type: "url_citation",
        url: "https://vertexaisearch.cloud.google.com/grounding-api-redirect/sni",
        title: "redirect",
        start_index: 0,
        end_index: 1,
      },
    ]);
    const ipv4 = await enrichCitationAnnotations([
      {
        type: "url_citation",
        url: "https://93.184.216.34/literal-ipv4",
        title: "literal.test",
        start_index: 0,
        end_index: 1,
      },
    ]);
    const ipv6 = await enrichCitationAnnotations([
      {
        type: "url_citation",
        url: "https://[2001:4860:4860::8888]/literal-ipv6",
        title: "dns.google",
        start_index: 0,
        end_index: 1,
      },
    ]);
    const http = await enrichCitationAnnotations([
      {
        type: "url_citation",
        url: "http://example.com/plain-citation",
        title: "example.com",
        start_index: 0,
        end_index: 1,
      },
    ]);

    expect(redirect[0]).toMatchObject({
      url: "https://www.foxnews.com/live-news/sni-article",
      title: "SNI Article",
    });
    expect(ipv4[0]).toMatchObject({
      url: "https://93.184.216.34/literal-ipv4",
      title: "IPv4 Literal",
    });
    expect(ipv6[0]?.title).toBe("IPv6 Literal");
    expect(http[0]).toMatchObject({
      url: "http://example.com/plain-citation",
      title: "Plain Citation",
    });

    const parsed = calls.map((call) => ({ ...call, parsed: new URL(call.url) }));
    expect(parsed.map((call) => [call.parsed.pathname, call.host, call.tls])).toEqual([
      [
        "/grounding-api-redirect/sni",
        "vertexaisearch.cloud.google.com",
        { serverName: "vertexaisearch.cloud.google.com" },
      ],
      ["/live-news/sni-article", "www.foxnews.com", { serverName: "www.foxnews.com" }],
      ["/literal-ipv4", "93.184.216.34", undefined],
      ["/literal-ipv6", "[2001:4860:4860::8888]", undefined],
      ["/plain-citation", "example.com", undefined],
    ]);
    expect(parsed[0]?.parsed.hostname).toBe("93.184.216.34");
    expect(parsed[1]?.parsed.hostname).toBe("93.184.216.34");
    expect(parsed[2]?.parsed.protocol).toBe("https:");
    expect(parsed[3]?.parsed.hostname).toContain("2001:4860:4860::8888");
    expect(parsed[4]?.parsed.protocol).toBe("http:");
    expect(parsed[4]?.parsed.hostname).toBe("93.184.216.34");
  });
});
