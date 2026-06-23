import { describe, expect, mock, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { createGoogleInteractionsRuntime } from "../src/runtime/googleInteractionsRuntime";
import { codexThreadConfig } from "../src/runtime/codexAppServer/config";
import type { RuntimeRunTurnParams } from "../src/runtime/types";
import { createWebFetchTool, __internal as webFetchInternal } from "../src/tools/webFetch";
import { createWebSearchTool } from "../src/tools/webSearch";
import { __internal as webSafetyInternal } from "../src/utils/webSafety";
import { makeConfig, makeParams } from "./runtime/google-native/fixtures";
import { makeCtx } from "./tools/tools.harness";

describe("network policy web-tool contract", () => {
  const disabledNetworkSandbox = (dir: string) =>
    ({
      kind: "workspace-write",
      writableRoots: [dir],
      network: false,
    }) as const;

  const withEnvValue = async <T>(
    key: string,
    value: string | undefined,
    run: () => Promise<T>,
  ): Promise<T> => {
    const previous = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;

    try {
      return await run();
    } finally {
      if (previous === undefined) delete process.env[key];
      else process.env[key] = previous;
    }
  };

  test("built-in webFetch still reads URLs when shell sandbox network is disabled", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-network-contract-fetch-"));
    const originalFetch = globalThis.fetch;
    webFetchInternal.setHtmlToMarkdownForTests(async (html) =>
      html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim(),
    );
    webSafetyInternal.setDnsLookup(async () => [{ address: "93.184.216.34", family: 4 }]);

    try {
      globalThis.fetch = mock(async () =>
        new Response("<main><h1>Network policy contract</h1></main>", {
          status: 200,
          headers: { "Content-Type": "text/html" },
        }),
      ) as typeof fetch;

      const tool = createWebFetchTool(
        makeCtx(dir, { sandboxPolicy: disabledNetworkSandbox(dir) }),
      );
      const output = await tool.execute({
        url: "https://example.com/policy",
        maxLength: 10_000,
      });

      expect(output).toContain("Network policy contract");
      expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    } finally {
      globalThis.fetch = originalFetch;
      webFetchInternal.resetHtmlToMarkdownForTests();
      webSafetyInternal.resetDnsLookup();
    }
  });

  test("built-in webSearch still calls the configured provider when shell sandbox network is disabled", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-network-contract-search-"));
    const originalFetch = globalThis.fetch;

    await withEnvValue("EXA_API_KEY", "exa_contract_key", async () => {
      globalThis.fetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
        expect(String(input)).toBe("https://api.exa.ai/search");
        expect(init?.method).toBe("POST");
        expect(init?.headers).toMatchObject({
          "x-api-key": "exa_contract_key",
          "Content-Type": "application/json",
        });
        expect(JSON.parse(String(init?.body))).toMatchObject({
          query: "sandbox network policy",
          numResults: 1,
        });
        return Response.json({
          results: [
            {
              title: "Policy result",
              url: "https://example.com/policy",
              highlights: ["first-party web search still runs"],
            },
          ],
        });
      }) as typeof fetch;

      try {
        const tool = createWebSearchTool(
          makeCtx(dir, { sandboxPolicy: disabledNetworkSandbox(dir) }),
        );
        const output = await tool.execute({
          query: "sandbox network policy",
          maxResults: 1,
        });

        expect(output).toMatchObject({
          provider: "exa",
          count: 1,
          request: {
            query: "sandbox network policy",
            numResults: 1,
          },
        });
        expect(globalThis.fetch).toHaveBeenCalledTimes(1);
      } finally {
        globalThis.fetch = originalFetch;
      }
    });
  });

  test("Google native web search is not suppressed by the shell sandbox network policy", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-network-contract-google-"));
    const seenStreamOptions: Array<Record<string, unknown>> = [];
    const runtime = createGoogleInteractionsRuntime({
      runStepImpl: async (opts) => {
        seenStreamOptions.push({ ...opts.streamOptions });
        return {
          assistant: {
            role: "assistant",
            api: "google-interactions",
            provider: "google",
            model: "gemini-3-flash-preview",
            content: [{ type: "text", text: "ok" }],
            usage: { input: 1, output: 1, totalTokens: 2 },
            stopReason: "stop",
            timestamp: Date.now(),
          },
          interactionId: "network-policy-google",
        };
      },
    });

    await runtime.runTurn(
      makeParams(
        makeConfig(dir, {
          providerOptions: {
            google: {
              nativeWebSearch: true,
            },
          },
        }),
        {
          networkAllowed: false,
          tools: {
            webFetch: createWebFetchTool(makeCtx(dir)),
          },
        },
      ),
    );

    expect(seenStreamOptions).toHaveLength(1);
    expect(seenStreamOptions[0]?.nativeWebSearch).toBe(true);
  });

  test("Codex app-server native web search remains gated by runtime networkAllowed", () => {
    const dir = path.join(os.tmpdir(), "cowork-network-contract-codex");
    const params = {
      config: makeConfig(dir),
      system: "You are Codex.",
      messages: [{ role: "user", content: "hello" }],
      tools: {},
      maxSteps: 1,
      networkAllowed: false,
      providerOptions: {
        "codex-cli": {
          textVerbosity: "high",
          webSearchMode: "live",
          webSearch: {
            contextSize: "high",
            allowedDomains: ["example.com"],
          },
        },
      },
    } satisfies RuntimeRunTurnParams;

    expect(codexThreadConfig(params)).toEqual({
      model_verbosity: "high",
    });
  });
});
