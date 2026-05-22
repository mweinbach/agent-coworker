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

describe("webFetch tool", () => {
  const toFetchUrl = (input: string | URL | Request) =>
    typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;

  beforeEach(() => {
    webFetchInternal.setHtmlToMarkdownForTests(async (html: string) =>
      html
        .replace(/<script\b[\s\S]*?<\/script>/gi, " ")
        .replace(/<style\b[\s\S]*?<\/style>/gi, " ")
        .replace(/<noscript\b[\s\S]*?<\/noscript>/gi, " ")
        .replace(/<template\b[\s\S]*?<\/template>/gi, " ")
        .replace(/<[^>]+>/g, " ")
        .replace(/\s+/g, " ")
        .trim(),
    );
    webFetchInternal.setMaxDownloadBytes(50 * 1024 * 1024);
    webFetchInternal.setResponseTimeoutMs(5_000);
    webSafetyInternal.setDnsLookup(async () => [{ address: "93.184.216.34", family: 4 }]);
  });

  afterEach(() => {
    webFetchInternal.resetHtmlToMarkdownForTests();
    webSafetyInternal.resetDnsLookup();
  });

  const createStreamingResponse = (bytes: Uint8Array, init: ResponseInit, chunkSize = 4) => {
    const response = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          for (let offset = 0; offset < bytes.length; offset += chunkSize) {
            controller.enqueue(bytes.slice(offset, offset + chunkSize));
          }
          controller.close();
        },
      }),
      init,
    );
    Object.defineProperty(response, "arrayBuffer", {
      value: async () => {
        throw new Error("should not buffer direct downloads");
      },
    });
    return response;
  };

  const createBodylessDownloadResponse = (
    bytes: Uint8Array,
    init: ResponseInit,
    options: { includeContentLength?: boolean } = {},
  ) => {
    const headers = new Headers(init.headers);
    if (options.includeContentLength !== false) {
      headers.set("Content-Length", String(bytes.length));
    }

    const response = new Response(null, {
      ...init,
      headers,
    });
    Object.defineProperty(response, "body", {
      value: null,
    });
    Object.defineProperty(response, "arrayBuffer", {
      value: async () => Uint8Array.from(bytes).buffer,
    });
    return response;
  };

  test("returns cleaned local HTML and appends Exa links when available", async () => {
    const dir = await tmpDir();
    const oldExa = process.env.EXA_API_KEY;
    process.env.EXA_API_KEY = "exa_test_key";

    const originalFetch = globalThis.fetch;
    globalThis.fetch = mock(async (input: string | URL | Request, init?: RequestInit) => {
      const fetchUrl = toFetchUrl(input);
      if (fetchUrl.includes("api.exa.ai/contents")) {
        const body = JSON.parse(String(init?.body));
        expect(body.urls).toEqual(["https://example.com/"]);
        return new Response(
          JSON.stringify({
            results: [
              {
                url: "https://example.com/",
                text: "# Hello from Exa\n\nFetched remotely.",
                extras: {
                  links: ["https://example.com/about", "https://example.com/contact"],
                  imageLinks: ["https://cdn.example.com/hero.png"],
                },
              },
            ],
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        );
      }

      return new Response(
        "<!doctype html><html><head><style>.bad{display:none}</style><script>window.hacked = true</script></head><body><main><article><h1>Hello world</h1><p>Local HTML should win.</p></article></main></body></html>",
        {
          status: 200,
          headers: { "Content-Type": "text/html" },
        },
      );
    }) as any;

    try {
      const t: any = createWebFetchTool(makeCtx(dir));
      const out: string = await t.execute({ url: "https://example.com", maxLength: 50000 });
      expect(out).toContain("Hello world");
      expect(out).toContain("Local HTML should win.");
      expect(out).not.toContain("Hello from Exa");
      expect(out).not.toContain("window.hacked");
      expect(out).not.toContain(".bad");
      expect(out).toContain("Links:");
      expect(out).toContain("https://example.com/about");
      expect(out).toContain("Image Links:");
      expect(out).toContain("https://cdn.example.com/hero.png");
    } finally {
      globalThis.fetch = originalFetch;
      if (oldExa) process.env.EXA_API_KEY = oldExa;
      else delete process.env.EXA_API_KEY;
    }
  });

  test("returns cleaned local HTML and appends Parallel extract links when configured", async () => {
    const dir = await tmpDir();
    const oldParallel = process.env.PARALLEL_API_KEY;
    process.env.PARALLEL_API_KEY = "parallel_test_key";

    const originalFetch = globalThis.fetch;
    globalThis.fetch = mock(async (input: string | URL | Request, init?: RequestInit) => {
      const fetchUrl = toFetchUrl(input);
      if (fetchUrl.includes("api.parallel.ai/v1beta/extract")) {
        const body = JSON.parse(String(init?.body));
        expect(body.urls).toEqual(["https://example.com/"]);
        expect(body.objective).toBe(
          "Extract the most relevant content from https://example.com/ for browsing and follow-up reading.",
        );
        expect(body.excerpts).toEqual({ max_chars_per_result: 4000, max_chars_total: 4000 });
        expect(body.full_content).toBe(false);
        return new Response(
          JSON.stringify({
            results: [
              {
                url: "https://example.com/",
                excerpts: ["# Hello from Parallel\n\nFetched remotely."],
                links: ["https://example.com/about", "https://example.com/contact"],
                image_links: ["https://cdn.example.com/hero.png"],
              },
            ],
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        );
      }

      return new Response(
        "<!doctype html><html><body><main><article><h1>Hello world</h1><p>Local HTML should win.</p></article></main></body></html>",
        {
          status: 200,
          headers: { "Content-Type": "text/html" },
        },
      );
    }) as any;

    try {
      const t: any = createWebFetchTool(
        makeCtx(dir, {
          config: makeConfig(dir, {
            providerOptions: {
              "codex-cli": {
                webSearchBackend: "parallel",
              },
            },
          }),
        }),
      );
      const out: string = await t.execute({ url: "https://example.com", maxLength: 50000 });
      expect(out).toContain("Hello world");
      expect(out).toContain("Local HTML should win.");
      expect(out).not.toContain("Hello from Parallel");
      expect(out).toContain("Links:");
      expect(out).toContain("https://example.com/about");
      expect(out).toContain("Image Links:");
      expect(out).toContain("https://cdn.example.com/hero.png");
    } finally {
      globalThis.fetch = originalFetch;
      if (oldParallel) process.env.PARALLEL_API_KEY = oldParallel;
      else delete process.env.PARALLEL_API_KEY;
    }
  });

  test("returns cleaned local HTML without Exa credentials", async () => {
    const dir = await tmpDir();
    const oldExa = process.env.EXA_API_KEY;
    delete process.env.EXA_API_KEY;
    let exaCalls = 0;

    const originalFetch = globalThis.fetch;
    globalThis.fetch = mock(async (input: string | URL | Request) => {
      if (toFetchUrl(input).includes("api.exa.ai/contents")) {
        exaCalls += 1;
      }

      return new Response(
        "<html><body><article><h1>Offline page</h1><p>Rendered locally.</p></article></body></html>",
        {
          status: 200,
          headers: { "Content-Type": "text/html" },
        },
      );
    }) as any;

    try {
      await withAuthHome(dir, async () => {
        const t: any = createWebFetchTool(makeCtx(dir));
        const out: string = await t.execute({
          url: "https://example.com/fallback",
          maxLength: 50000,
        });
        expect(out).toContain("Offline page");
        expect(out).toContain("Rendered locally.");
        expect(exaCalls).toBe(0);
      });
    } finally {
      globalThis.fetch = originalFetch;
      if (oldExa) process.env.EXA_API_KEY = oldExa;
      else delete process.env.EXA_API_KEY;
    }
  });

  test("falls back to local HTML when Exa enrichment fails", async () => {
    const dir = await tmpDir();
    const oldExa = process.env.EXA_API_KEY;
    process.env.EXA_API_KEY = "exa_test_key";

    const originalFetch = globalThis.fetch;
    globalThis.fetch = mock(async (input: string | URL | Request) => {
      const fetchUrl = toFetchUrl(input);
      if (fetchUrl.includes("api.exa.ai/contents")) {
        return new Response("upstream unavailable", {
          status: 502,
          statusText: "Bad Gateway",
          headers: { "Content-Type": "text/plain" },
        });
      }

      return new Response(
        "<html><body><article><h1>Fallback page</h1><p>Use local content.</p></article></body></html>",
        {
          status: 200,
          headers: { "Content-Type": "text/html" },
        },
      );
    }) as any;

    try {
      const t: any = createWebFetchTool(makeCtx(dir));
      const out: string = await t.execute({ url: "https://example.com/page", maxLength: 50000 });
      expect(out).toContain("Fallback page");
      expect(out).toContain("Use local content.");
    } finally {
      globalThis.fetch = originalFetch;
      if (oldExa) process.env.EXA_API_KEY = oldExa;
      else delete process.env.EXA_API_KEY;
    }
  });

  test("preserves direct text responses instead of routing them through Exa", async () => {
    const dir = await tmpDir();
    const oldExa = process.env.EXA_API_KEY;
    process.env.EXA_API_KEY = "exa_test_key";
    let exaCalls = 0;

    const originalFetch = globalThis.fetch;
    globalThis.fetch = mock(async (input: string | URL | Request) => {
      if (toFetchUrl(input).includes("api.exa.ai/contents")) {
        exaCalls += 1;
        throw new Error("should not call Exa for direct text");
      }

      return new Response('{"ok":true,"source":"origin"}', {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as any;

    try {
      const t: any = createWebFetchTool(makeCtx(dir));
      const out: string = await t.execute({
        url: "https://example.com/data.json",
        maxLength: 50000,
      });
      expect(out).toBe('{"ok":true,"source":"origin"}');
      expect(exaCalls).toBe(0);
    } finally {
      globalThis.fetch = originalFetch;
      if (oldExa) process.env.EXA_API_KEY = oldExa;
      else delete process.env.EXA_API_KEY;
    }
  });

  test("downloads markdown documents when served with text MIME and a supported document filename", async () => {
    const dir = await tmpDir();
    const cases = [
      {
        url: "https://example.com/docs/README.md",
        fileName: "README.md",
        contentType: "text/plain",
        contentDisposition: null,
        body: "# Release Notes\n\n- item\n",
      },
      {
        url: "https://example.com/download",
        fileName: "release-notes.markdown",
        contentType: "text/markdown",
        contentDisposition: 'attachment; filename="release-notes.markdown"',
        body: "# Changelog\n\n- shipped\n",
      },
    ] as const;

    const originalFetch = globalThis.fetch;
    try {
      for (const testCase of cases) {
        globalThis.fetch = mock(async () => {
          return new Response(testCase.body, {
            status: 200,
            headers: {
              "Content-Type": testCase.contentType,
              ...(testCase.contentDisposition
                ? { "Content-Disposition": testCase.contentDisposition }
                : {}),
            },
          });
        }) as any;

        const t: any = createWebFetchTool(makeCtx(dir));
        const out: string = await t.execute({ url: testCase.url, maxLength: 50000 });
        const downloadedPath = path.join(dir, "Downloads", testCase.fileName);

        expect(out).toBe(`File downloaded ${downloadedPath}`);
        expect(await fs.readFile(downloadedPath, "utf-8")).toBe(testCase.body);
      }
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("downloads CSV documents from text/csv MIME even without a filename extension", async () => {
    const dir = await tmpDir();
    const csv = "month,amount\nJan,10\n";

    const originalFetch = globalThis.fetch;
    globalThis.fetch = mock(async () => {
      return new Response(csv, {
        status: 200,
        headers: { "Content-Type": "text/csv" },
      });
    }) as any;

    try {
      const t: any = createWebFetchTool(makeCtx(dir));
      const out: string = await t.execute({ url: "https://example.com/export", maxLength: 50000 });
      const downloadedPath = path.join(dir, "Downloads", "export.csv");

      expect(out).toBe(`File downloaded ${downloadedPath}`);
      expect(await fs.readFile(downloadedPath, "utf-8")).toBe(csv);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("keeps the supported URL document extension when content-disposition uses a non-document filename", async () => {
    const dir = await tmpDir();
    const markdown = "# Read me\n";

    const originalFetch = globalThis.fetch;
    globalThis.fetch = mock(async () => {
      return new Response(markdown, {
        status: 200,
        headers: {
          "Content-Type": "text/plain",
          "Content-Disposition": 'attachment; filename="README.txt"',
        },
      });
    }) as any;

    try {
      const t: any = createWebFetchTool(makeCtx(dir));
      const out: string = await t.execute({
        url: "https://example.com/docs/README.md",
        maxLength: 50000,
      });
      const downloadedPath = path.join(dir, "Downloads", "README.md");

      expect(out).toBe(`File downloaded ${downloadedPath}`);
      expect(await fs.readFile(downloadedPath, "utf-8")).toBe(markdown);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("downloads body-less direct downloads when content-length is declared", async () => {
    const dir = await tmpDir();
    const markdownBytes = Buffer.from("# Cached README\n");

    const originalFetch = globalThis.fetch;
    globalThis.fetch = mock(async () => {
      return createBodylessDownloadResponse(markdownBytes, {
        status: 200,
        headers: {
          "Content-Type": "text/plain",
          "Content-Disposition": 'attachment; filename="README.md"',
        },
      });
    }) as any;

    try {
      const t: any = createWebFetchTool(makeCtx(dir));
      const out: string = await t.execute({
        url: "https://example.com/download",
        maxLength: 50000,
      });
      const downloadedPath = path.join(dir, "Downloads", "README.md");

      expect(out).toBe(`File downloaded ${downloadedPath}`);
      expect(await fs.readFile(downloadedPath)).toEqual(markdownBytes);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("rejects body-less direct downloads without a content-length header", async () => {
    const dir = await tmpDir();
    const pdfBytes = Buffer.from("%PDF-1.7\nbodyless\n");

    const originalFetch = globalThis.fetch;
    globalThis.fetch = mock(async () => {
      return createBodylessDownloadResponse(
        pdfBytes,
        {
          status: 200,
          headers: { "Content-Type": "application/pdf" },
        },
        { includeContentLength: false },
      );
    }) as any;

    try {
      const t: any = createWebFetchTool(makeCtx(dir));
      await expect(
        t.execute({ url: "https://example.com/reports/bodyless.pdf", maxLength: 50000 }),
      ).rejects.toThrow(/without a readable body or content-length header/i);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("truncates inline content to maxLength", async () => {
    const dir = await tmpDir();

    const originalFetch = globalThis.fetch;
    globalThis.fetch = mock(async () => {
      return new Response("x".repeat(10_000), {
        status: 200,
        headers: { "Content-Type": "text/plain" },
      });
    }) as any;

    try {
      const t: any = createWebFetchTool(makeCtx(dir));
      const out: string = await t.execute({
        url: "https://example.com/notes.txt",
        maxLength: 1000,
      });
      expect(out.length).toBeLessThanOrEqual(1000);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("handles fetch errors", async () => {
    const dir = await tmpDir();

    const originalFetch = globalThis.fetch;
    globalThis.fetch = mock(async () => {
      throw new Error("Network error");
    }) as any;

    try {
      const t: any = createWebFetchTool(makeCtx(dir));
      await expect(t.execute({ url: "https://example.com/bad", maxLength: 50000 })).rejects.toThrow(
        "Network error",
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("blocks localhost/private URLs", async () => {
    const dir = await tmpDir();
    const t: any = createWebFetchTool(makeCtx(dir));
    await expect(t.execute({ url: "http://127.0.0.1/internal", maxLength: 50000 })).rejects.toThrow(
      /private\/internal host/i,
    );
  });

  test("rejects redirect to blocked private host", async () => {
    const dir = await tmpDir();

    const originalFetch = globalThis.fetch;
    globalThis.fetch = mock(async () => {
      return new Response(null, {
        status: 302,
        headers: { Location: "http://127.0.0.1/admin" },
      });
    }) as any;

    try {
      const t: any = createWebFetchTool(makeCtx(dir));
      await expect(t.execute({ url: "https://example.com", maxLength: 50000 })).rejects.toThrow(
        /private\/internal host/i,
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("downloads PDFs into the workspace Downloads folder", async () => {
    const dir = await tmpDir();
    const pdfBytes = Buffer.from("%PDF-1.7\nfake\n");

    const originalFetch = globalThis.fetch;
    globalThis.fetch = mock(async () => {
      return createStreamingResponse(pdfBytes, {
        status: 200,
        headers: { "Content-Type": "application/pdf" },
      });
    }) as any;

    try {
      const t: any = createWebFetchTool(makeCtx(dir));
      const out: string = await t.execute({
        url: "https://example.com/reports/q1-summary.pdf",
        maxLength: 50000,
      });
      const downloadedPath = path.join(dir, "Downloads", "q1-summary.pdf");

      expect(out).toBe(`File downloaded ${downloadedPath}`);
      expect(await fs.readFile(downloadedPath)).toEqual(pdfBytes);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("blocks downloads for no-write roles", async () => {
    const dir = await tmpDir();
    const pdfBytes = Buffer.from("%PDF-1.7\nfake\n");

    const originalFetch = globalThis.fetch;
    globalThis.fetch = mock(async () => {
      return createStreamingResponse(pdfBytes, {
        status: 200,
        headers: { "Content-Type": "application/pdf" },
      });
    }) as any;

    try {
      const t: any = createWebFetchTool(makeCtx(dir, { shellPolicy: "no_project_write" }));
      await expect(
        t.execute({
          url: "https://example.com/reports/q1-summary.pdf",
          maxLength: 50000,
        }),
      ).rejects.toThrow("webFetch downloads are disabled for read-only roles");
      await expect(fs.readdir(path.join(dir, "Downloads"))).rejects.toThrow();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("cleans up partial downloads when a streamed response exceeds the size limit", async () => {
    const dir = await tmpDir();
    webFetchInternal.setMaxDownloadBytes(8);

    const originalFetch = globalThis.fetch;
    globalThis.fetch = mock(async () => {
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(Buffer.from("12345"));
            controller.enqueue(Buffer.from("67890"));
            controller.close();
          },
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/pdf" },
        },
      );
    }) as any;

    try {
      const t: any = createWebFetchTool(makeCtx(dir));
      await expect(
        t.execute({ url: "https://example.com/reports/too-large.pdf", maxLength: 50000 }),
      ).rejects.toThrow(/8 bytes limit/i);
      expect(await fs.readdir(path.join(dir, "Downloads"))).toEqual([]);
    } finally {
      globalThis.fetch = originalFetch;
      webFetchInternal.setMaxDownloadBytes(50 * 1024 * 1024);
    }
  });

  test("downloads office documents from document MIME types and content-disposition filenames", async () => {
    const dir = await tmpDir();
    const cases = [
      {
        mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        fileName: "quarterly report.docx",
      },
      {
        mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        fileName: "planning sheet.xlsx",
      },
      {
        mimeType: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        fileName: "board deck.pptx",
      },
    ] as const;

    const originalFetch = globalThis.fetch;

    try {
      for (const testCase of cases) {
        const bytes = Buffer.from(`bytes:${testCase.fileName}`);
        globalThis.fetch = mock(async () => {
          return new Response(bytes, {
            status: 200,
            headers: {
              "Content-Type": testCase.mimeType,
              "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(testCase.fileName)}`,
            },
          });
        }) as any;

        const t: any = createWebFetchTool(makeCtx(dir));
        const out: string = await t.execute({
          url: "https://example.com/download",
          maxLength: 50000,
        });
        const downloadedPath = path.join(dir, "Downloads", testCase.fileName);

        expect(out).toBe(`File downloaded ${downloadedPath}`);
        expect(await fs.readFile(downloadedPath)).toEqual(bytes);
      }
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("downloads recognized document extensions even when served as octet-stream", async () => {
    const dir = await tmpDir();
    const cases = [
      { url: "https://example.com/exports/budget.xlsx", fileName: "budget.xlsx" },
      { url: "https://example.com/exports/slides.pptx", fileName: "slides.pptx" },
    ] as const;

    const originalFetch = globalThis.fetch;

    try {
      for (const testCase of cases) {
        const bytes = Buffer.from(`bytes:${testCase.fileName}`);
        globalThis.fetch = mock(async () => {
          return new Response(bytes, {
            status: 200,
            headers: { "Content-Type": "application/octet-stream" },
          });
        }) as any;

        const t: any = createWebFetchTool(makeCtx(dir));
        const out: string = await t.execute({ url: testCase.url, maxLength: 50000 });
        const downloadedPath = path.join(dir, "Downloads", testCase.fileName);

        expect(out).toBe(`File downloaded ${downloadedPath}`);
        expect(await fs.readFile(downloadedPath)).toEqual(bytes);
      }
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("downloads markdown attachments when octet-stream filenames come from content-disposition", async () => {
    const dir = await tmpDir();
    const cases = ["README.md", "release-notes.markdown"] as const;

    const originalFetch = globalThis.fetch;

    try {
      for (const fileName of cases) {
        const bytes = Buffer.from(`bytes:${fileName}`);
        globalThis.fetch = mock(async () => {
          return new Response(bytes, {
            status: 200,
            headers: {
              "Content-Type": "application/octet-stream",
              "Content-Disposition": `attachment; filename="${fileName}"`,
            },
          });
        }) as any;

        const t: any = createWebFetchTool(makeCtx(dir));
        const out: string = await t.execute({
          url: "https://example.com/download",
          maxLength: 50000,
        });
        const downloadedPath = path.join(dir, "Downloads", fileName);

        expect(out).toBe(`File downloaded ${downloadedPath}`);
        expect(await fs.readFile(downloadedPath)).toEqual(bytes);
      }
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("normalizes downloaded document filenames to the classified MIME type", async () => {
    const dir = await tmpDir();
    const pdfBytes = Buffer.from("%PDF-1.7\nmismatch\n");

    const originalFetch = globalThis.fetch;
    globalThis.fetch = mock(async () => {
      return new Response(pdfBytes, {
        status: 200,
        headers: {
          "Content-Type": "application/pdf",
          "Content-Disposition": 'attachment; filename="report.txt"',
        },
      });
    }) as any;

    try {
      const t: any = createWebFetchTool(makeCtx(dir));
      const out: string = await t.execute({
        url: "https://example.com/download",
        maxLength: 50000,
      });
      const downloadedPath = path.join(dir, "Downloads", "report.pdf");

      expect(out).toBe(`File downloaded ${downloadedPath}`);
      expect(await fs.readFile(downloadedPath)).toEqual(pdfBytes);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("avoids overwriting an existing download by suffixing the filename", async () => {
    const dir = await tmpDir();
    let requestCount = 0;

    const originalFetch = globalThis.fetch;
    globalThis.fetch = mock(async () => {
      requestCount += 1;
      return new Response(Buffer.from(`pdf-${requestCount}`), {
        status: 200,
        headers: { "Content-Type": "application/pdf" },
      });
    }) as any;

    try {
      const t: any = createWebFetchTool(makeCtx(dir));
      const first = await t.execute({ url: "https://example.com/report.pdf", maxLength: 50000 });
      const second = await t.execute({ url: "https://example.com/report.pdf", maxLength: 50000 });

      expect(first).toBe(`File downloaded ${path.join(dir, "Downloads", "report.pdf")}`);
      expect(second).toBe(`File downloaded ${path.join(dir, "Downloads", "report-2.pdf")}`);
      expect(await fs.readFile(path.join(dir, "Downloads", "report.pdf"), "utf-8")).toBe("pdf-1");
      expect(await fs.readFile(path.join(dir, "Downloads", "report-2.pdf"), "utf-8")).toBe("pdf-2");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("retries download finalization when the first destination appears during finalize", async () => {
    const dir = await tmpDir();
    const downloadDir = path.join(dir, "Downloads");
    const tempPath = path.join(downloadDir, "report.pdf.part");
    await fs.mkdir(downloadDir, { recursive: true });
    await fs.writeFile(tempPath, "fresh payload", "utf-8");

    const originalCopyFile = fs.copyFile;
    let firstAttempt = true;
    (fs as typeof fs & { copyFile: typeof fs.copyFile }).copyFile = mock(
      async (source: string | Buffer | URL, destination: string | Buffer | URL, mode?: number) => {
        if (firstAttempt && String(destination) === path.join(downloadDir, "report.pdf")) {
          firstAttempt = false;
          await fs.writeFile(path.join(downloadDir, "report.pdf"), "existing payload", "utf-8");
          const error = new Error("exists") as NodeJS.ErrnoException;
          error.code = "EEXIST";
          throw error;
        }
        return await originalCopyFile(source, destination, mode);
      },
    );

    try {
      const finalPath = await webFetchInternal.finalizeDownloadedFile(
        tempPath,
        downloadDir,
        "report.pdf",
      );
      expect(finalPath).toBe(path.join(downloadDir, "report-2.pdf"));
      expect(await fs.readFile(path.join(downloadDir, "report.pdf"), "utf-8")).toBe(
        "existing payload",
      );
      expect(await fs.readFile(finalPath, "utf-8")).toBe("fresh payload");
      await expect(fs.stat(tempPath)).rejects.toThrow();
    } finally {
      (fs as typeof fs & { copyFile: typeof fs.copyFile }).copyFile = originalCopyFile;
    }
  });

  test("rejects non-text content types", async () => {
    const dir = await tmpDir();

    const originalFetch = globalThis.fetch;
    globalThis.fetch = mock(async () => {
      return new Response("binary", {
        status: 200,
        headers: { "Content-Type": "application/octet-stream" },
      });
    }) as any;

    try {
      const t: any = createWebFetchTool(makeCtx(dir));
      await expect(
        t.execute({ url: "https://example.com/file.bin", maxLength: 50000 }),
      ).rejects.toThrow(/non-text content type/i);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("downloads direct image URLs into the workspace Downloads folder", async () => {
    const dir = await tmpDir();
    const pngBase64 =
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4//8/AwAI/AL+X6ixAAAAAElFTkSuQmCC";

    const originalFetch = globalThis.fetch;
    globalThis.fetch = mock(async () => {
      return new Response(Buffer.from(pngBase64, "base64"), {
        status: 200,
        headers: { "Content-Type": "image/png" },
      });
    }) as any;

    try {
      const t: any = createWebFetchTool(makeCtx(dir));
      const out = await t.execute({ url: "https://example.com/chart.png", maxLength: 50000 });
      const downloadedPath = path.join(dir, "Downloads", "chart.png");

      expect(out).toBe(`File downloaded ${downloadedPath}`);
      expect(await fs.readFile(downloadedPath)).toEqual(Buffer.from(pngBase64, "base64"));
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("downloads direct image URLs when served as octet-stream", async () => {
    const dir = await tmpDir();
    const jpegBase64 = Buffer.from("fake-jpeg-bytes").toString("base64");

    const originalFetch = globalThis.fetch;
    globalThis.fetch = mock(async () => {
      return new Response(Buffer.from(jpegBase64, "base64"), {
        status: 200,
        headers: { "Content-Type": "application/octet-stream" },
      });
    }) as any;

    try {
      const t: any = createWebFetchTool(makeCtx(dir));
      const out = await t.execute({ url: "https://example.com/photo.jpg", maxLength: 50000 });
      const downloadedPath = path.join(dir, "Downloads", "photo.jpg");

      expect(out).toBe(`File downloaded ${downloadedPath}`);
      expect(await fs.readFile(downloadedPath)).toEqual(Buffer.from(jpegBase64, "base64"));
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("downloads octet-stream image attachments using content-disposition filenames", async () => {
    const dir = await tmpDir();
    const jpegBytes = Buffer.from("attachment-jpeg");

    const originalFetch = globalThis.fetch;
    globalThis.fetch = mock(async () => {
      return new Response(jpegBytes, {
        status: 200,
        headers: {
          "Content-Type": "application/octet-stream",
          "Content-Disposition": 'attachment; filename="photo.jpg"',
        },
      });
    }) as any;

    try {
      const t: any = createWebFetchTool(makeCtx(dir));
      const out = await t.execute({ url: "https://example.com/download?id=1", maxLength: 50000 });
      const downloadedPath = path.join(dir, "Downloads", "photo.jpg");

      expect(out).toBe(`File downloaded ${downloadedPath}`);
      expect(await fs.readFile(downloadedPath)).toEqual(jpegBytes);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("adds a MIME-derived extension when downloading image URLs without one", async () => {
    const dir = await tmpDir();
    const pngBase64 =
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4//8/AwAI/AL+X6ixAAAAAElFTkSuQmCC";

    const originalFetch = globalThis.fetch;
    globalThis.fetch = mock(async () => {
      return new Response(Buffer.from(pngBase64, "base64"), {
        status: 200,
        headers: { "Content-Type": "image/png" },
      });
    }) as any;

    try {
      const t: any = createWebFetchTool(makeCtx(dir));
      const out = await t.execute({ url: "https://example.com/download/image", maxLength: 50000 });
      const downloadedPath = path.join(dir, "Downloads", "image.png");

      expect(out).toBe(`File downloaded ${downloadedPath}`);
      expect(await fs.readFile(downloadedPath)).toEqual(Buffer.from(pngBase64, "base64"));
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("downloaded images can be inspected via read", async () => {
    const dir = await tmpDir();
    const pngBase64 =
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4//8/AwAI/AL+X6ixAAAAAElFTkSuQmCC";

    const originalFetch = globalThis.fetch;
    globalThis.fetch = mock(async () => {
      return new Response(Buffer.from(pngBase64, "base64"), {
        status: 200,
        headers: { "Content-Type": "image/png" },
      });
    }) as any;

    try {
      const webFetchTool: any = createWebFetchTool(makeCtx(dir));
      const out = await webFetchTool.execute({
        url: "https://example.com/preview.png",
        maxLength: 50000,
      });
      const downloadedPath = path.join(dir, "Downloads", "preview.png");
      expect(out).toBe(`File downloaded ${downloadedPath}`);

      const readTool: any = createReadTool(makeCtx(dir));
      const readOut = await readTool.execute({ filePath: downloadedPath, limit: 2000 });
      expect(readOut).toEqual({
        type: "content",
        content: [
          { type: "text", text: "Image file: preview.png" },
          { type: "image", data: pngBase64, mimeType: "image/png" },
        ],
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("uses the canonical redirected URL for Exa enrichment", async () => {
    const dir = await tmpDir();
    const oldExa = process.env.EXA_API_KEY;
    process.env.EXA_API_KEY = "exa_test_key";
    let requestCount = 0;

    const originalFetch = globalThis.fetch;
    globalThis.fetch = mock(async (input: string | URL | Request, init?: RequestInit) => {
      const fetchUrl = toFetchUrl(input);
      if (fetchUrl.includes("api.exa.ai/contents")) {
        const body = JSON.parse(String(init?.body));
        expect(body.urls).toEqual(["https://example.com/final"]);
        return new Response(
          JSON.stringify({
            results: [{ url: "https://example.com/final", text: "Redirected content" }],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }

      requestCount += 1;
      if (requestCount === 1) {
        return new Response(null, {
          status: 302,
          headers: { Location: "https://example.com/final" },
        });
      }

      return new Response(
        "<html><body><article><h1>Redirected page</h1><p>Final local HTML.</p></article></body></html>",
        {
          status: 200,
          headers: { "Content-Type": "text/html" },
        },
      );
    }) as any;

    try {
      const t: any = createWebFetchTool(makeCtx(dir));
      await expect(
        t.execute({ url: "https://example.com/start", maxLength: 50000 }),
      ).resolves.toContain("Redirected page");
    } finally {
      globalThis.fetch = originalFetch;
      if (oldExa) process.env.EXA_API_KEY = oldExa;
      else delete process.env.EXA_API_KEY;
    }
  });

  test("DNS-pinning: initial fetch is called with an IP-addressed URL", async () => {
    const dir = await tmpDir();

    // Set up DNS mock to return a known public IP
    webSafetyInternal.setDnsLookup(async () => [{ address: "93.184.216.34", family: 4 }]);

    const originalFetch = globalThis.fetch;
    const fetchCalls: string[] = [];
    globalThis.fetch = mock(async (input: string | URL | Request) => {
      const fetchUrl = toFetchUrl(input);
      fetchCalls.push(fetchUrl);
      return new Response("<html><body><article><p>Pinned locally</p></article></body></html>", {
        status: 200,
        headers: { "Content-Type": "text/html" },
      });
    }) as any;

    try {
      const t: any = createWebFetchTool(makeCtx(dir));
      await t.execute({ url: "https://example.com/page", maxLength: 50000 });

      // The fetch should have been called with an IP address instead of the hostname
      expect(fetchCalls.length).toBeGreaterThanOrEqual(1);
      const calledUrl = fetchCalls[0];
      expect(calledUrl).toContain("93.184.216.34");
      expect(calledUrl).not.toContain("example.com");
    } finally {
      globalThis.fetch = originalFetch;
      webSafetyInternal.resetDnsLookup();
    }
  });

  test("throws on non-2xx HTTP responses", async () => {
    const dir = await tmpDir();

    const originalFetch = globalThis.fetch;
    globalThis.fetch = mock(async () => {
      return new Response("Not Found", { status: 404, statusText: "Not Found" });
    }) as any;

    try {
      const t: any = createWebFetchTool(makeCtx(dir));
      await expect(
        t.execute({ url: "https://example.com/missing", maxLength: 50000 }),
      ).rejects.toThrow(/webFetch failed: 404/i);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("times out when no initial response arrives", async () => {
    const dir = await tmpDir();

    webFetchInternal.setResponseTimeoutMs(25);

    const originalFetch = globalThis.fetch;
    globalThis.fetch = mock(async (_input: unknown, init?: RequestInit) => {
      const signal = init?.signal;
      return await new Promise<Response>((_resolve, reject) => {
        signal?.addEventListener("abort", () => reject(new Error("fetch aborted")), { once: true });
      });
    }) as typeof fetch;

    try {
      const t: any = createWebFetchTool(makeCtx(dir));
      await expect(
        t.execute({ url: "https://example.com/hangs", maxLength: 50000 }),
      ).rejects.toThrow(/timed out waiting for an initial response after 25ms/i);
    } finally {
      globalThis.fetch = originalFetch;
      webFetchInternal.setResponseTimeoutMs(5_000);
    }
  });
});

// ---------------------------------------------------------------------------
// ask tool
// ---------------------------------------------------------------------------
