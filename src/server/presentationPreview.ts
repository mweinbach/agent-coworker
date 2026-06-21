import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { prepareCoworkRuntimeToolEnv } from "../coworkRuntime";
import { buildPluginCatalogSnapshot } from "../plugins";
import type { AgentConfig } from "../types";
import { runCommand } from "./sessionBackup/command";
import { resolveWorkspaceFilePath } from "./spreadsheetPreview";

function isSlideModule(filePath: string): boolean {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".mjs") {
    const filename = path.basename(filePath);
    return /^slide[-_]?\d+\.mjs$/i.test(filename);
  }
  return false;
}

export type PresentationPreviewRequest = {
  cwd: string;
  filePath: string;
  builtInDir: string;
  config?: AgentConfig;
  env?: Record<string, string | undefined>;
};

type PresentationSlide = {
  slideIndex: number;
  slideId?: string;
  title?: string;
  pngBase64: string;
};

export type PresentationPreviewResult =
  | {
      ok: true;
      slides: PresentationSlide[];
    }
  | {
      ok: false;
      error: {
        kind: "unsupported_format" | "compile_error" | "no_slides";
        message: string;
      };
    };

async function resolvePresentationRuntimeEnv(
  requestEnv: Record<string, string | undefined> | undefined,
): Promise<{ nodeBin: string; env: NodeJS.ProcessEnv }> {
  const baseEnv: NodeJS.ProcessEnv = { ...process.env, ...requestEnv };
  const home = baseEnv.HOME || baseEnv.USERPROFILE || os.homedir();
  const env = await prepareCoworkRuntimeToolEnv({ homedir: home, env: baseEnv });
  return {
    nodeBin: env.COWORK_RUNTIME_NODE || "node",
    env,
  };
}

async function resolveMarketplacePresentationScript(
  config: AgentConfig | undefined,
): Promise<string | null> {
  if (!config) return null;
  const catalog = await buildPluginCatalogSnapshot(config);
  for (const plugin of catalog.plugins) {
    if (!plugin.enabled) continue;
    const skill = plugin.skills.find(
      (candidate) => candidate.rawName === "presentations" && candidate.enabled,
    );
    if (!skill) continue;
    const candidate = path.join(skill.rootDir, "scripts", "render_artifact_slide.mjs");
    if (await fs.stat(candidate).catch(() => null)) return candidate;
  }
  return null;
}

