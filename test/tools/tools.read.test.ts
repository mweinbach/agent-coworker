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

describe("read tool", () => {
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

  test("handles empty files", async () => {
    const dir = await tmpDir();
    const p = path.join(dir, "empty.txt");
    await fs.writeFile(p, "", "utf-8");

    const t: any = createReadTool(makeCtx(dir));
    const out: string = await t.execute({ filePath: p, limit: 2000 });
    // Empty file splits into [""], so one empty line numbered 1
    expect(out).toBe("1\t");
  });

  test("truncates lines longer than 2000 chars", async () => {
    const dir = await tmpDir();
    const p = path.join(dir, "long.txt");
    const longLine = "x".repeat(3000);
    await fs.writeFile(p, longLine, "utf-8");

    const t: any = createReadTool(makeCtx(dir));
    const out: string = await t.execute({ filePath: p, limit: 2000 });
    // truncateLine slices to 2000 and appends "..."
    const content = out.split("\t").slice(1).join("\t");
    expect(content.length).toBeLessThanOrEqual(2003); // 2000 + "..."
    expect(content.endsWith("...")).toBe(true);
  });

  test("throws for non-existent files", async () => {
    const dir = await tmpDir();
    const t: any = createReadTool(makeCtx(dir));
    await expect(
      t.execute({ filePath: path.join(dir, "nope.txt"), limit: 2000 }),
    ).rejects.toThrow();
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
