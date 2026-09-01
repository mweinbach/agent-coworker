import { describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { ToolContext } from "../src/tools/context";
import { fetchExaContents, resolveExaApiKey } from "../src/tools/exa";
import { fetchParallelContents } from "../src/tools/parallel";

function streamedResponse(text: string, init?: ResponseInit, chunkSize = 16 * 1024) {
  const bytes = new TextEncoder().encode(text);
  let offset = 0;
  let cancelled = false;
  const response = new Response(
    new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          if (offset === bytes.length) {
            controller.close();
            return;
          }
          const end = Math.min(offset + chunkSize, bytes.length);
          controller.enqueue(bytes.subarray(offset, end));
          offset = end;
        },
        cancel() {
          cancelled = true;
        },
      },
      { highWaterMark: 0 },
    ),
    init,
  );
  return { response, readBytes: () => offset, wasCancelled: () => cancelled };
}

function makeCtx(userCoworkDir: string): ToolContext {
  return {
    config: { userCoworkDir } as any,
    log: () => {},
    askUser: async () => "",
    approveCommand: async () => true,
  };
}

async function makeCoworkHome() {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "exa-test-"));
  const userCoworkDir = path.join(tmp, ".agent-user");
  await fs.mkdir(userCoworkDir, { recursive: true });
  const authDir = path.join(tmp, ".cowork", "auth");
  await fs.mkdir(authDir, { recursive: true });
  return { tmp, userCoworkDir, authDir };
}

async function withEnv<T>(
  key: string,
  value: string | undefined,
  run: () => Promise<T>,
): Promise<T> {
  const previous = process.env[key];
  if (typeof value === "string") process.env[key] = value;
  else delete process.env[key];

  try {
    return await run();
  } finally {
    if (previous === undefined) delete process.env[key];
    else process.env[key] = previous;
  }
}

