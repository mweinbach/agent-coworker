import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { prepareCoworkRuntimeToolEnv } from "../coworkRuntime";
import { buildPluginCatalogSnapshot } from "../plugins";
import type { FileChangeVersion } from "../shared/fileVersion";
import type { AgentConfig } from "../types";
import { fileChangeVersionFromStat } from "../utils/filePreviewRead";
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
      path: string;
      slides: PresentationSlide[];
      version: FileChangeVersion;
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

async function resolvePresentationScript(
  builtInDir: string,
  config: AgentConfig | undefined,
): Promise<{ scriptPath: string | null; expectedPath: string }> {
  const builtInScript = path.join(
    builtInDir,
    "skills",
    "presentations",
    "scripts",
    "render_artifact_slide.mjs",
  );
  const marketplaceScript = await resolveMarketplacePresentationScript(config);
  const scriptCandidates = [...(marketplaceScript ? [marketplaceScript] : []), builtInScript];

  for (const candidate of scriptCandidates) {
    if (await fs.stat(candidate).catch(() => null)) {
      return { scriptPath: candidate, expectedPath: candidate };
    }
  }

  return {
    scriptPath: null,
    expectedPath: marketplaceScript ?? builtInScript,
  };
}

async function loadCachedPresentationSlides(
  resolvedPath: string,
  cwd: string,
): Promise<PresentationSlide[] | null> {
  const pptxDir = path.dirname(resolvedPath);
  const candidateDirs = [
    path.join(pptxDir, "preview"),
    path.join(pptxDir, "../preview"),
    path.join(cwd, "preview"),
  ];

  for (const candidateDir of candidateDirs) {
    try {
      const previewDir = await resolveWorkspaceFilePath(cwd, candidateDir);
      const files = await fs.readdir(previewDir);
      const pngFiles = files
        .filter((filename) => /^slide[-_]?\d+\.png$/i.test(filename))
        .sort((a, b) => {
          const numA = Number.parseInt(a.match(/\d+/)?.[0] || "0", 10);
          const numB = Number.parseInt(b.match(/\d+/)?.[0] || "0", 10);
          return numA - numB;
        });

      if (pngFiles.length === 0) continue;

      const slides: PresentationSlide[] = [];
      for (const filename of pngFiles) {
        let pngPath: string;
        try {
          pngPath = await resolveWorkspaceFilePath(cwd, path.join(previewDir, filename));
        } catch {
          continue;
        }
        const pngBuffer = await fs.readFile(pngPath);
        const slideName = path.basename(filename, ".png");
        slides.push({
          slideIndex: slides.length,
          slideId: slideName,
          title: slideName,
          pngBase64: `data:image/png;base64,${pngBuffer.toString("base64")}`,
        });
      }
      if (slides.length > 0) {
        return slides;
      }
    } catch {}
  }

  return null;
}

async function findPresentationSlideModules(cwd: string): Promise<string[]> {
  let slidesDir: string;
  let files: string[];
  try {
    slidesDir = await resolveWorkspaceFilePath(cwd, path.join(cwd, "slides"));
    files = await fs.readdir(slidesDir);
  } catch {
    try {
      slidesDir = await resolveWorkspaceFilePath(cwd, cwd);
      files = await fs.readdir(slidesDir);
    } catch {
      return [];
    }
  }

  const slideModules = (
    await Promise.all(
      files
        .filter((filename) => /^slide[-_]?\d+\.mjs$/i.test(filename))
        .map(async (filename) => {
          try {
            const modulePath = await resolveWorkspaceFilePath(cwd, path.join(slidesDir, filename));
            return (await fs.stat(modulePath)).isFile() ? modulePath : null;
          } catch {
            return null;
          }
        }),
    )
  ).filter((modulePath): modulePath is string => modulePath !== null);
  slideModules.sort((a, b) => {
    const numA = Number.parseInt(path.basename(a).match(/\d+/)?.[0] || "0", 10);
    const numB = Number.parseInt(path.basename(b).match(/\d+/)?.[0] || "0", 10);
    return numA - numB;
  });
  return slideModules;
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
  const sourceVersion = fileChangeVersionFromStat(await fs.stat(resolvedPath));

  if (isPptx) {
    const cachedSlides = await loadCachedPresentationSlides(resolvedPath, request.cwd);
    if (cachedSlides) {
      return { ok: true, path: resolvedPath, slides: cachedSlides, version: sourceVersion };
    }
  }

  const { scriptPath, expectedPath } = await resolvePresentationScript(
    request.builtInDir,
    request.config,
  );
  if (!scriptPath) {
    return {
      ok: false,
      error: {
        kind: "compile_error",
        message: `Slide rendering script not found at expected path: ${expectedPath}`,
      },
    };
  }

  const slideModules = isPptx ? await findPresentationSlideModules(request.cwd) : [];
  if (isPptx && slideModules.length === 0) {
    return {
      ok: false,
      error: {
        kind: "no_slides",
        message: "No slide source modules or pre-rendered previews found for this deck.",
      },
    };
  }

  const { nodeBin, env } = await resolvePresentationRuntimeEnv(request.env);

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
        path: resolvedPath,
        slides: [
          {
            slideIndex: 0,
            slideId: slideName,
            title: slideName,
            pngBase64,
          },
        ],
        version: sourceVersion,
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

  // PPTX Preview: render the slide source modules discovered before runtime startup.
  try {
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

    return { ok: true, path: resolvedPath, slides, version: sourceVersion };
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
