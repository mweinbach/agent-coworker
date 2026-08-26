import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import path from "node:path";

import { scratchRoots } from "../../src/platform/sandbox/policy";
import { getAiCoworkerPaths, writeConnectionStore } from "../../src/store/connections";
import type { ToolContext } from "../../src/tools/context";
import {
  fetchParallelContents,
  postParallelJson,
  resolveParallelApiKey,
} from "../../src/tools/parallel";
import { makeConfig, makeCtx, withEnv } from "./tools.harness";

function jsonResponse(body: unknown, init: ResponseInit = { status: 200 }): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
    ...init,
  });
}

function parallelCtx(homeDir: string): ToolContext {
  const userCoworkDir = path.join(homeDir, ".cowork");
  return makeCtx(homeDir, {
    config: makeConfig(homeDir, { userCoworkDir }),
  });
}

describe("Parallel extract client", () => {
  let homeDir: string;

  beforeEach(async () => {
    homeDir = await fs.mkdtemp(path.join(scratchRoots()[0] ?? "/tmp", "cowork-parallel-"));
  });

  afterEach(async () => {
    await fs.rm(homeDir, { recursive: true, force: true });
  });

  test("prefers a saved Parallel key over PARALLEL_API_KEY", async () => {
    const paths = getAiCoworkerPaths({ homedir: homeDir });
    await writeConnectionStore(paths, {
      version: 1,
      updatedAt: new Date().toISOString(),
      services: {},
      toolApiKeys: { parallel: "  saved-parallel-key  " },
    });

    await withEnv("PARALLEL_API_KEY", "env-parallel-key", async () => {
      await expect(resolveParallelApiKey(parallelCtx(homeDir))).resolves.toBe("saved-parallel-key");
    });
  });

  test("falls back to PARALLEL_API_KEY when no saved key exists", async () => {
    await withEnv("PARALLEL_API_KEY", "  env-only-key  ", async () => {
      await expect(resolveParallelApiKey(parallelCtx(homeDir))).resolves.toBe("env-only-key");
    });
  });

  test("returns undefined when neither saved nor env key is present", async () => {
    await withEnv("PARALLEL_API_KEY", undefined, async () => {
      await expect(resolveParallelApiKey(parallelCtx(homeDir))).resolves.toBeUndefined();
    });
  });

  test("falls back to env when the saved-key store cannot be read", async () => {
    const paths = getAiCoworkerPaths({ homedir: homeDir });
    await fs.mkdir(path.dirname(paths.connectionsFile), { recursive: true });
    await fs.mkdir(paths.connectionsFile);

    await withEnv("PARALLEL_API_KEY", "env-after-store-failure", async () => {
      await expect(resolveParallelApiKey(parallelCtx(homeDir))).resolves.toBe(
        "env-after-store-failure",
      );
    });
  });

  test("posts JSON with the API key and a composed abort signal", async () => {
    const controller = new AbortController();
    controller.abort();
    let captured: RequestInit | undefined;

    const response = await postParallelJson({
      apiKey: "parallel-key",
      path: "/v1beta/extract",
      body: { urls: ["https://example.com"] },
      abortSignal: controller.signal,
      fetchImpl: async (input, init) => {
        captured = init;
        expect(String(input)).toBe("https://api.parallel.ai/v1beta/extract");
        return jsonResponse({ results: [] });
      },
    });

    expect(response.ok).toBe(true);
    expect(captured?.method).toBe("POST");
    expect(captured?.headers).toMatchObject({
      "x-api-key": "parallel-key",
      "Content-Type": "application/json",
    });
    expect(captured?.body).toBe(JSON.stringify({ urls: ["https://example.com"] }));
    expect(captured?.signal).toBeInstanceOf(AbortSignal);
    expect(captured?.signal?.aborted).toBe(true);
  });

  test("throws a truncated HTTP error when extract is not ok", async () => {
    const body = "x".repeat(600);
    await expect(
      fetchParallelContents({
        apiKey: "parallel-key",
        url: "https://example.com/doc",
        fetchImpl: async () => new Response(body, { status: 502, statusText: "Bad Gateway" }),
      }),
    ).rejects.toThrow(`Parallel extract failed: 502 Bad Gateway: ${"x".repeat(500)}`);
  });

  test("throws when the extract payload has no usable result", async () => {
    await expect(
      fetchParallelContents({
        apiKey: "parallel-key",
        url: "https://example.com/missing",
        fetchImpl: async () => jsonResponse({ results: "not-an-array" }),
      }),
    ).rejects.toThrow("Parallel extract returned no result for https://example.com/missing");
  });

  test("throws when excerpts, links, and images are all empty", async () => {
    await expect(
      fetchParallelContents({
        apiKey: "parallel-key",
        url: "https://example.com/empty",
        fetchImpl: async () =>
          jsonResponse({
            results: [{ excerpts: ["  ", ""], full_content: null, links: [], image_links: [] }],
          }),
      }),
    ).rejects.toThrow("Parallel extract returned no content for https://example.com/empty");
  });

  test("normalizes excerpts, nested links, and markdown image URLs", async () => {
    const result = await fetchParallelContents({
      apiKey: "parallel-key",
      url: "https://example.com/page",
      objective: "  summarize  ",
      fetchImpl: async (_input, init) => {
        expect(JSON.parse(String(init?.body))).toMatchObject({
          urls: ["https://example.com/page"],
          objective: "summarize",
          full_content: false,
        });
        return jsonResponse({
          results: [
            {
              url: "https://example.com/canonical",
              title: "  Example  ",
              excerpts: [
                "First paragraph",
                "See [docs](https://example.com/docs) and ![hero](https://cdn.example.com/hero.png)",
                "Ignore [bad](javascript:alert(1)) and [ftp](ftp://example.com/file)",
              ],
              links: [{ href: "https://example.com/related" }, "https://example.com/docs"],
              imageLinks: [{ src: "https://cdn.example.com/extra.png" }],
            },
          ],
        });
      },
    });

    expect(result).toEqual({
      text: [
        "First paragraph",
        "See [docs](https://example.com/docs) and ![hero](https://cdn.example.com/hero.png)",
        "Ignore [bad](javascript:alert(1)) and [ftp](ftp://example.com/file)",
      ].join("\n\n"),
      title: "Example",
      url: "https://example.com/canonical",
      links: [
        "https://example.com/related",
        "https://example.com/docs",
        "https://cdn.example.com/hero.png",
      ],
      imageLinks: ["https://cdn.example.com/extra.png", "https://cdn.example.com/hero.png"],
    });
  });

  test("falls back to full_content when excerpts are empty", async () => {
    const result = await fetchParallelContents({
      apiKey: "parallel-key",
      url: "https://example.com/full",
      fetchImpl: async () =>
        jsonResponse({
          results: [{ excerpts: [], full_content: ["Full body"] }],
        }),
    });

    expect(result.text).toBe("Full body");
    expect(result.links).toEqual([]);
    expect(result.imageLinks).toEqual([]);
  });
});
