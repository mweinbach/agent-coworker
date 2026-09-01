import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import fs from "node:fs/promises";
import path from "node:path";

import { downloadGitHubDirectory, fetchWithGitHubAuth } from "../src/extensions/github";
import { __internal as tokenInternals } from "../src/extensions/githubToken";
import { scratchRoots } from "../src/platform/sandbox/policy";
import { createManualTimers, flushMicrotasks } from "./helpers/chaos";

const roots: string[] = [];
const savedEnv = { GITHUB_TOKEN: process.env.GITHUB_TOKEN, GH_TOKEN: process.env.GH_TOKEN };

beforeEach(() => {
  delete process.env.GITHUB_TOKEN;
  delete process.env.GH_TOKEN;
  tokenInternals.setForTests({ subprocessLookupEnabled: false });
});

afterEach(async () => {
  tokenInternals.resetForTests();
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

function manualTimeouts() {
  const timers = createManualTimers();
  const set = spyOn(globalThis, "setTimeout").mockImplementation(
    timers.scheduler.setTimeout as typeof setTimeout,
  );
  const clear = spyOn(globalThis, "clearTimeout").mockImplementation(
    timers.scheduler.clearTimeout as typeof clearTimeout,
  );
  return {
    timers,
    restore() {
      set.mockRestore();
      clear.mockRestore();
    },
  };
}

function fileEntry(name: string, parent = "") {
  return {
    type: "file",
    name,
    path: parent ? `${parent}/${name}` : name,
    url: "https://api.github.com/unused",
    download_url: `https://downloads.example/${name}`,
  };
}

async function destination() {
  const root = await fs.mkdtemp(path.join(scratchRoots()[0], "github-extension-downloader-"));
  roots.push(root);
  return path.join(root, "download");
}

describe("bounded GitHub transport", () => {
  test("retains the original response and its metadata after buffering the body", async () => {
    const upstream = new Response("original bytes", { headers: { "x-test": "original" } });
    const response = await fetchWithGitHubAuth(
      (async (_input: RequestInfo | URL) => upstream) as typeof fetch,
      "https://api.github.com/repos/a/b",
    );
    expect(response).toBe(upstream);
    expect(response.headers.get("x-test")).toBe("original");
    expect(await response.text()).toBe("original bytes");
  });

  test("times out noncooperative headers and cancels a response arriving after timeout", async () => {
    const clock = manualTimeouts();
    const requested = Promise.withResolvers<void>();
    const headers = Promise.withResolvers<Response>();
    let cancelled = false;
    const pending = fetchWithGitHubAuth(
      (async (_input: RequestInfo | URL) => {
        requested.resolve();
        return await headers.promise;
      }) as typeof fetch,
      "https://api.github.com/repos/a/b",
    );
    void pending.catch(() => {});
    try {
      await requested.promise;
      expect(clock.timers.timeoutCallbacks).toHaveLength(1);
      clock.timers.timeoutCallbacks[0]?.();
      await expect(pending).rejects.toThrow(/timed out/i);
      headers.resolve(
        new Response(
          new ReadableStream({
            cancel() {
              cancelled = true;
            },
          }),
        ),
      );
      await flushMicrotasks();
      await flushMicrotasks();
      expect(cancelled).toBe(true);
      expect(clock.timers.timeoutCallbacks).toHaveLength(0);
    } finally {
      headers.resolve(new Response("done"));
      await pending.catch(() => {});
      clock.restore();
    }
  });

  test("bounds the body even when stream cancellation never settles", async () => {
    const clock = manualTimeouts();
    const requested = Promise.withResolvers<void>();
    const cancellation = Promise.withResolvers<void>();
    let cancelled = false;
    let body: ReadableStreamDefaultController<Uint8Array>;
    const response = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          body = controller;
          controller.enqueue(new TextEncoder().encode("prefix"));
        },
        cancel() {
          cancelled = true;
          return cancellation.promise;
        },
      }),
    );
    const pending = fetchWithGitHubAuth(
      (async (_input: RequestInfo | URL) => {
        requested.resolve();
        return response;
      }) as typeof fetch,
      "https://api.github.com/repos/a/b",
    ).then((result) => result.text());
    void pending.catch(() => {});
    try {
      await requested.promise;
      await flushMicrotasks();
      expect(clock.timers.timeoutCallbacks).toHaveLength(1);
      clock.timers.timeoutCallbacks[0]?.();
      await expect(pending).rejects.toThrow(/timed out/i);
      expect(cancelled).toBe(true);
      expect(clock.timers.timeoutCallbacks).toHaveLength(0);
    } finally {
      cancellation.resolve();
      try {
        body!.close();
      } catch {
        /* already cancelled */
      }
      await pending.catch(() => {});
      clock.restore();
    }
  });

  test("cancels rejected authenticated bodies before retrying anonymously", async () => {
    process.env.GITHUB_TOKEN = "gho_dummy_rejected";
    let cancelled = false;
    const response = await fetchWithGitHubAuth(
      (async (_url, init) => {
        if ((init?.headers as Record<string, string> | undefined)?.Authorization) {
          return new Response(
            new ReadableStream({
              cancel() {
                cancelled = true;
              },
            }),
            { status: 403 },
          );
        }
        expect(cancelled).toBe(true);
        return new Response("public", { headers: { "x-github-request-id": "test-only" } });
      }) as typeof fetch,
      "https://api.github.com/repos/a/b",
    );
    expect(await response.text()).toBe("public");
    expect(response.headers.get("x-github-request-id")).toBe("test-only");
  });

  test("bounds bytes actually received even without a content-length header", async () => {
    await expect(
      fetchWithGitHubAuth(
        (async (_input: RequestInfo | URL) =>
          new Response("more than eight bytes")) as typeof fetch,
        "https://api.github.com/repos/a/b",
        undefined,
        { maxBytes: 8 },
      ),
    ).rejects.toThrow(/byte limit/i);
  });

  test("preserves caller cancellation and never starts an already-aborted request", async () => {
    const caller = new AbortController();
    const requested = Promise.withResolvers<void>();
    const delayed = Promise.withResolvers<Response>();
    let calls = 0;
    const fetchImpl = (async (_input: RequestInfo | URL) => {
      calls += 1;
      requested.resolve();
      return await delayed.promise;
    }) as typeof fetch;
    const pending = fetchWithGitHubAuth(fetchImpl, "https://api.github.com/repos/a/b", undefined, {
      signal: caller.signal,
    });
    void pending.catch(() => {});
    try {
      await requested.promise;
      caller.abort(new Error("user cancelled install"));
      await expect(pending).rejects.toThrow("user cancelled install");
      await expect(
        fetchWithGitHubAuth(fetchImpl, "https://api.github.com/repos/a/b", undefined, {
          signal: caller.signal,
        }),
      ).rejects.toThrow("user cancelled install");
      expect(calls).toBe(1);
    } finally {
      delayed.resolve(new Response("late"));
      await pending.catch(() => {});
    }
  });
});

