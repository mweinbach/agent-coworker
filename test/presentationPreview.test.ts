import { describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadConfig } from "../src/config";
import { previewPresentationFile } from "../src/server/presentationPreview";

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-presentation-preview-"));
  try {
    return await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

function localRuntimeEnv(home: string): Record<string, string> {
  return {
    COWORK_DISABLE_RUNTIME: "1",
    COWORK_RUNTIME_NODE: process.execPath,
    HOME: home,
    USERPROFILE: home,
  };
}

describe("presentation preview renderer", () => {
  test("returns error for unsupported format", async () => {
    await withTempDir(async (dir) => {
      const filePath = path.join(dir, "document.txt");
      await fs.writeFile(filePath, "hello", "utf8");

      const result = await previewPresentationFile({
        cwd: dir,
        filePath: "document.txt",
        builtInDir: dir,
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.kind).toBe("unsupported_format");
        expect(result.error.message).toContain("Presentation preview supports");
      }
    });
  });

  test("returns a missing-script error without starting the runtime", async () => {
    await withTempDir(async (dir) => {
      const filePath = path.join(dir, "slide-1.mjs");
      await fs.writeFile(filePath, "export default {}", "utf8");

      const result = await previewPresentationFile({
        cwd: dir,
        filePath: "slide-1.mjs",
        builtInDir: dir,
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.kind).toBe("compile_error");
        expect(result.error.message).toContain("Slide rendering script not found");
      }
    });
  });

  test("runs mock rendering script successfully for a single slide", {
    timeout: 20_000,
  }, async () => {
    await withTempDir(async (dir) => {
      // 1. Create a dummy slide module
      const filePath = path.join(dir, "slide-1.mjs");
      await fs.writeFile(filePath, "export default {}", "utf8");

      // 2. Set up dummy builtInDir with mock render_artifact_slide.mjs script
      const scriptDir = path.join(dir, "skills/presentations/scripts");
      await fs.mkdir(scriptDir, { recursive: true });
      const scriptPath = path.join(scriptDir, "render_artifact_slide.mjs");

      const mockScriptCode = `
        import fs from 'node:fs';
        const outIdx = process.argv.indexOf('--output');
        if (outIdx !== -1 && process.argv[outIdx + 1]) {
          fs.writeFileSync(process.argv[outIdx + 1], 'fake-png-data');
        }
        process.exit(0);
      `;
      await fs.writeFile(scriptPath, mockScriptCode, "utf8");

      // 3. Execute previewPresentationFile
      const result = await previewPresentationFile({
        cwd: dir,
        filePath: "slide-1.mjs",
        builtInDir: dir,
        env: localRuntimeEnv(dir),
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.slides).toHaveLength(1);
        expect(result.slides[0].slideIndex).toBe(0);
        expect(result.slides[0].slideId).toBe("slide-1");
        expect(result.slides[0].title).toBe("slide-1");
        // Base64 encoding of 'fake-png-data' is 'ZmFrZS1wbmctZGF0YQ=='
        expect(result.slides[0].pngBase64).toBe("data:image/png;base64,ZmFrZS1wbmctZGF0YQ==");
      }
    });
  });

  test("runs the marketplace presentation skill with the separate runtime environment", {
    timeout: 20_000,
  }, async () => {
    await withTempDir(async (dir) => {
      const filePath = path.join(dir, "slide-1.mjs");
      await fs.writeFile(filePath, "export default {}", "utf8");

      const home = path.join(dir, "home");
      const pluginRoot = path.join(home, ".cowork", "plugins", "workspace-tools");
      const scriptDir = path.join(pluginRoot, "skills", "presentations", "scripts");
      await fs.mkdir(scriptDir, { recursive: true });
      await fs.mkdir(path.join(pluginRoot, ".cowork-plugin"), { recursive: true });
      await fs.writeFile(
        path.join(pluginRoot, ".cowork-plugin", "plugin.json"),
        `${JSON.stringify({
          name: "workspace-tools",
          version: "1.0.0",
          description: "Marketplace workspace tools",
          skills: "./skills",
        })}\n`,
        "utf8",
      );
      await fs.writeFile(
        path.join(pluginRoot, ".cowork-plugin", "install.json"),
        `${JSON.stringify({
          marketplace: {
            name: "cowork-personal",
            sourceInput:
              "https://github.com/mweinbach/cowork-skills-plugins/tree/main/plugins/workspace-tools",
          },
        })}\n`,
        "utf8",
      );
      await fs.writeFile(
        path.join(pluginRoot, "skills", "presentations", "SKILL.md"),
        "---\nname: presentations\ndescription: Marketplace presentations fixture\n---\n",
        "utf8",
      );
      await fs.writeFile(
        path.join(scriptDir, "render_artifact_slide.mjs"),
        `import fs from "node:fs";
fs.writeFileSync(process.env.COWORK_TEST_ENV_CAPTURE, Object.entries(process.env).map(([key, value]) => key + "=" + value).join("\\n"));
const outputIndex = process.argv.indexOf("--output");
fs.writeFileSync(process.argv[outputIndex + 1], "bundled-runtime-png");
`,
        "utf8",
      );

      const bundledRuntime = path.join(dir, "bundled-runtime");
      const bundledNodeDir = path.join(bundledRuntime, "node/bin");
      const bundledModulesDir = path.join(bundledRuntime, "node/node_modules/@oai/artifact-tool");
      await fs.mkdir(bundledNodeDir, { recursive: true });
      await fs.mkdir(bundledModulesDir, { recursive: true });
      await fs.writeFile(path.join(bundledRuntime, "runtime.json"), "{}\n", "utf8");
      await fs.writeFile(path.join(bundledModulesDir, "package.json"), "{}\n", "utf8");
      const fakeNode = path.join(
        bundledNodeDir,
        process.platform === "win32" ? "node.exe" : "node",
      );
      await fs.copyFile(process.execPath, fakeNode);
      await fs.chmod(fakeNode, 0o755);

      const envCapture = path.join(dir, "render-env.txt");
      const config = await loadConfig({ cwd: dir, homedir: home, builtInDir: dir });
      const result = await previewPresentationFile({
        cwd: dir,
        filePath: "slide-1.mjs",
        builtInDir: dir,
        config,
        env: {
          COWORK_DISABLE_RUNTIME: "1",
          COWORK_RUNTIME_DIR: bundledRuntime,
          COWORK_RUNTIME_NODE: fakeNode,
          COWORK_RUNTIME_NODE_MODULES: path.join(bundledRuntime, "node/node_modules"),
          COWORK_TEST_ENV_CAPTURE: envCapture,
          HOME: home,
        },
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.slides[0]?.pngBase64).toBe(
        "data:image/png;base64,YnVuZGxlZC1ydW50aW1lLXBuZw==",
      );
      const capturedEnv = await fs.readFile(envCapture, "utf8");
      expect(capturedEnv).toContain(`COWORK_RUNTIME_NODE=${fakeNode}`);
      expect(capturedEnv).toContain(
        `COWORK_RUNTIME_NODE_MODULES=${path.join(bundledRuntime, "node/node_modules")}`,
      );
    });
  });

  test("dynamic deck compilation renders all slide modules in order", {
    timeout: 20_000,
  }, async () => {
    await withTempDir(async (dir) => {
      // 1. Set up slide modules and dummy pptx file
      const slidesDir = path.join(dir, "slides");
      await fs.mkdir(slidesDir, { recursive: true });
      await fs.writeFile(path.join(slidesDir, "slide-2.mjs"), "export default {}", "utf8");
      await fs.writeFile(path.join(slidesDir, "slide-1.mjs"), "export default {}", "utf8");
      await fs.writeFile(path.join(dir, "deck.pptx"), "fake-pptx-bytes", "utf8");

      // 2. Set up mock script
      const scriptDir = path.join(dir, "skills/presentations/scripts");
      await fs.mkdir(scriptDir, { recursive: true });
      const scriptPath = path.join(scriptDir, "render_artifact_slide.mjs");

      const mockScriptCode = `
        import fs from 'node:fs';
        const outIdx = process.argv.indexOf('--output');
        if (outIdx !== -1 && process.argv[outIdx + 1]) {
          fs.writeFileSync(process.argv[outIdx + 1], 'slide-data');
        }
        process.exit(0);
      `;
      await fs.writeFile(scriptPath, mockScriptCode, "utf8");

      // 3. Render PPTX (triggers dynamic check for slide modules)
      const result = await previewPresentationFile({
        cwd: dir,
        filePath: "deck.pptx",
        builtInDir: dir,
        env: localRuntimeEnv(dir),
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.slides).toHaveLength(2);
        expect(result.slides[0].slideIndex).toBe(0);
        expect(result.slides[0].slideId).toBe("slide-1");
        expect(result.slides[1].slideIndex).toBe(1);
        expect(result.slides[1].slideId).toBe("slide-2");
      }
    });
  });

  test("loads cached PNG slides without a rendering script or runtime", async () => {
    await withTempDir(async (dir) => {
      // 1. Set up pre-rendered preview files and dummy pptx file
      const previewDir = path.join(dir, "preview");
      await fs.mkdir(previewDir, { recursive: true });
      await fs.writeFile(path.join(dir, "deck.pptx"), "fake-pptx-bytes", "utf8");

      const pngPath = path.join(previewDir, "slide-1.png");
      await fs.writeFile(pngPath, "cached-slide-data", "utf8");

      const result = await previewPresentationFile({
        cwd: dir,
        filePath: "deck.pptx",
        builtInDir: dir,
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.slides).toHaveLength(1);
        expect(result.slides[0].slideIndex).toBe(0);
        expect(result.slides[0].slideId).toBe("slide-1");
        // Base64 encoding of 'cached-slide-data' is 'Y2FjaGVkLXNsaWRlLWRhdGE='
        expect(result.slides[0].pngBase64).toBe("data:image/png;base64,Y2FjaGVkLXNsaWRlLWRhdGE=");
      }
    });
  });

  test("versions cached previews from the deck and every PNG dependency", async () => {
    await withTempDir(async (dir) => {
      const previewDir = path.join(dir, "preview");
      const deckPath = path.join(dir, "deck.pptx");
      const pngPath = path.join(previewDir, "slide-1.png");
      await fs.mkdir(previewDir, { recursive: true });
      await fs.writeFile(deckPath, "unchanged-deck", "utf8");
      await fs.writeFile(pngPath, "first-preview", "utf8");

      const first = await previewPresentationFile({
        cwd: dir,
        filePath: "deck.pptx",
        builtInDir: dir,
      });
      expect(first.ok).toBe(true);
      if (!first.ok) return;
      expect(first.dependencies).toContain(await fs.realpath(deckPath));
      expect(first.dependencies).toContain(await fs.realpath(pngPath));

      await fs.writeFile(pngPath, "second-preview-is-different", "utf8");
      const second = await previewPresentationFile({
        cwd: dir,
        filePath: "deck.pptx",
        builtInDir: dir,
      });
      expect(second.ok).toBe(true);
      if (!second.ok) return;

      expect(second.dependencies).toContain(await fs.realpath(deckPath));
      expect(second.dependencies).toContain(await fs.realpath(pngPath));
      expect(second.version.fingerprint).not.toBe(first.version.fingerprint);
      expect(second.slides[0]?.pngBase64).not.toBe(first.slides[0]?.pngBase64);
    });
  });

  test("versions rendered deck previews from the PPTX and slide modules", {
    timeout: 20_000,
  }, async () => {
    await withTempDir(async (dir) => {
      const slidesDir = path.join(dir, "slides");
      const deckPath = path.join(dir, "deck.pptx");
      const modulePath = path.join(slidesDir, "slide-1.mjs");
      await fs.mkdir(slidesDir, { recursive: true });
      await fs.writeFile(deckPath, "unchanged-deck", "utf8");
      await fs.writeFile(modulePath, "export default { version: 1 }", "utf8");

      const scriptDir = path.join(dir, "skills/presentations/scripts");
      await fs.mkdir(scriptDir, { recursive: true });
      await fs.writeFile(
        path.join(scriptDir, "render_artifact_slide.mjs"),
        `
          import fs from "node:fs";
          const outIdx = process.argv.indexOf("--output");
          fs.writeFileSync(process.argv[outIdx + 1], "slide-data");
        `,
        "utf8",
      );

      const first = await previewPresentationFile({
        cwd: dir,
        filePath: "deck.pptx",
        builtInDir: dir,
        env: localRuntimeEnv(dir),
      });
      expect(first.ok).toBe(true);
      if (!first.ok) return;
      expect(first.dependencies).toContain(await fs.realpath(deckPath));
      expect(first.dependencies).toContain(await fs.realpath(modulePath));

      await fs.writeFile(modulePath, "export default { version: 200 }", "utf8");
      const second = await previewPresentationFile({
        cwd: dir,
        filePath: "deck.pptx",
        builtInDir: dir,
        env: localRuntimeEnv(dir),
      });
      expect(second.ok).toBe(true);
      if (!second.ok) return;

      expect(second.dependencies).toContain(await fs.realpath(deckPath));
      expect(second.dependencies).toContain(await fs.realpath(modulePath));
      expect(second.version.fingerprint).not.toBe(first.version.fingerprint);
    });
  });

  test("does not load cached slides from an adjacent directory outside the workspace", async () => {
    await withTempDir(async (dir) => {
      const workspace = path.join(dir, "workspace");
      const outsidePreviewDir = path.join(dir, "preview");
      await fs.mkdir(workspace);
      await fs.mkdir(outsidePreviewDir);
      await fs.writeFile(path.join(workspace, "deck.pptx"), "fake-pptx-bytes", "utf8");
      await fs.writeFile(path.join(outsidePreviewDir, "slide-1.png"), "outside-slide", "utf8");

      const result = await previewPresentationFile({
        cwd: workspace,
        filePath: "deck.pptx",
        builtInDir: workspace,
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.kind).toBe("compile_error");
        expect(result.error.message).toContain("Slide rendering script not found");
      }
    });
  });

  test("does not follow cached slide symlinks outside the workspace", async () => {
    await withTempDir(async (dir) => {
      const workspace = path.join(dir, "workspace");
      const previewDir = path.join(workspace, "preview");
      const outsideSlide = path.join(dir, "outside-slide.png");
      await fs.mkdir(previewDir, { recursive: true });
      await fs.writeFile(path.join(workspace, "deck.pptx"), "fake-pptx-bytes", "utf8");
      await fs.writeFile(outsideSlide, "outside-slide", "utf8");
      try {
        await fs.symlink(outsideSlide, path.join(previewDir, "slide-1.png"));
      } catch {
        return;
      }

      const result = await previewPresentationFile({
        cwd: workspace,
        filePath: "deck.pptx",
        builtInDir: workspace,
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.kind).toBe("compile_error");
        expect(result.error.message).toContain("Slide rendering script not found");
      }
    });
  });

  test("does not render slide module symlinks outside the workspace", async () => {
    await withTempDir(async (dir) => {
      const workspace = path.join(dir, "workspace");
      const slidesDir = path.join(workspace, "slides");
      const outsideSlide = path.join(dir, "slide-1.mjs");
      await fs.mkdir(slidesDir, { recursive: true });
      await fs.writeFile(path.join(workspace, "deck.pptx"), "fake-pptx-bytes", "utf8");
      await fs.writeFile(outsideSlide, "export default {}", "utf8");
      try {
        await fs.symlink(outsideSlide, path.join(slidesDir, "slide-1.mjs"));
      } catch {
        return;
      }

      const scriptDir = path.join(workspace, "skills/presentations/scripts");
      await fs.mkdir(scriptDir, { recursive: true });
      await fs.writeFile(
        path.join(scriptDir, "render_artifact_slide.mjs"),
        `
          import fs from "node:fs";
          const outIdx = process.argv.indexOf("--output");
          fs.writeFileSync(process.argv[outIdx + 1], "outside-slide");
        `,
        "utf8",
      );

      const result = await previewPresentationFile({
        cwd: workspace,
        filePath: "deck.pptx",
        builtInDir: workspace,
        env: localRuntimeEnv(workspace),
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.kind).toBe("no_slides");
        expect(result.error.message).toContain("No slide source modules");
      }
    });
  });

  test("rejects paths outside the workspace root", async () => {
    await withTempDir(async (dir) => {
      const outsideDir = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-presentation-outside-"));
      try {
        const outsideFile = path.join(outsideDir, "slide.mjs");
        await fs.writeFile(outsideFile, "export default {}", "utf8");

        const result = await previewPresentationFile({
          cwd: dir,
          filePath: outsideFile,
          builtInDir: dir,
        });

        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error.kind).toBe("no_slides");
          expect(result.error.message).toContain("outside the workspace root");
        }
      } finally {
        await fs.rm(outsideDir, { recursive: true, force: true });
      }
    });
  });
});
