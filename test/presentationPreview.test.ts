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

  test("returns error when rendering script is missing", async () => {
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

  test("runs mock rendering script successfully for a single slide", async () => {
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

  test("runs the marketplace presentation skill with the separate runtime environment", async () => {
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

  test("dynamic deck compilation renders all slide modules in order", async () => {
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

  test("loads cached PNG slides directly when available in preview/ folder", async () => {
    await withTempDir(async (dir) => {
      // 1. Set up pre-rendered preview files and dummy pptx file
      const previewDir = path.join(dir, "preview");
      await fs.mkdir(previewDir, { recursive: true });
      await fs.writeFile(path.join(dir, "deck.pptx"), "fake-pptx-bytes", "utf8");

      const pngPath = path.join(previewDir, "slide-1.png");
      await fs.writeFile(pngPath, "cached-slide-data", "utf8");

      // Mock script (not used in this test because it loads directly from cache)
      const scriptDir = path.join(dir, "skills/presentations/scripts");
      await fs.mkdir(scriptDir, { recursive: true });
      await fs.writeFile(
        path.join(scriptDir, "render_artifact_slide.mjs"),
        "process.exit(1);",
        "utf8",
      );

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
