import { describe, expect, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import JSZip from "jszip";

import type { RunOptions } from "../src/platform/proc";
import { scratchRoots } from "../src/platform/sandbox";
import { jsonRpcWorkspaceResultSchemas } from "../src/server/jsonrpc/schema.workspace";
import {
  createPresentationPreviewer,
  previewPresentationFile,
} from "../src/server/presentationPreview";
import { makePptxFixture } from "./helpers/artifactOfficeFixtures";

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await fs.realpath(
    await fs.mkdtemp(path.join(scratchRoots()[0] ?? "/tmp", "cowork-presentation-preview-")),
  );
  try {
    return await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

function request(dir: string, filePath = "deck.pptx") {
  return {
    cwd: dir,
    filePath,
    builtInDir: dir,
    env: { COWORK_DISABLE_RUNTIME: "1", COWORK_HOME_OVERRIDE: dir },
  };
}

async function writeDeck(dir: string, titles = ["Alpha", "Beta"], fileName = "deck.pptx") {
  const bytes = await makePptxFixture(
    titles.map((text, index) => ({ id: String(256 + index), text })),
  );
  await fs.writeFile(path.join(dir, fileName), bytes);
  return bytes;
}

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a/DsAAAAASUVORK5CYII=",
  "base64",
);
function nativeFixture(
  dir: string,
  options: { pages?: number[]; png?: Buffer; errorCode?: string } = {},
) {
  const runtime = {
    soffice: path.join(dir, "trusted-runtime", "soffice"),
    pdftoppm: path.join(dir, "trusted-runtime", "pdftoppm"),
    env: { CUSTOM_RENDER_ENV: "preserved" },
  };
  const calls: Array<{ file: string; args: string[]; options: RunOptions }> = [];
  const sources: Buffer[] = [];
  const preview = createPresentationPreviewer({
    resolveRuntime: async () => runtime,
    runProcess: async (file, args, runOptions = {}) => {
      calls.push({ file, args, options: runOptions });
      const stage = runOptions.cwd;
      if (!stage) throw new Error("Renderer requires a private stage.");
      if (file === runtime.soffice) {
        sources.push(await fs.readFile(args.at(-1) as string));
        await fs.writeFile(path.join(stage, "source.pdf"), "%PDF-1.7\nfixture");
      } else {
        if (options.errorCode)
          return { exitCode: 1, stdout: "", stderr: "", errorCode: options.errorCode };
        for (const page of options.pages ?? [1, 2])
          await fs.writeFile(path.join(stage, `slide-${page}.png`), options.png ?? PNG);
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    },
  });
  return { preview, calls, sources, runtime };
}

describe("presentation preview renderer", () => {
  test("binds text-only previews and their fingerprints to the exact deck bytes", async () => {
    await withTempDir(async (dir) => {
      const bytes = await writeDeck(dir, ["Revenue & growth", "Forecast <next year>"]);
      const result = await previewPresentationFile(request(dir));
      expect(result).toMatchObject({ ok: true, renderingMode: "text" });
      if (!result.ok) return;
      expect(result.slides.map((slide) => slide.title)).toEqual([
        "Revenue & growth",
        "Forecast <next year>",
      ]);
      expect(result.dependencies).toEqual([path.join(dir, "deck.pptx")]);
      expect(result.version.fingerprint).toBe(
        `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
      );
      expect(result.warnings?.join(" ")).toContain("Text-only preview");
      const svg = Buffer.from(result.slides[0]?.pngBase64.split(",")[1] ?? "", "base64").toString(
        "utf8",
      );
      expect(svg).toContain("Revenue &amp; growth");
      expect(svg).toContain("Text-only preview");
      expect(
        jsonRpcWorkspaceResultSchemas["cowork/workspace/presentation/preview"].safeParse(result)
          .success,
      ).toBe(true);
    });
  });

  test("never lets unrelated PNG caches replace either of two decks", async () => {
    await withTempDir(async (dir) => {
      await fs.mkdir(path.join(dir, "preview"));
      await fs.writeFile(path.join(dir, "preview", "slide-1.png"), PNG);
      for (const title of ["Alpha", "Beta"]) {
        await writeDeck(dir, [title], `${title}.pptx`);
        const result = await previewPresentationFile(request(dir, `${title}.pptx`));
        expect(result).toMatchObject({ ok: true, renderingMode: "text" });
        if (!result.ok) return;
        expect(result.slides[0]?.title).toBe(title);
        expect(result.dependencies).toEqual([path.join(dir, `${title}.pptx`)]);
      }
    });
  });

  test("does not execute workspace scripts when previewing a compiled deck", async () => {
    await withTempDir(async (dir) => {
      await writeDeck(dir, ["Deck"]);
      await fs.writeFile(path.join(dir, "slide-1.mjs"), 'throw new Error("must not run");');
      const scripts = path.join(dir, "skills", "presentations", "scripts");
      await fs.mkdir(scripts, { recursive: true });
      const marker = path.join(dir, "executed.txt");
      await fs.writeFile(
        path.join(scripts, "render_artifact_slide.mjs"),
        `import fs from "node:fs"; fs.writeFileSync(${JSON.stringify(marker)}, "executed"); fs.writeFileSync(process.argv[process.argv.indexOf("--output") + 1], "png");`,
      );
      const result = await previewPresentationFile(request(dir));
      expect(await fs.stat(marker).catch(() => null)).toBeNull();
      expect(result).toMatchObject({ ok: true, renderingMode: "text" });
    });
  });

  test("rejects source-code previews before preparing a runtime", async () => {
    await withTempDir(async (dir) => {
      await fs.writeFile(path.join(dir, "slide-1.mjs"), "export default {};");
      let prepared = false;
      const preview = createPresentationPreviewer({
        resolveRuntime: async () => {
          prepared = true;
          return null;
        },
      });
      const result = await preview(request(dir, "slide-1.mjs"));
      expect(result).toMatchObject({ ok: false, error: { kind: "unsupported_format" } });
      expect(prepared).toBe(false);
    });
  });

  test("does not trust inherited runtime executable markers when runtime is disabled", async () => {
    await withTempDir(async (dir) => {
      await writeDeck(dir);
      let ran = false;
      const preview = createPresentationPreviewer({
        runProcess: async () => {
          ran = true;
          throw new Error("must not execute");
        },
      });
      const input = request(dir);
      const result = await preview({
        ...input,
        env: {
          ...input.env,
          COWORK_RUNTIME_DIR: path.join(dir, "unsigned"),
          COWORK_RUNTIME_SOFFICE: process.execPath,
          COWORK_RUNTIME_POPPLER_BIN: dir,
        },
      });
      expect(result).toMatchObject({ ok: true, renderingMode: "text" });
      expect(ran).toBe(false);
    });
  });

  test("uses only resolved native entrypoints with private input, isolated temp/profile roots, and bounded execution", async () => {
    await withTempDir(async (dir) => {
      const bytes = await writeDeck(dir);
      const fixture = nativeFixture(dir);
      const result = await fixture.preview(request(dir));
      expect(result).toMatchObject({ ok: true, renderingMode: "rendered", warnings: [] });
      if (!result.ok) return;
      expect(result.slides).toHaveLength(2);
      expect(result.slides[0]?.pngBase64).toBe(`data:image/png;base64,${PNG.toString("base64")}`);
      expect(fixture.calls.map((call) => call.file)).toEqual([
        fixture.runtime.soffice,
        fixture.runtime.pdftoppm,
      ]);
      expect(fixture.sources).toEqual([bytes]);
      const stage = fixture.calls[0]?.options.cwd;
      expect(stage).toBeDefined();
      expect(stage).not.toBe(dir);
      for (const call of fixture.calls) {
        expect(call.options.cwd).toBe(stage);
        expect(call.options.env).toMatchObject({
          CUSTOM_RENDER_ENV: "preserved",
          TMPDIR: stage,
          TEMP: stage,
          TMP: stage,
        });
        expect(call.options.timeoutMs).toBeGreaterThan(0);
        expect(call.options.timeoutMs).toBeLessThanOrEqual(25_000);
        expect(call.options.maxBuffer).toBe(256 * 1024);
        expect(call.options.signal).toBeDefined();
        expect(call.options.killSignal).toBe("SIGKILL");
      }
      expect(fixture.calls[0]?.args).toContain("--convert-to");
      expect(fixture.calls[1]?.args).toContain("-scale-to");
      expect(await fs.stat(stage as string).catch(() => null)).toBeNull();
    });
  });

  test("replaces a partial native render with a complete, explicitly labeled text preview", async () => {
    await withTempDir(async (dir) => {
      await writeDeck(dir);
      const fixture = nativeFixture(dir, { pages: [1] });
      const result = await fixture.preview(request(dir));
      expect(result).toMatchObject({ ok: true, renderingMode: "text" });
      if (!result.ok) return;
      expect(result.slides).toHaveLength(2);
      expect(result.warnings?.join(" ")).toContain("did not produce every slide");
      expect(await fs.stat(fixture.calls[0]?.options.cwd as string).catch(() => null)).toBeNull();
    });
  });

  test.each(["invalid", "oversized"])(
    "rejects %s rendered images instead of returning misleading success",
    async (kind) => {
      await withTempDir(async (dir) => {
        await writeDeck(dir);
        const png =
          kind === "invalid" ? Buffer.from("not a PNG") : Buffer.alloc(4 * 1024 * 1024 + 1);
        const fixture = nativeFixture(dir, { png });
        const result = await fixture.preview(request(dir));
        expect(result).toMatchObject({ ok: true, renderingMode: "text" });
        if (result.ok)
          expect(result.warnings?.join(" ")).toContain("preview limits or are invalid");
        expect(await fs.stat(fixture.calls[0]?.options.cwd as string).catch(() => null)).toBeNull();
      });
    },
  );

  test("surfaces native output overflow without retaining temporary files", async () => {
    await withTempDir(async (dir) => {
      await writeDeck(dir);
      const fixture = nativeFixture(dir, { errorCode: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" });
      const result = await fixture.preview(request(dir));
      expect(result).toMatchObject({ ok: true, renderingMode: "text" });
      if (result.ok)
        expect(result.warnings?.join(" ")).toContain("ERR_CHILD_PROCESS_STDIO_MAXBUFFER");
      expect(await fs.stat(fixture.calls[0]?.options.cwd as string).catch(() => null)).toBeNull();
    });
  });

  test("applies the overall deadline to runtime preparation", async () => {
    await withTempDir(async (dir) => {
      await writeDeck(dir);
      const preview = createPresentationPreviewer({
        timeoutMs: 10,
        resolveRuntime: () => new Promise(() => {}),
      });
      const result = await preview(request(dir));
      expect(result).toMatchObject({ ok: false, error: { kind: "compile_error" } });
      if (!result.ok) expect(result.error.message).toContain("timed out");
    });
  });

  test("returns the deadline error while package loading is still pending", async () => {
    await withTempDir(async (dir) => {
      await writeDeck(dir);
      let entered!: () => void;
      let release!: () => void;
      const didEnter = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const mayLoad = new Promise<void>((resolve) => {
        release = resolve;
      });
      const loadAsync = JSZip.loadAsync;
      const loading = spyOn(JSZip, "loadAsync").mockImplementation(async (data, options) => {
        entered();
        await mayLoad;
        return await loadAsync(data, options);
      });
      const preview = createPresentationPreviewer({ timeoutMs: 20 });
      const pending = preview(request(dir));
      try {
        await didEnter;
        const result = await Promise.race([
          pending,
          Bun.sleep(100).then(() => "still pending" as const),
        ]);
        expect(result).toMatchObject({ ok: false, error: { kind: "compile_error" } });
        if (typeof result !== "string" && !result.ok)
          expect(result.error.message).toContain("timed out");
      } finally {
        release();
        await pending;
        loading.mockRestore();
      }
    });
  });

  test.each(["path", "stat"])("bounds pending initial %s resolution", async (boundary) => {
    await withTempDir(async (dir) => {
      await writeDeck(dir);
      let entered!: () => void;
      let release!: () => void;
      const didEnter = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const mayResolve = new Promise<void>((resolve) => {
        release = resolve;
      });
      const realpath = fs.realpath;
      const stat = fs.stat;
      const realPathSpy = spyOn(fs, "realpath").mockImplementation(async (target, options) => {
        if (boundary === "path" && String(target) === dir) {
          entered();
          await mayResolve;
        }
        return await realpath(target, options);
      });
      const statSpy = spyOn(fs, "stat").mockImplementation(async (target, options) => {
        if (boundary === "stat" && String(target) === path.join(dir, "deck.pptx")) {
          entered();
          await mayResolve;
        }
        return await stat(target, options);
      });
      const preview = createPresentationPreviewer({ timeoutMs: 20 });
      const pending = preview(request(dir));
      try {
        await didEnter;
        const result = await Promise.race([
          pending,
          Bun.sleep(100).then(() => "still pending" as const),
        ]);
        expect(result).toMatchObject({ ok: false, error: { kind: "compile_error" } });
        if (typeof result !== "string" && !result.ok)
          expect(result.error.message).toContain("timed out");
      } finally {
        release();
        await pending;
        realPathSpy.mockRestore();
        statSpy.mockRestore();
      }
    });
  });

  test("checks the elapsed deadline even before its timer callback runs", async () => {
    await withTempDir(async (dir) => {
      await writeDeck(dir);
      const started = Date.now();
      const now = spyOn(Date, "now").mockReturnValue(started);
      const preview = createPresentationPreviewer({
        timeoutMs: 100,
        resolveRuntime: async () => {
          now.mockReturnValue(started + 101);
          return null;
        },
      });
      try {
        const result = await preview(request(dir));
        expect(result).toMatchObject({
          ok: false,
          error: { message: "Presentation preview timed out." },
        });
      } finally {
        now.mockRestore();
      }
    });
  });

  test.each(["final image", "cleanup"])(
    "does not return success after cancellation during %s",
    async (boundary) => {
      await withTempDir(async (dir) => {
        await writeDeck(dir);
        const fixture = nativeFixture(dir);
        const controller = new AbortController();
        const open = fs.open;
        const remove = fs.rm;
        const read = spyOn(fs, "open").mockImplementation(async (filePath, flags, mode) => {
          const handle = await open(filePath, flags, mode);
          if (boundary === "final image" && String(filePath).endsWith("slide-2.png"))
            controller.abort(new Error("Cancelled at final image boundary"));
          return handle;
        });
        const cleanup = spyOn(fs, "rm").mockImplementation(async (filePath, options) => {
          if (boundary === "cleanup" && String(filePath) === fixture.calls[0]?.options.cwd)
            controller.abort(new Error("Cancelled at cleanup boundary"));
          return await remove(filePath, options);
        });
        try {
          const result = await fixture.preview({ ...request(dir), signal: controller.signal });
          expect(result).toMatchObject({ ok: false, error: { kind: "compile_error" } });
          if (!result.ok) expect(result.error.message).toContain("Cancelled at");
          expect(
            await fs.stat(fixture.calls[0]?.options.cwd as string).catch(() => null),
          ).toBeNull();
        } finally {
          read.mockRestore();
          cleanup.mockRestore();
        }
      });
    },
  );

  test("rejects an oversized slide inventory before extracting slide bodies", async () => {
    await withTempDir(async (dir) => {
      const bytes = await writeDeck(
        dir,
        Array.from({ length: 201 }, (_, index) => `Slide ${index + 1}`),
      );
      const zip = await JSZip.loadAsync(bytes);
      zip.file("ppt/slides/slide1.xml", "<wrong/>");
      await fs.writeFile(
        path.join(dir, "deck.pptx"),
        await zip.generateAsync({ type: "uint8array" }),
      );
      const result = await previewPresentationFile(request(dir));
      expect(result).toMatchObject({ ok: false, error: { kind: "compile_error" } });
      if (!result.ok) expect(result.error.message).toContain("200-slide");
    });
  });

  test("does not decompress unused media when extracting preview text and titles", async () => {
    await withTempDir(async (dir) => {
      await writeDeck(dir);
      const loadAsync = JSZip.loadAsync;
      const restoreMediaReaders: Array<() => void> = [];
      const loading = spyOn(JSZip, "loadAsync").mockImplementation(async (data, options) => {
        const zip = await loadAsync(data, options);
        for (const entry of Object.values(zip.files)) {
          if (!entry.name.startsWith("ppt/media/")) continue;
          const read = spyOn(entry, "async").mockImplementation(() => {
            throw new Error("Preview attempted to decompress unused media");
          });
          restoreMediaReaders.push(() => read.mockRestore());
        }
        return zip;
      });
      try {
        const result = await previewPresentationFile(request(dir));
        expect(result).toMatchObject({ ok: true, renderingMode: "text" });
        if (result.ok) expect(result.slides.map((slide) => slide.title)).toEqual(["Alpha", "Beta"]);
      } finally {
        for (const restore of restoreMediaReaders) restore();
        loading.mockRestore();
      }
    });
  });

  test("cancels native work and cleans its stage before returning", async () => {
    await withTempDir(async (dir) => {
      await writeDeck(dir);
      const controller = new AbortController();
      let stage: string | undefined;
      const preview = createPresentationPreviewer({
        resolveRuntime: async () => ({
          soffice: "trusted-soffice",
          pdftoppm: "trusted-pdftoppm",
          env: {},
        }),
        runProcess: async (_file, _args, options = {}) => {
          stage = options.cwd;
          const pending = new Promise<{
            exitCode: number;
            stdout: string;
            stderr: string;
            errorCode: string;
          }>((resolve) => {
            options.signal?.addEventListener(
              "abort",
              () => resolve({ exitCode: 130, stdout: "", stderr: "", errorCode: "ABORT_ERR" }),
              { once: true },
            );
          });
          controller.abort(new Error("Stopped by user"));
          return await pending;
        },
      });
      const result = await preview({ ...request(dir), signal: controller.signal });
      expect(result).toMatchObject({ ok: false, error: { message: "Stopped by user" } });
      expect(stage).toBeDefined();
      expect(await fs.stat(stage as string).catch(() => null)).toBeNull();
    });
  });

  test("renders legacy PPT only through the native converter", async () => {
    await withTempDir(async (dir) => {
      await fs.writeFile(path.join(dir, "legacy.ppt"), "legacy binary");
      const unavailable = await previewPresentationFile(request(dir, "legacy.ppt"));
      expect(unavailable).toMatchObject({ ok: false, error: { kind: "unsupported_format" } });
      const fixture = nativeFixture(dir);
      expect(await fixture.preview(request(dir, "legacy.ppt"))).toMatchObject({
        ok: true,
        renderingMode: "rendered",
      });
    });
  });

  test("rejects corrupt decks even when a guessed PNG preview is present", async () => {
    await withTempDir(async (dir) => {
      await fs.writeFile(path.join(dir, "deck.pptx"), "not a PowerPoint package");
      await fs.mkdir(path.join(dir, "preview"));
      await fs.writeFile(path.join(dir, "preview", "slide-1.png"), PNG);
      expect(await previewPresentationFile(request(dir))).toMatchObject({
        ok: false,
        error: { kind: "compile_error" },
      });
    });
  });

  test("rejects oversized source files before preparing native tools", async () => {
    await withTempDir(async (dir) => {
      const handle = await fs.open(path.join(dir, "deck.pptx"), "w");
      await handle.truncate(100 * 1024 * 1024 + 1);
      await handle.close();
      const result = await previewPresentationFile(request(dir));
      expect(result).toMatchObject({ ok: false, error: { kind: "compile_error" } });
      if (!result.ok) expect(result.error.message).toContain("100 MiB");
    });
  });

  test("rejects deck paths outside the workspace", async () => {
    await withTempDir(async (dir) => {
      const workspace = path.join(dir, "workspace");
      await fs.mkdir(workspace);
      await writeDeck(dir);
      const result = await previewPresentationFile({
        ...request(workspace),
        filePath: path.join(dir, "deck.pptx"),
      });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.message).toContain("outside");
    });
  });
});