describe("bounded GitHub directory downloads", () => {
  test("downloads independent files with capped concurrency", async () => {
    const destDir = await destination();
    const first = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let active = 0;
    let peak = 0;
    const pending = downloadGitHubDirectory({
      repo: "a/b",
      ref: "feature/branch",
      githubPath: "",
      destDir,
      fetchImpl: (async (input) => {
        if (String(input).startsWith("https://api.github.com/")) {
          return Response.json(Array.from({ length: 7 }, (_, index) => fileEntry(`${index}.txt`)));
        }
        active += 1;
        peak = Math.max(peak, active);
        first.resolve();
        await release.promise;
        active -= 1;
        return new Response("file bytes");
      }) as typeof fetch,
    });
    try {
      await first.promise;
      for (let index = 0; index < 8; index += 1) await flushMicrotasks();
      expect(active).toBe(4);
      release.resolve();
      await pending;
      expect(peak).toBe(4);
      expect((await fs.readdir(destDir)).sort()).toEqual(
        Array.from({ length: 7 }, (_, index) => `${index}.txt`),
      );
    } finally {
      release.resolve();
      await pending.catch(() => {});
    }
  });

  test("rejects an oversized directory listing before fetching its files", async () => {
    let fileRequests = 0;
    await expect(
      downloadGitHubDirectory({
        repo: "a/b",
        ref: "main",
        githubPath: "",
        destDir: await destination(),
        limits: { maxEntries: 3 },
        fetchImpl: (async (input) => {
          if (String(input).startsWith("https://api.github.com/")) {
            return Response.json(
              Array.from({ length: 4 }, (_, index) => fileEntry(`${index}.txt`)),
            );
          }
          fileRequests += 1;
          throw new Error("Unbounded file requested");
        }) as typeof fetch,
      }),
    ).rejects.toThrow(/entry limit/i);
    expect(fileRequests).toBe(0);
  });

  test("enforces a total download byte budget", async () => {
    await expect(
      downloadGitHubDirectory({
        repo: "a/b",
        ref: "main",
        githubPath: "",
        destDir: await destination(),
        limits: { maxBytes: 6 },
        fetchImpl: (async (input) =>
          String(input).startsWith("https://api.github.com/")
            ? Response.json([fileEntry("a.txt"), fileEntry("b.txt")])
            : new Response("four")) as typeof fetch,
      }),
    ).rejects.toThrow(/byte limit/i);
  });

  test("bounds recursive directory depth", async () => {
    await expect(
      downloadGitHubDirectory({
        repo: "a/b",
        ref: "main",
        githubPath: "",
        destDir: await destination(),
        limits: { maxDepth: 2 },
        fetchImpl: (async (input) => {
          const directory = new URL(String(input)).pathname.split("/contents/")[1] ?? "";
          if (directory.split("/").filter(Boolean).length >= 4) return Response.json([]);
          const child = directory ? `${directory}/nested` : "nested";
          return Response.json([
            { ...fileEntry("nested"), type: "dir", path: child, download_url: null },
          ]);
        }) as typeof fetch,
      }),
    ).rejects.toThrow(/depth limit/i);
  });

  test("aborts and settles active siblings before a failed download returns", async () => {
    const destDir = await destination();
    const allStarted = Promise.withResolvers<void>();
    const delayed = Promise.withResolvers<Response>();
    let files = 0;
    let cancelled = 0;
    const pending = downloadGitHubDirectory({
      repo: "a/b",
      ref: "main",
      githubPath: "",
      destDir,
      fetchImpl: (async (input) => {
        const url = String(input);
        if (url.startsWith("https://api.github.com/")) {
          return Response.json(Array.from({ length: 6 }, (_, index) => fileEntry(`${index}.txt`)));
        }
        files += 1;
        if (files === 4) allStarted.resolve();
        if (url.endsWith("0.txt")) {
          await allStarted.promise;
          return new Response("failed file", { status: 500 });
        }
        await delayed.promise;
        return new Response(
          new ReadableStream({
            cancel() {
              cancelled += 1;
            },
          }),
        );
      }) as typeof fetch,
    });
    try {
      await expect(pending).rejects.toThrow("failed file");
      expect(files).toBe(4);
      expect(await fs.readdir(destDir)).toEqual([]);
      delayed.resolve(new Response("release"));
      for (let index = 0; index < 8; index += 1) await flushMicrotasks();
      expect(cancelled).toBe(3);
      expect(await fs.readdir(destDir)).toEqual([]);
    } finally {
      allStarted.resolve();
      delayed.resolve(new Response("release"));
      await pending.catch(() => {});
    }
  });

  test("bounds the whole directory operation and does not schedule files after cancellation", async () => {
    const destDir = await destination();
    const clock = manualTimeouts();
    const fileStarted = Promise.withResolvers<void>();
    const delayed = Promise.withResolvers<Response>();
    let files = 0;
    const pending = downloadGitHubDirectory({
      repo: "a/b",
      ref: "main",
      githubPath: "",
      destDir,
      fetchImpl: (async (input) => {
        if (String(input).startsWith("https://api.github.com/"))
          return Response.json([fileEntry("a.txt"), fileEntry("b.txt")]);
        files += 1;
        fileStarted.resolve();
        return await delayed.promise;
      }) as typeof fetch,
    });
    void pending.catch(() => {});
    try {
      await fileStarted.promise;
      clock.timers.timeoutCallbacks[0]?.();
      await expect(pending).rejects.toThrow(/directory download timed out/i);
      expect(clock.timers.timeoutCallbacks).toHaveLength(0);
      const startedBeforeReturn = files;
      delayed.resolve(new Response("late"));
      for (let index = 0; index < 8; index += 1) await flushMicrotasks();
      expect(files).toBe(startedBeforeReturn);
      expect(await fs.readdir(destDir)).toEqual([]);
    } finally {
      delayed.resolve(new Response("release"));
      await pending.catch(() => {});
      clock.restore();
    }
  });

  test.each(["../escape.txt", ".. ", "NUL.txt"])(
    "rejects unsafe entry name %s before writing",
    async (name) => {
      const destDir = await destination();
      await expect(
        downloadGitHubDirectory({
          repo: "a/b",
          ref: "main",
          githubPath: "",
          destDir,
          fetchImpl: (async (_input: RequestInfo | URL) =>
            Response.json([fileEntry(name)])) as typeof fetch,
        }),
      ).rejects.toThrow(/invalid entry name/i);
      expect(await fs.readdir(destDir)).toEqual([]);
      expect(await fs.exists(path.join(destDir, "..", "escape.txt"))).toBe(false);
    },
  );
});
