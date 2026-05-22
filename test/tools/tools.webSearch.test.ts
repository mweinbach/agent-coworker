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
  createNotebookEditTool,
  createReadTool,
  createSkillTool,
  createTodoWriteTool,
  createTools,
  createWebFetchTool,
  createWebSearchTool,
  createWriteTool,
  currentTodos,
  describe,
  expect,
  fs,
  getAiCoworkerPaths,
  listSessionToolNames,
  makeConfig,
  makeCtx,
  mock,
  onTodoChange,
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