describe("tools/exa", () => {
  test("resolveExaApiKey prefers stored key over EXA_API_KEY", async () => {
    const { tmp, userCoworkDir, authDir } = await makeCoworkHome();
    await fs.writeFile(
      path.join(authDir, "connections.json"),
      JSON.stringify({
        version: 1,
        updatedAt: new Date().toISOString(),
        services: {},
        toolApiKeys: { exa: "saved-key" },
      }),
      "utf-8",
    );

    const prev = process.env.EXA_API_KEY;
    process.env.EXA_API_KEY = "env-key";
    try {
      const result = await withEnv(
        "HOME",
        tmp,
        async () => await resolveExaApiKey(makeCtx(userCoworkDir)),
      );
      expect(result).toBe("saved-key");
    } finally {
      if (prev === undefined) {
        delete process.env.EXA_API_KEY;
      } else {
        process.env.EXA_API_KEY = prev;
      }
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  test("resolveExaApiKey falls back to EXA_API_KEY when no stored key is available", async () => {
    const { tmp, userCoworkDir } = await makeCoworkHome();

    const prev = process.env.EXA_API_KEY;
    process.env.EXA_API_KEY = "env-key";
    try {
      const result = await withEnv(
        "HOME",
        tmp,
        async () => await resolveExaApiKey(makeCtx(userCoworkDir)),
      );
      expect(result).toBe("env-key");
    } finally {
      if (prev === undefined) {
        delete process.env.EXA_API_KEY;
      } else {
        process.env.EXA_API_KEY = prev;
      }
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  test("resolveExaApiKey falls back to saved key", async () => {
    const { tmp, userCoworkDir } = await makeCoworkHome();
    const authFile = path.join(path.dirname(userCoworkDir), ".cowork", "auth", "connections.json");
    await fs.mkdir(path.dirname(authFile), { recursive: true });
    await fs.writeFile(
      authFile,
      JSON.stringify({
        version: 1,
        updatedAt: new Date().toISOString(),
        services: {},
        toolApiKeys: { exa: "saved-key" },
      }),
      "utf-8",
    );

    delete process.env.EXA_API_KEY;
    try {
      const result = await withEnv(
        "HOME",
        tmp,
        async () => await resolveExaApiKey(makeCtx(userCoworkDir)),
      );
      expect(result).toBe("saved-key");
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  test("fetchExaContents dedupes extras and honors nested text", async () => {
    const output = await fetchExaContents({
      apiKey: "key",
      url: "https://example.com",
      fetchImpl: async () =>
        Response.json({
          results: [
            {
              text: { text: "main text" },
              extras: {
                links: ["https://a", { href: "https://b" }, { link: "https://a" }],
                imageLinks: ["https://img", { src: "https://img2" }, { src: "https://img" }],
              },
              highlights: ["ignored"],
              title: "Title",
              url: "https://canonical",
            },
          ],
        }),
    });

    expect(output.text).toBe("main text");
    expect(output.links).toEqual(["https://a", "https://b"]);
    expect(output.imageLinks).toEqual(["https://img", "https://img2"]);
    expect(output.title).toBe("Title");
    expect(output.url).toBe("https://canonical");
  });

  test("fetchExaContents falls back to highlights when text missing", async () => {
    const output = await fetchExaContents({
      apiKey: "key",
      url: "https://example.com",
      fetchImpl: async () =>
        Response.json({
          results: [
            {
              highlights: ["first highlight", "second highlight"],
            },
          ],
        }),
    });

    expect(output.text).toBe("first highlight\n\nsecond highlight");
  });

  test("fetchExaContents throws when no result or content", async () => {
    await expect(
      fetchExaContents({
        apiKey: "key",
        url: "https://example.com",
        fetchImpl: async () => Response.json({}),
      }),
    ).rejects.toThrow("no result");

    await expect(
      fetchExaContents({
        apiKey: "key",
        url: "https://example.com",
        fetchImpl: async () =>
          Response.json({
            results: [
              {
                text: "",
                highlights: [],
                extras: { links: [], imageLinks: [] },
              },
            ],
          }),
      }),
    ).rejects.toThrow("no content");
  });
});

describe("web provider content response limits", () => {
  for (const [provider, fetchContents] of [
    ["Exa", fetchExaContents],
    ["Parallel", fetchParallelContents],
  ] as const) {
    const payload = (text: string) => ({
      results: [provider === "Exa" ? { text } : { excerpts: [text] }],
    });

    test(`${provider} rejects oversized decoded JSON and cancels the stream`, async () => {
      const body = JSON.stringify(payload("é".repeat(1_100_000)));
      const stream = streamedResponse(body, { headers: { "Content-Length": "1" } });
      const outcome = await fetchContents({
        apiKey: "test-key",
        url: "https://example.com",
        fetchImpl: async () => stream.response,
      }).then(
        () => "accepted oversized response",
        (error: unknown) => String(error),
      );

      expect(outcome).toContain("response exceeded 2 MiB");
      expect(stream.wasCancelled()).toBe(true);
      expect(stream.readBytes()).toBeLessThan(new TextEncoder().encode(body).byteLength);
      expect(stream.response.body?.locked).toBe(false);
    });

    test(`${provider} preserves HTTP diagnostics without draining an oversized error body`, async () => {
      const body = `Upstream unavailable: ${"x".repeat(256 * 1024)}`;
      const stream = streamedResponse(body, { status: 502, statusText: "Bad Gateway" });
      const outcome = await fetchContents({
        apiKey: "test-key",
        url: "https://example.com",
        fetchImpl: async () => stream.response,
      }).then(
        () => "accepted error response",
        (error: unknown) => String(error),
      );

      expect(outcome).toContain("failed: 502 Bad Gateway:");
      expect(outcome).toContain(body.slice(0, 500));
      expect(stream.wasCancelled()).toBe(true);
      expect(stream.readBytes()).toBeLessThan(64 * 1024);
      expect(stream.response.body?.locked).toBe(false);
    });

    test(`${provider} accepts JSON at the decoded byte limit`, async () => {
      const overhead = new TextEncoder().encode(JSON.stringify(payload(""))).byteLength;
      const text = "x".repeat(2 * 1024 * 1024 - overhead);
      const stream = streamedResponse(JSON.stringify(payload(text)));
      const output = await fetchContents({
        apiKey: "test-key",
        url: "https://example.com",
        fetchImpl: async () => stream.response,
      });

      expect(output.text.length).toBe(text.length);
      expect(stream.wasCancelled()).toBe(false);
      expect(stream.response.body?.locked).toBe(false);
    });

    test(`${provider} preserves the size error when stream cancellation fails`, async () => {
      const response = new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new Uint8Array(2 * 1024 * 1024 + 1));
          },
          cancel() {
            throw new Error("cancellation failed");
          },
        }),
      );

      await expect(
        fetchContents({
          apiKey: "test-key",
          url: "https://example.com",
          fetchImpl: async () => response,
        }),
      ).rejects.toThrow("response exceeded 2 MiB");
      expect(response.body?.locked).toBe(false);
    });

    test(`${provider} preserves UTF-8 characters split across body chunks`, async () => {
      const text = "Café and 🦊";
      const stream = streamedResponse(JSON.stringify(payload(text)), undefined, 1);
      const output = await fetchContents({
        apiKey: "test-key",
        url: "https://example.com",
        fetchImpl: async () => stream.response,
      });

      expect(output.text).toBe(text);
      expect(stream.response.body?.locked).toBe(false);
    });
  }
});
