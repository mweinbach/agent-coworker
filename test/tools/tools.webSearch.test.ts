import {
  afterEach,
  bashInternal,
  beforeEach,
  createAskTool,
  createBashTool,
  createEditTool,
  createGlobTool,
  createGrepTool,
  createMemoryTool,
  createReadTool,
  createSkillTool,
  createTodoWriteTool,
  createTools,
  createWebFetchTool,
  createWebSearchTool,
  createWriteTool,
  describe,
  expect,
  fs,
  getAiCoworkerPaths,
  listSessionToolNames,
  makeConfig,
  makeCtx,
  mock,
  os,
  path,
  test,
  tmpDir,
  webFetchInternal,
  webSafetyInternal,
  withAuthHome,
  withEnv,
  writeConnectionStore,
  z,
} from "./tools.harness";

describe("webSearch tool", () => {
  const makeCustomSearchCtx = (dir: string) =>
    makeCtx(dir, {
      config: makeConfig(dir, {
        provider: "codex-cli",
        model: "gpt-5.3-codex",
        preferredChildModel: "gpt-5.3-codex",
      }),
    });

  test("uses Exa-backed web search", async () => {
    const dir = await tmpDir();
    const t: any = createWebSearchTool(
      makeCtx(dir, {
        config: makeConfig(dir, {
          provider: "google",
          model: "gemini-3-flash-preview",
          preferredChildModel: "gemini-3-flash-preview",
        }),
      }),
    );
    expect(t.type).toBeUndefined();
    expect(typeof t.execute).toBe("function");
    expect(t.description).toContain("EXA_API_KEY");
    expect(t.description).toContain("type/category");
  });

  test("openai/codex-style search advertises Exa key requirements", async () => {
    const dir = await tmpDir();
    const t: any = createWebSearchTool(
      makeCtx(dir, {
        config: makeConfig(dir, {
          provider: "openai",
          model: "gpt-5.2",
          preferredChildModel: "gpt-5.2",
        }),
      }),
    );

    expect(t.description).toContain("EXA_API_KEY");
    expect(t.description).not.toContain("BRAVE_API_KEY");
  });

  test("uses Parallel when the workspace selects the Parallel local search provider", async () => {
    const dir = await tmpDir();
    const oldExa = process.env.EXA_API_KEY;
    const oldParallel = process.env.PARALLEL_API_KEY;
    process.env.EXA_API_KEY = "exa_test_key";
    process.env.PARALLEL_API_KEY = "parallel_test_key";

    const originalFetch = globalThis.fetch;
    globalThis.fetch = mock(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      expect(url).not.toContain("api.exa.ai");
      expect(url).toBe("https://api.parallel.ai/v1beta/search");
      const body = JSON.parse(String(init?.body));
      expect(body.objective).toBe("latest parallel search updates");
      expect(body.search_queries).toEqual(["latest parallel search updates"]);
      expect(body.mode).toBe("agentic");
      expect(body.max_results).toBe(2);
      expect(body.excerpts).toMatchObject({
        max_chars_per_result: 2500,
        max_chars_total: 5000,
      });
      return new Response(
        JSON.stringify({
          search_id: "search-1",
          results: [
            {
              title: "Parallel result",
              url: "https://example.com/parallel",
              publish_date: "2026-06-01",
              excerpts: ["Parallel excerpt"],
            },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as any;

    try {
      const t: any = createWebSearchTool(
        makeCtx(dir, {
          config: makeConfig(dir, {
            provider: "google",
            model: "gemini-3.1-pro-preview",
            preferredChildModel: "gemini-3.1-pro-preview",
            providerOptions: {
              "codex-cli": {
                webSearchBackend: "parallel",
              },
              google: {
                nativeWebSearch: false,
              },
            },
          }),
        }),
      );
      expect(t.description).toContain("PARALLEL_API_KEY");
      expect(t.description).not.toContain("EXA_API_KEY");

      const out = await t.execute({
        query: " latest parallel search updates ",
        maxResults: 2,
        type: "deep",
        category: "company",
      });
      expect(out).toMatchObject({
        provider: "parallel",
        count: 1,
        request: {
          objective: "latest parallel search updates",
          search_queries: ["latest parallel search updates"],
          mode: "agentic",
          max_results: 2,
        },
      });
      expect((out as any).response.results).toEqual([
        {
          title: "Parallel result",
          url: "https://example.com/parallel",
          publish_date: "2026-06-01",
          excerpts: ["Parallel excerpt"],
        },
      ]);
      expect((globalThis.fetch as any).mock.calls).toHaveLength(1);
    } finally {
      globalThis.fetch = originalFetch;
      if (oldExa) process.env.EXA_API_KEY = oldExa;
      else delete process.env.EXA_API_KEY;
      if (oldParallel) process.env.PARALLEL_API_KEY = oldParallel;
      else delete process.env.PARALLEL_API_KEY;
    }
  });

  test("web search requires EXA_API_KEY", async () => {
    const dir = await tmpDir();
    const oldExa = process.env.EXA_API_KEY;
    delete process.env.EXA_API_KEY;

    try {
      await withAuthHome(dir, async () => {
        const t: any = createWebSearchTool(
          makeCtx(dir, {
            config: makeConfig(dir, {
              provider: "google",
              model: "gemini-3.1-pro-preview",
              preferredChildModel: "gemini-3.1-pro-preview",
            }),
          }),
        );
        const out: string = await t.execute({ query: "test", maxResults: 1 });
        expect(out).toContain("set EXA_API_KEY");
      });
    } finally {
      if (oldExa) process.env.EXA_API_KEY = oldExa;
      else delete process.env.EXA_API_KEY;
    }
  });

  test("returns disabled message without API keys", async () => {
    const dir = await tmpDir();
    const oldExa = process.env.EXA_API_KEY;
    delete process.env.EXA_API_KEY;

    try {
      await withAuthHome(dir, async () => {
        const t: any = createWebSearchTool(makeCustomSearchCtx(dir));
        const out: string = await t.execute({ query: "test", maxResults: 1 });
        expect(out).toContain("webSearch disabled");
      });
    } finally {
      if (oldExa) process.env.EXA_API_KEY = oldExa;
      else delete process.env.EXA_API_KEY;
    }
  });

  test("ignores BRAVE_API_KEY without Exa credentials", async () => {
    const dir = await tmpDir();
    const oldExa = process.env.EXA_API_KEY;
    const oldBrave = process.env.BRAVE_API_KEY;
    delete process.env.EXA_API_KEY;
    process.env.BRAVE_API_KEY = "brave_test_key";

    const originalFetch = globalThis.fetch;
    globalThis.fetch = mock(async () => {
      throw new Error("should not call Brave");
    }) as any;

    try {
      await withAuthHome(dir, async () => {
        const t: any = createWebSearchTool(makeCustomSearchCtx(dir));
        const out: string = await t.execute({ q: "HTTP 418 RFC 2324", maxResults: 1 });
        expect(out).toContain("webSearch disabled");
        expect(out).toContain("EXA_API_KEY");
        expect((globalThis.fetch as any).mock.calls).toHaveLength(0);
      });
    } finally {
      globalThis.fetch = originalFetch;
      if (oldExa) process.env.EXA_API_KEY = oldExa;
      else delete process.env.EXA_API_KEY;
      if (oldBrave) process.env.BRAVE_API_KEY = oldBrave;
      else delete process.env.BRAVE_API_KEY;
    }
  });

  test("accepts alias query keys for Exa search", async () => {
    const dir = await tmpDir();
    const oldExa = process.env.EXA_API_KEY;
    process.env.EXA_API_KEY = "exa_test_key";

    const originalFetch = globalThis.fetch;
    globalThis.fetch = mock(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      expect(body.query).toBe("latest sdk changelog");
      expect(body.numResults).toBe(3);
      expect(body.type).toBe("auto");
      expect(body.contents?.highlights?.maxCharacters).toBe(2500);
      expect(body.category).toBeUndefined();
      return new Response(
        JSON.stringify({
          results: [
            {
              title: "Result title",
              url: "https://example.com",
              highlights: ["Primary highlight"],
              text: "Fallback snippet",
            },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as any;

    try {
      const t: any = createWebSearchTool(makeCustomSearchCtx(dir));
      const out = await t.execute({
        searchQuery: "latest sdk changelog",
        maxResults: 3,
      });
      expect(out).toMatchObject({
        provider: "exa",
        count: 1,
        request: {
          query: "latest sdk changelog",
          numResults: 3,
          type: "auto",
        },
      });
      expect((out as any).response.results).toEqual([
        {
          title: "Result title",
          url: "https://example.com",
          highlights: ["Primary highlight"],
          text: "Fallback snippet",
        },
      ]);
    } finally {
      globalThis.fetch = originalFetch;
      if (oldExa) process.env.EXA_API_KEY = oldExa;
      else delete process.env.EXA_API_KEY;
    }
  });

  test("passes abort signal to Exa search requests", async () => {
    const dir = await tmpDir();
    const oldExa = process.env.EXA_API_KEY;
    process.env.EXA_API_KEY = "exa_test_key";
    const controller = new AbortController();

    const originalFetch = globalThis.fetch;
    globalThis.fetch = mock(async (_url: string, init?: RequestInit) => {
      expect(init?.signal).toBe(controller.signal);
      return new Response(JSON.stringify({ results: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as any;

    try {
      const t: any = createWebSearchTool(makeCtx(dir, { abortSignal: controller.signal }));
      await t.execute({ query: "latest sdk changelog", maxResults: 1 });
      expect((globalThis.fetch as any).mock.calls).toHaveLength(1);
    } finally {
      globalThis.fetch = originalFetch;
      if (oldExa) process.env.EXA_API_KEY = oldExa;
      else delete process.env.EXA_API_KEY;
    }
  });

  test("passes abort signal to Parallel search requests", async () => {
    const dir = await tmpDir();
    const oldParallel = process.env.PARALLEL_API_KEY;
    process.env.PARALLEL_API_KEY = "parallel_test_key";
    const controller = new AbortController();

    const originalFetch = globalThis.fetch;
    globalThis.fetch = mock(async (_url: string, init?: RequestInit) => {
      expect(init?.signal).toBe(controller.signal);
      return new Response(JSON.stringify({ results: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as any;

    try {
      const t: any = createWebSearchTool(
        makeCtx(dir, {
          abortSignal: controller.signal,
          config: makeConfig(dir, {
            providerOptions: {
              "codex-cli": {
                webSearchBackend: "parallel",
              },
            },
          }),
        }),
      );
      await t.execute({ query: "latest sdk changelog", maxResults: 1 });
      expect((globalThis.fetch as any).mock.calls).toHaveLength(1);
    } finally {
      globalThis.fetch = originalFetch;
      if (oldParallel) process.env.PARALLEL_API_KEY = oldParallel;
      else delete process.env.PARALLEL_API_KEY;
    }
  });

  test("propagates webSearch abort errors instead of returning them as output", async () => {
    const dir = await tmpDir();
    const oldExa = process.env.EXA_API_KEY;
    process.env.EXA_API_KEY = "exa_test_key";

    const originalFetch = globalThis.fetch;
    globalThis.fetch = mock(async () => {
      const err = new Error("The operation was aborted.");
      err.name = "AbortError";
      throw err;
    }) as any;

    try {
      const t: any = createWebSearchTool(makeCtx(dir));
      await expect(t.execute({ query: "cancel me", maxResults: 1 })).rejects.toThrow(/aborted/i);
    } finally {
      globalThis.fetch = originalFetch;
      if (oldExa) process.env.EXA_API_KEY = oldExa;
      else delete process.env.EXA_API_KEY;
    }
  });

  test("prefers the original turnUserPrompt over the latest steer fallback query", async () => {
    const dir = await tmpDir();
    const oldExa = process.env.EXA_API_KEY;
    process.env.EXA_API_KEY = "exa_test_key";

    const originalFetch = globalThis.fetch;
    globalThis.fetch = mock(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      expect(body.query).toBe("find recent bun releases");
      return new Response(JSON.stringify({ results: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as any;

    try {
      await withAuthHome(dir, async () => {
        const t: any = createWebSearchTool(
          makeCtx(dir, {
            turnUserPrompt: "find recent bun releases",
            getTurnUserPrompt: () => "make it concise",
          }),
        );
        await t.execute({});
        expect((globalThis.fetch as any).mock.calls).toHaveLength(1);
      });
    } finally {
      globalThis.fetch = originalFetch;
      if (oldExa) process.env.EXA_API_KEY = oldExa;
      else delete process.env.EXA_API_KEY;
    }
  });

  test("uses Exa even when BRAVE_API_KEY is configured", async () => {
    const dir = await tmpDir();
    const oldExa = process.env.EXA_API_KEY;
    const oldBrave = process.env.BRAVE_API_KEY;
    process.env.EXA_API_KEY = "exa_test_key";
    process.env.BRAVE_API_KEY = "brave_test_key";

    const originalFetch = globalThis.fetch;
    globalThis.fetch = mock(async (url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      expect(body.query).toBe("latest nvidia news");
      expect(body.numResults).toBe(5);
      expect(body.type).toBe("deep");
      expect(body.category).toBe("company");
      expect(body.contents?.highlights?.maxCharacters).toBe(2500);

      return new Response(
        JSON.stringify({
          results: [
            {
              title: "Nvidia result",
              url: "https://example.com/nvda",
              highlights: ["Deep company highlight"],
            },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as any;

    try {
      const t: any = createWebSearchTool(makeCustomSearchCtx(dir));
      const out = await t.execute({
        query: "latest nvidia news",
        maxResults: 5,
        type: "deep",
        category: "company",
      });
      expect(out).toMatchObject({
        provider: "exa",
        count: 1,
        request: {
          query: "latest nvidia news",
          numResults: 5,
          type: "deep",
          category: "company",
        },
      });
      expect((out as any).response.results).toEqual([
        {
          title: "Nvidia result",
          url: "https://example.com/nvda",
          highlights: ["Deep company highlight"],
        },
      ]);
    } finally {
      globalThis.fetch = originalFetch;
      if (oldExa) process.env.EXA_API_KEY = oldExa;
      else delete process.env.EXA_API_KEY;
      if (oldBrave) process.env.BRAVE_API_KEY = oldBrave;
      else delete process.env.BRAVE_API_KEY;
    }
  });

  test("normalizes the news article category alias to Exa news", async () => {
    const dir = await tmpDir();
    const oldExa = process.env.EXA_API_KEY;
    process.env.EXA_API_KEY = "exa_test_key";

    const originalFetch = globalThis.fetch;
    globalThis.fetch = mock(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      expect(body.type).toBe("auto");
      expect(body.category).toBe("news");
      expect(body.contents?.highlights?.maxCharacters).toBe(2500);

      return new Response(
        JSON.stringify({
          results: [
            {
              title: "News result",
              url: "https://example.com/news",
              highlights: ["News highlight"],
            },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as any;

    try {
      const t: any = createWebSearchTool(makeCustomSearchCtx(dir));
      const out = await t.execute({
        query: "latest nvidia news",
        category: "news article",
      });
      expect(out).toMatchObject({
        provider: "exa",
        count: 1,
        request: {
          query: "latest nvidia news",
          numResults: 10,
          type: "auto",
          category: "news",
        },
      });
      expect((out as any).response.results).toEqual([
        {
          title: "News result",
          url: "https://example.com/news",
          highlights: ["News highlight"],
        },
      ]);
    } finally {
      globalThis.fetch = originalFetch;
      if (oldExa) process.env.EXA_API_KEY = oldExa;
      else delete process.env.EXA_API_KEY;
    }
  });
});

// ---------------------------------------------------------------------------
// webFetch tool
// ---------------------------------------------------------------------------