export async function previewPresentationFile(
  request: PresentationPreviewRequest,
): Promise<PresentationPreviewResult> {
  let resolvedPath: string;
  try {
    resolvedPath = await resolveWorkspaceFilePath(request.cwd, request.filePath);
  } catch (err) {
    return {
      ok: false,
      error: {
        kind: "no_slides",
        message: err instanceof Error ? err.message : String(err),
      },
    };
  }

  const ext = path.extname(resolvedPath).toLowerCase();
  const isPptx = ext === ".pptx" || ext === ".ppt";
  const isSlide = isSlideModule(resolvedPath);

  if (!isPptx && !isSlide) {
    return {
      ok: false,
      error: {
        kind: "unsupported_format",
        message: "Presentation preview supports slide modules (.mjs) and compiled decks (.pptx).",
      },
    };
  }

  const { nodeBin, env } = await resolvePresentationRuntimeEnv(request.env);
  const marketplaceScript = await resolveMarketplacePresentationScript(request.config);
  const scriptCandidates = [
    ...(marketplaceScript ? [marketplaceScript] : []),
    path.join(
      request.builtInDir,
      "skills",
      "presentations",
      "scripts",
      "render_artifact_slide.mjs",
    ),
  ];
  const scriptPath =
    (
      await Promise.all(
        scriptCandidates.map(async (candidate) => ({
          candidate,
          exists: Boolean(await fs.stat(candidate).catch(() => null)),
        })),
      )
    ).find((entry) => entry.exists)?.candidate ?? scriptCandidates[0];

  // Check if render script exists
  if (!scriptPath || !(await fs.stat(scriptPath).catch(() => null))) {
    return {
      ok: false,
      error: {
        kind: "compile_error",
        message: `Slide rendering script not found at expected path: ${scriptPath}`,
      },
    };
  }

  if (isSlide) {
    // Single slide preview
    const tempPngPath = path.join(os.tmpdir(), `cowork-slide-${crypto.randomUUID()}.png`);
    try {
      const runResult = await runCommand(
        nodeBin,
        [
          scriptPath,
          "--slide-module",
          resolvedPath,
          "--output",
          tempPngPath,
          "--workspace",
          request.cwd,
        ],
        { cwd: request.cwd, env },
      );

      if (runResult.exitCode !== 0) {
        return {
          ok: false,
          error: {
            kind: "compile_error",
            message: `Slide render failed:\n${runResult.stderr || runResult.stdout}`,
          },
        };
      }

      const pngBuffer = await fs.readFile(tempPngPath);
      const pngBase64 = `data:image/png;base64,${pngBuffer.toString("base64")}`;

      // Clean up
      await fs.unlink(tempPngPath).catch(() => {});

      const slideName = path.basename(resolvedPath, ext);
      return {
        ok: true,
        slides: [
          {
            slideIndex: 0,
            slideId: slideName,
            title: slideName,
            pngBase64,
          },
        ],
      };
    } catch (err) {
      await fs.unlink(tempPngPath).catch(() => {});
      return {
        ok: false,
        error: {
          kind: "compile_error",
          message: err instanceof Error ? err.message : String(err),
        },
      };
    }
  }

  // PPTX Preview: Load multiple slides
  try {
    // 1. Try to find preview PNGs first (fast cache)
    const pptxDir = path.dirname(resolvedPath);
    const searchDirs = [
      path.join(pptxDir, "preview"),
      path.join(pptxDir, "../preview"),
      path.join(request.cwd, "preview"),
    ];

    for (const previewDir of searchDirs) {
      try {
        const files = await fs.readdir(previewDir);
        const pngFiles = files
          .filter((f) => /^slide[-_]?\d+\.png$/i.test(f))
          .sort((a, b) => {
            const numA = parseInt(a.match(/\d+/)?.[0] || "0", 10);
            const numB = parseInt(b.match(/\d+/)?.[0] || "0", 10);
            return numA - numB;
          });

        if (pngFiles.length > 0) {
          const slides: PresentationSlide[] = [];
          for (let i = 0; i < pngFiles.length; i++) {
            const filename = pngFiles[i];
            if (!filename) continue;
            const pngPath = path.join(previewDir, filename);
            const pngBuffer = await fs.readFile(pngPath);
            const pngBase64 = `data:image/png;base64,${pngBuffer.toString("base64")}`;
            const slideName = path.basename(filename, ".png");
            slides.push({
              slideIndex: i,
              slideId: slideName,
              title: slideName,
              pngBase64,
            });
          }
          return { ok: true, slides };
        }
      } catch {}
    }

    // 2. Dynamic compilation fallback: find all slide mjs modules in the workspace
    const slidesDir = path.join(request.cwd, "slides");
    let slideModules: string[] = [];
    try {
      const files = await fs.readdir(slidesDir);
      slideModules = files
        .filter((f) => /^slide[-_]?\d+\.mjs$/i.test(f))
        .map((f) => path.join(slidesDir, f));
    } catch {
      // Sibling or recursive check
      try {
        const files = await fs.readdir(request.cwd);
        slideModules = files
          .filter((f) => /^slide[-_]?\d+\.mjs$/i.test(f))
          .map((f) => path.join(request.cwd, f));
      } catch {}
    }

    if (slideModules.length === 0) {
      return {
        ok: false,
        error: {
          kind: "no_slides",
          message: "No slide source modules or pre-rendered previews found for this deck.",
        },
      };
    }

    // Sort slide modules numerically
    slideModules.sort((a, b) => {
      const numA = parseInt(path.basename(a).match(/\d+/)?.[0] || "0", 10);
      const numB = parseInt(path.basename(b).match(/\d+/)?.[0] || "0", 10);
      return numA - numB;
    });

    const slides: PresentationSlide[] = [];
    for (let i = 0; i < slideModules.length; i++) {
      const modulePath = slideModules[i];
      if (!modulePath) continue;
      const tempPngPath = path.join(
        os.tmpdir(),
        `cowork-slide-pptx-${i}-${crypto.randomUUID()}.png`,
      );

      try {
        const runResult = await runCommand(
          nodeBin,
          [
            scriptPath,
            "--slide-module",
            modulePath,
            "--output",
            tempPngPath,
            "--workspace",
            request.cwd,
          ],
          { cwd: request.cwd, env },
        );

        if (runResult.exitCode === 0) {
          const pngBuffer = await fs.readFile(tempPngPath);
          const pngBase64 = `data:image/png;base64,${pngBuffer.toString("base64")}`;
          const slideName = path.basename(modulePath, ".mjs");
          slides.push({
            slideIndex: i,
            slideId: slideName,
            title: slideName,
            pngBase64,
          });
        }
      } catch {
      } finally {
        await fs.unlink(tempPngPath).catch(() => {});
      }
    }

    if (slides.length === 0) {
      return {
        ok: false,
        error: {
          kind: "compile_error",
          message: "Failed to render any of the slide modules.",
        },
      };
    }

    return { ok: true, slides };
  } catch (err) {
    return {
      ok: false,
      error: {
        kind: "compile_error",
        message: err instanceof Error ? err.message : String(err),
      },
    };
  }
}
