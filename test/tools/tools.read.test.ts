import { createReadStream } from "node:fs";
import { PassThrough } from "node:stream";

import { MAX_ATTACHMENT_INLINE_BYTE_SIZE } from "../../src/shared/attachments";
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

describe("read tool", () => {
  test("cancels an idle text stream without waiting for another line", async () => {
    const dir = await tmpDir();
    const filePath = path.join(dir, "idle.txt");
    await fs.writeFile(filePath, "original\n");
    const controller = new AbortController();
    const stream = new PassThrough();
    const started = Promise.withResolvers<void>();
    const tool = createReadTool(makeCtx(dir, { abortSignal: controller.signal }), {
      createReadStreamImpl: () => {
        started.resolve();
        return stream as ReturnType<typeof createReadStream>;
      },
    });
    const pending = tool.execute({ filePath, limit: 1 });
    const outcome = pending.then(
      (value) => ({ resolved: true, value }),
      (error: unknown) => ({ resolved: false, error }),
    );

    await started.promise;
    controller.abort();
    await new Promise<void>((resolve) => setImmediate(resolve));
    try {
      expect(stream.destroyed).toBe(true);
      expect((await outcome).resolved).toBe(false);
    } finally {
      stream.end();
      await outcome;
    }
  });

  test("checks cancellation while skipping lines before the requested offset", async () => {
    const dir = await tmpDir();
    const filePath = path.join(dir, "offset.txt");
    await fs.writeFile(filePath, "first\nsecond\n");
    const controller = new AbortController();
    controller.abort();

    await expect(
      createReadTool(makeCtx(dir, { abortSignal: controller.signal })).execute({
        filePath,
        offset: 10_000,
        limit: 1,
      }),
    ).rejects.toThrow(/abort|cancel/i);
  });

  test("numbers lines starting from 1", async () => {
    const dir = await tmpDir();
    const p = path.join(dir, "file.txt");
    await fs.writeFile(p, "alpha\nbeta\ngamma\n", "utf-8");

    const t: any = createReadTool(makeCtx(dir));
    const out: string = await t.execute({ filePath: p, limit: 2000 });
    const lines = out.split("\n");
    expect(lines[0]).toBe("1\talpha");
    expect(lines[1]).toBe("2\tbeta");
    expect(lines[2]).toBe("3\tgamma");
  });

  test("respects offset and limit", async () => {
    const dir = await tmpDir();
    const p = path.join(dir, "file.txt");
    await fs.writeFile(p, "a\nb\nc\nd\ne\n", "utf-8");

    const t: any = createReadTool(makeCtx(dir));
    const out: string = await t.execute({ filePath: p, offset: 2, limit: 2 });
    const lines = out.split("\n");
    expect(lines[0]).toBe("2\tb");
    expect(lines[1]).toBe("3\tc");
    expect(lines.length).toBe(2);
  });

  test("streams only the requested prefix of a newline-dense UTF-16 file", async () => {
    const dir = await tmpDir();
    const p = path.join(dir, "dense-utf16.txt");
    const payload = Buffer.from(`﻿${"\n".repeat(1_000_000)}`, "utf16le");
    await fs.writeFile(p, payload);
    let bytesRead = 0;

    const t: any = createReadTool(makeCtx(dir), {
      createReadStreamImpl: (
        filePath: string,
        options?: { encoding?: BufferEncoding; start?: number },
      ) => {
        const stream = createReadStream(filePath, options);
        stream.on("data", (chunk) => {
          bytesRead += Buffer.byteLength(chunk);
        });
        return stream;
      },
    });
    const out: string = await t.execute({ filePath: p, limit: 1 });

    expect(out).toBe("1\t");
    expect(bytesRead).toBeLessThan(payload.byteLength / 4);
  });

  test("does not read an entire giant line to return its first 2000 characters", async () => {
    const dir = await tmpDir();
    const filePath = path.join(dir, "giant-line.txt");
    const size = 8 * 1024 * 1024;
    await fs.writeFile(filePath, "x".repeat(size));
    let bytesRead = 0;
    const tool = createReadTool(makeCtx(dir), {
      createReadStreamImpl: (target, options) => {
        const stream = createReadStream(target, options);
        stream.on("data", (chunk) => {
          bytesRead += Buffer.byteLength(chunk);
        });
        return stream;
      },
    });

    const result = await tool.execute({ filePath, limit: 1 });

    expect(result).toBe(
      `1\t${"x".repeat(2000)}... [line 1 continues; read offset=1 columnOffset=2001 limit=1]`,
    );
    expect(bytesRead).toBeLessThan(size / 4);
  });

  test("continues inside a giant line without consuming its remaining tail", async () => {
    const dir = await tmpDir();
    const filePath = path.join(dir, "continued-giant-line.txt");
    await fs.writeFile(
      filePath,
      `${"a".repeat(300_000)}${"b".repeat(2000)}${"c".repeat(1_000_000)}`,
    );
    let bytesRead = 0;
    const tool = createReadTool(makeCtx(dir), {
      createReadStreamImpl: (target, options) => {
        const stream = createReadStream(target, options);
        stream.on("data", (chunk) => {
          bytesRead += Buffer.byteLength(chunk);
        });
        return stream;
      },
    });

    const result = await tool.execute({ filePath, offset: 1, columnOffset: 300_001, limit: 1 });

    expect(result).toBe(
      `1\t${"b".repeat(2000)}... [line 1 continues; read offset=1 columnOffset=302001 limit=1]`,
    );
    expect(bytesRead).toBeLessThan(400_000);
  });

  test.each(["utf8", "utf16le", "utf16be"] as const)(
    "decodes %s and split CRLF boundaries without changing line presentation",
    async (encoding) => {
      const dir = await tmpDir();
      const filePath = path.join(dir, `${encoding}.txt`);
      const text = "\ufeffhéllo 🌍\r\n\r\nnext\rlast\n";
      const bytes = Buffer.from(text, encoding === "utf8" ? "utf8" : "utf16le");
      if (encoding === "utf16be") bytes.swap16();
      await fs.writeFile(filePath, bytes);
      const tool = createReadTool(makeCtx(dir), {
        createReadStreamImpl: (target, options) =>
          createReadStream(target, { ...options, highWaterMark: 3 }),
      });

      expect(await tool.execute({ filePath, limit: 10 })).toBe(
        "1\théllo 🌍\n2\t\n3\tnext\n4\tlast",
      );
    },
  );

  test("skips a giant line while keeping the following empty and nonempty lines", async () => {
    const dir = await tmpDir();
    const filePath = path.join(dir, "skip-giant-line.txt");
    await fs.writeFile(filePath, `${"x".repeat(1_000_000)}\r\n\r\nlast\r\n`);
    const tool = createReadTool(makeCtx(dir));

    expect(await tool.execute({ filePath, offset: 2, limit: 10 })).toBe("2\t\n3\tlast");
  });

  test.each([
    { name: "UTF-16LE dangling byte", bytes: [0xff, 0xfe, 0x41], text: "" },
    { name: "UTF-16BE dangling byte", bytes: [0xfe, 0xff, 0x41], text: "" },
    { name: "UTF-16LE unpaired surrogate", bytes: [0xff, 0xfe, 0x00, 0xd8], text: "\ud800" },
    { name: "UTF-16BE unpaired surrogate", bytes: [0xfe, 0xff, 0xd8, 0x00], text: "\ud800" },
  ])("keeps the existing decoding contract for $name", async ({ bytes, text }) => {
    const dir = await tmpDir();
    const filePath = path.join(dir, "malformed-utf16.txt");
    await fs.writeFile(filePath, Buffer.from(bytes));
    const tool = createReadTool(makeCtx(dir), {
      createReadStreamImpl: (target, options) =>
        createReadStream(target, { ...options, highWaterMark: 1 }),
    });

    expect(await tool.execute({ filePath, limit: 1 })).toBe(`1\t${text}`);
  });

  test("handles empty files", async () => {
    const dir = await tmpDir();
    const p = path.join(dir, "empty.txt");
    await fs.writeFile(p, "", "utf-8");

    const t: any = createReadTool(makeCtx(dir));
    const out: string = await t.execute({ filePath: p, limit: 2000 });
    // Empty file splits into [""], so one empty line numbered 1
    expect(out).toBe("1\t");
  });

  test("marks lines longer than 2000 chars with an exact continuation request", async () => {
    const dir = await tmpDir();
    const p = path.join(dir, "long.txt");
    const longLine = "x".repeat(3000);
    await fs.writeFile(p, longLine, "utf-8");

    const t: any = createReadTool(makeCtx(dir));
    const out: string = await t.execute({ filePath: p, limit: 2000 });
    const content = out.split("\t").slice(1).join("\t");
    expect(content.startsWith("x".repeat(2000))).toBe(true);
    expect(content).toContain("read offset=1 columnOffset=2001 limit=1");
  });

  test("continues a long line from an explicit column offset without losing content", async () => {
    const dir = await tmpDir();
    const p = path.join(dir, "long-single-line.json");
    const longLine = `${"a".repeat(2000)}${"b".repeat(1500)}`;
    await fs.writeFile(p, longLine, "utf-8");

    const t: any = createReadTool(makeCtx(dir));
    const first: string = await t.execute({ filePath: p, offset: 1, limit: 1 });
    const second: string = await t.execute({
      filePath: p,
      offset: 1,
      columnOffset: 2001,
      limit: 1,
    });

    expect(first).toContain("read offset=1 columnOffset=2001");
    expect(second).toBe(`1\t${"b".repeat(1500)}`);
  });

  test("throws for non-existent files", async () => {
    const dir = await tmpDir();
    const t: any = createReadTool(makeCtx(dir));
    await expect(
      t.execute({ filePath: path.join(dir, "nope.txt"), limit: 2000 }),
    ).rejects.toThrow();
  });

  test("returns a directory guard instead of a failed read call", async () => {
    const dir = await tmpDir();
    const nested = path.join(dir, "docs");
    await fs.mkdir(nested);
    const t: any = createReadTool(makeCtx(dir));

    const out: string = await t.execute({ filePath: nested, limit: 2000 });

    expect(out).toContain("because it is a directory");
    expect(out).toContain("concrete file paths only");
  });

  test("default limit of 2000 lines", async () => {
    const dir = await tmpDir();
    const p = path.join(dir, "big.txt");
    const lines = Array.from({ length: 2500 }, (_, i) => `line${i}`);
    await fs.writeFile(p, lines.join("\n"), "utf-8");

    const t: any = createReadTool(makeCtx(dir));
    const out: string = await t.execute({ filePath: p, limit: 2000 });
    const outputLines = out.split("\n");
    expect(outputLines.length).toBe(2000);
  });

  test("single-line files", async () => {
    const dir = await tmpDir();
    const p = path.join(dir, "single.txt");
    await fs.writeFile(p, "only line", "utf-8");

    const t: any = createReadTool(makeCtx(dir));
    const out: string = await t.execute({ filePath: p, limit: 2000 });
    expect(out).toBe("1\tonly line");
  });

  test("resolves relative paths from workingDirectory", async () => {
    const dir = await tmpDir();
    const p = path.join(dir, "rel.txt");
    await fs.writeFile(p, "hello", "utf-8");

    const t: any = createReadTool(makeCtx(dir));
    const out: string = await t.execute({ filePath: "rel.txt", limit: 2000 });
    expect(out).toBe("1\thello");
  });

  test("offset beyond file length returns empty result", async () => {
    const dir = await tmpDir();
    const p = path.join(dir, "short.txt");
    await fs.writeFile(p, "one\ntwo\n", "utf-8");

    const t: any = createReadTool(makeCtx(dir));
    const out: string = await t.execute({ filePath: p, offset: 100, limit: 10 });
    expect(out).toBe("");
  });

  test("rejects reads outside allowed directories", async () => {
    const dir = await tmpDir();
    const outsideDir = await tmpDir();
    const outsideFile = path.join(outsideDir, "outside.txt");
    await fs.writeFile(outsideFile, "secret", "utf-8");

    const t: any = createReadTool(makeCtx(dir));
    await expect(t.execute({ filePath: outsideFile, limit: 10 })).rejects.toThrow(/blocked/i);
  });

  test("rejects project reads outside child agent targetPaths", async () => {
    const dir = await tmpDir();
    await fs.mkdir(path.join(dir, "src", "foo"), { recursive: true });
    await fs.mkdir(path.join(dir, "src", "bar"), { recursive: true });
    await fs.writeFile(path.join(dir, "src", "foo", "allowed.ts"), "ok", "utf-8");
    await fs.writeFile(path.join(dir, "src", "bar", "blocked.ts"), "secret", "utf-8");

    const t: any = createReadTool(makeCtx(dir, { agentTargetPaths: ["src/foo"] }));
    await expect(t.execute({ filePath: "src/foo/allowed.ts", limit: 10 })).resolves.toContain("ok");
    await expect(t.execute({ filePath: "src/bar/blocked.ts", limit: 10 })).rejects.toThrow(
      /targetPaths/,
    );
  });

  test("returns multimodal content for supported image files", async () => {
    const dir = await tmpDir();
    const p = path.join(dir, "pixel.png");
    const pngBase64 =
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4//8/AwAI/AL+X6ixAAAAAElFTkSuQmCC";
    await fs.writeFile(p, Buffer.from(pngBase64, "base64"));

    const t: any = createReadTool(makeCtx(dir));
    const out = await t.execute({ filePath: p, limit: 2000 });

    expect(out).toEqual({
      type: "content",
      content: [
        { type: "text", text: "Image file: pixel.png" },
        { type: "image", data: pngBase64, mimeType: "image/png" },
      ],
    });
  });

  test("rejects oversized image files before reading them into memory", async () => {
    const dir = await tmpDir();
    const p = path.join(dir, "huge.png");
    await fs.writeFile(p, "");
    await fs.truncate(p, MAX_ATTACHMENT_INLINE_BYTE_SIZE + 1);

    const originalReadFile = fs.readFile;
    (fs as typeof fs & { readFile: typeof fs.readFile }).readFile = mock(async () => {
      throw new Error("readFile should not be called for oversized images");
    });

    try {
      const t: any = createReadTool(makeCtx(dir));
      await expect(t.execute({ filePath: p, limit: 2000 })).rejects.toThrow(
        "File too large to send inline (max 25MB)",
      );
    } finally {
      (fs as typeof fs & { readFile: typeof fs.readFile }).readFile = originalReadFile;
    }
  });

  test("returns a binary guard for audio and video with Google provider", async () => {
    const dir = await tmpDir();
    const audioPath = path.join(dir, "clip.mp3");
    const videoPath = path.join(dir, "clip.mp4");
    await fs.writeFile(audioPath, "audio-bytes");
    await fs.writeFile(videoPath, "video-bytes");

    const t: any = createReadTool(
      makeCtx(dir, { config: makeConfig(dir, { provider: "google" }) }),
    );
    const audioOut = await t.execute({ filePath: audioPath, limit: 2000 });
    const videoOut = await t.execute({ filePath: videoPath, limit: 2000 });

    expect(audioOut).toContain("Cannot read clip.mp3 as text");
    expect(audioOut).toContain("audio/mpeg");
    expect(audioOut).toContain("provider response limits");
    expect(audioOut).not.toContain("audio-bytes");
    expect(audioOut).not.toContain(Buffer.from("audio-bytes").toString("base64"));

    expect(videoOut).toContain("Cannot read clip.mp4 as text");
    expect(videoOut).toContain("video/mp4");
    expect(videoOut).toContain("provider response limits");
    expect(videoOut).not.toContain("video-bytes");
    expect(videoOut).not.toContain(Buffer.from("video-bytes").toString("base64"));
  });

  test("returns a binary guard for PDF with Google provider", async () => {
    const dir = await tmpDir();
    const pdfPath = path.join(dir, "notes.pdf");
    await fs.writeFile(pdfPath, "pdf-bytes");

    const t: any = createReadTool(
      makeCtx(dir, { config: makeConfig(dir, { provider: "google" }) }),
    );
    const out = await t.execute({ filePath: pdfPath, limit: 2000 });

    expect(out).toContain("Cannot read notes.pdf as text");
    expect(out).toContain("application/pdf");
    expect(out).toContain("provider response limits");
    expect(out).not.toContain("pdf-bytes");
    expect(out).not.toContain(Buffer.from("pdf-bytes").toString("base64"));
  });

  test("returns a binary guard message for audio on non-Google providers", async () => {
    const dir = await tmpDir();
    const audioPath = path.join(dir, "clip.mp3");
    await fs.writeFile(audioPath, "audio-bytes");

    const t: any = createReadTool(
      makeCtx(dir, {
        config: makeConfig(dir, { provider: "anthropic", model: "claude-sonnet-4-6" }),
      }),
    );
    const out: string = await t.execute({ filePath: audioPath, limit: 2000 });

    expect(out).toContain("Cannot read clip.mp3 as text");
    expect(out).toContain("audio/mpeg");
    expect(out).not.toContain("audio-bytes");
  });
});

// ---------------------------------------------------------------------------
// write tool
// ---------------------------------------------------------------------------
