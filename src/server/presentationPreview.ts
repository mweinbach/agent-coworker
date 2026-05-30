import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
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

async function resolveNodeBinary(): Promise<string> {
  if (process.env.COWORK_ARTIFACT_RUNTIME_NODE) {
    return process.env.COWORK_ARTIFACT_RUNTIME_NODE;
  }
  const home = process.env.HOME || process.env.USERPROFILE || "";
  const candidates = [
    path.join(home, ".cache/cowork/artifact-runtime/node/bin/node"),
    path.join(home, ".cache/cowork/artifact-runtime/dependencies/node/bin/node"),
    path.join(home, ".cache/cowork/artifact-runtime/bin/node"),
  ];
  for (const c of candidates) {
    try {
      await fs.stat(c);
      return c;
    } catch {}
  }
  return "node";
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

  const nodeBin = await resolveNodeBinary();
  const scriptPath = path.join(
    request.builtInDir,
    "skills",
    "presentations",
    "scripts",
    "render_artifact_slide.mjs",
  );

  // Check if render script exists
  try {
    await fs.stat(scriptPath);
  } catch {
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
        { cwd: request.cwd },
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
          { cwd: request.cwd },
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
