import { describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { ToolContext } from "../src/tools/context";
import { fetchExaContents, resolveExaApiKey } from "../src/tools/exa";

function makeCtx(userAgentDir: string): ToolContext {
  return {
    config: { userAgentDir } as any,
    log: () => {},
    askUser: async () => "",
    approveCommand: async () => true,
  };
}

async function makeCoworkHome() {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "exa-test-"));
  const userAgentDir = path.join(tmp, ".agent-user");
  await fs.mkdir(userAgentDir, { recursive: true });
  const authDir = path.join(tmp, ".cowork", "auth");
  await fs.mkdir(authDir, { recursive: true });
  return { tmp, userAgentDir, authDir };
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
    const { tmp, userAgentDir, authDir } = await makeCoworkHome();
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
        async () => await resolveExaApiKey(makeCtx(userAgentDir)),
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
    const { tmp, userAgentDir } = await makeCoworkHome();

    const prev = process.env.EXA_API_KEY;
    process.env.EXA_API_KEY = "env-key";
    try {
      const result = await withEnv(
        "HOME",
        tmp,
        async () => await resolveExaApiKey(makeCtx(userAgentDir)),
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
    const { tmp, userAgentDir } = await makeCoworkHome();
    const authFile = path.join(path.dirname(userAgentDir), ".cowork", "auth", "connections.json");
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
        async () => await resolveExaApiKey(makeCtx(userAgentDir)),
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
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        statusText: "OK",
        text: async () => "",
        json: async () => ({
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
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        statusText: "OK",
        text: async () => "",
        json: async () => ({
          results: [
            {
              highlights: ["first highlight", "second highlight"],
            },
          ],
        }),
      }),
    });

    expect(output.text).toBe("first highlight\n\nsecond highlight");
  });

  test("fetchExaContents throws when no result or content", async () => {
    await expect(
      fetchExaContents({
        apiKey: "key",
        url: "https://example.com",
        fetchImpl: async () => ({
          ok: true,
          status: 200,
          statusText: "OK",
          text: async () => "",
          json: async () => ({}),
        }),
      }),
    ).rejects.toThrow("no result");

    await expect(
      fetchExaContents({
        apiKey: "key",
        url: "https://example.com",
        fetchImpl: async () => ({
          ok: true,
          status: 200,
          statusText: "OK",
          text: async () => "",
          json: async () => ({
            results: [
              {
                text: "",
                highlights: [],
                extras: { links: [], imageLinks: [] },
              },
            ],
          }),
        }),
      }),
    ).rejects.toThrow("no content");
  });
});
