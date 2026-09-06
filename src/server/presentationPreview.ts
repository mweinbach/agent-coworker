import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import {
  prepareCoworkRuntimeToolEnv,
  readRuntimeManifest,
  verifyRuntimeIntegrityForUse,
} from "../coworkRuntime";
import { TRUSTED_COWORK_RUNTIME_KEYS } from "../coworkRuntime/trustedKeys";
import { home } from "../platform/paths";
import { run } from "../platform/proc";
import { type SandboxManager, sandboxManager, scratchRoots } from "../platform/sandbox";
import type { FileChangeVersion } from "../shared/fileVersion";
import type { AgentConfig } from "../types";
import { raceWithAbort } from "../utils/abortSignal";
import { readCappedFilePreview } from "../utils/filePreviewRead";
import { extractPptxSnapshot } from "./artifacts/pptx";
import type { PptxSlide } from "./artifacts/types";
import { resolveWorkspaceFilePath } from "./spreadsheetPreview";

const MAX_PRESENTATION_BYTES = 100 * 1024 * 1024;
const MAX_PRESENTATION_SLIDES = 200;
const MAX_SLIDE_IMAGE_BYTES = 4 * 1024 * 1024;
const MAX_TOTAL_IMAGE_BYTES = 16 * 1024 * 1024;
const PREVIEW_TIMEOUT_MS = 25_000;
const TEXT_PREVIEW_WARNING =
  "Text-only preview: images, charts, layout, and original styling are not shown. Long slide text may be shortened.";

export type PresentationPreviewRequest = {
  cwd: string;
  filePath: string;
  builtInDir: string;
  config?: AgentConfig;
  env?: Record<string, string | undefined>;
  signal?: AbortSignal;
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
      dependencies: string[];
      path: string;
      slides: PresentationSlide[];
      version: FileChangeVersion;
      renderingMode?: "rendered" | "text";
      warnings?: string[];
    }
  | {
      ok: false;
      error: { kind: "unsupported_format" | "compile_error" | "no_slides"; message: string };
    };

type NativePresentationRuntime = {
  soffice: string;
  pdftoppm: string;
  env: Record<string, string | undefined>;
};
type PresentationPreviewDeps = {
  resolveRuntime: (
    env: Record<string, string | undefined> | undefined,
  ) => Promise<NativePresentationRuntime | null>;
  runProcess: typeof run;
  transform: SandboxManager["transform"];
  timeoutMs: number;
};

async function resolveNativeRuntime(
  requestEnv: Record<string, string | undefined> | undefined,
): Promise<NativePresentationRuntime | null> {
  const baseEnv = { ...process.env, ...requestEnv };
  const env = await prepareCoworkRuntimeToolEnv({ homedir: home(baseEnv), env: baseEnv });
  const runtimeDir = env.COWORK_RUNTIME_DIR;
  if (!runtimeDir) return null;
  const manifest = await readRuntimeManifest(runtimeDir);
  if (!manifest.paths.soffice || !manifest.paths.pdftoppm) return null;
  // Select only signed entrypoints, never inherited markers or workspace PATH executables.
  await verifyRuntimeIntegrityForUse({
    root: runtimeDir,
    manifest,
    trustedKeys: TRUSTED_COWORK_RUNTIME_KEYS,
    entrypoints: ["soffice", "pdftoppm"],
  });
  const soffice = path.join(runtimeDir, ...manifest.paths.soffice.split("/"));
  const pdftoppm = path.join(runtimeDir, ...manifest.paths.pdftoppm.split("/"));
  const stats = await Promise.all([fs.stat(soffice), fs.stat(pdftoppm)]);
  if (!stats.every((stat) => stat.isFile()) || env.COWORK_RUNTIME_SOFFICE !== soffice) return null;
  return { soffice, pdftoppm, env };
}

function assertActive(signal: AbortSignal, deadline: number): void {
  if (signal.aborted)
    throw new Error(
      signal.reason instanceof Error
        ? signal.reason.message
        : "Presentation preview was cancelled.",
    );
  if (Date.now() >= deadline) throw new Error("Presentation preview timed out.");
}

function escapeSlideSvg(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function renderTextSlide(slide: PptxSlide): PresentationSlide {
  const lines: string[] = [];
  for (const word of slide.text.slice(0, 10_000).split(/\s+/)) {
    const previous = lines.at(-1);
    if (!previous || previous.length + word.length + 1 > 88) lines.push(word);
    else lines[lines.length - 1] = `${previous} ${word}`;
    if (lines.length > 18) break;
  }
  const truncated = lines.length > 18 || slide.text.length > 10_000;
  const visibleLines = lines.slice(0, 18);
  if (truncated) visibleLines[17] = "… More slide text omitted";
  const text = visibleLines
    .map(
      (line, index) => `<tspan x="80" dy="${index === 0 ? 0 : 38}">${escapeSlideSvg(line)}</tspan>`,
    )
    .join("");
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1600 900"><rect width="1600" height="900" fill="white"/><text x="80" y="70" font-family="Arial,sans-serif" font-size="24" fill="#666">Slide ${slide.index + 1} · Text-only preview</text><text x="80" y="132" font-family="Arial,sans-serif" font-size="30" fill="#202124">${text}</text></svg>`;
  return {
    slideIndex: slide.index,
    slideId: slide.id,
    title:
      slide.shapes.find((shape) => shape.text.trim())?.text.slice(0, 200) ||
      `Slide ${slide.index + 1}`,
    pngBase64: `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`,
  };
}

async function renderNativeSlides(opts: {
  bytes: Uint8Array;
  extension: string;
  packagedSlides: PptxSlide[] | null;
  runtime: NativePresentationRuntime;
  signal: AbortSignal;
  deadline: number;
  runProcess: typeof run;
  transform: SandboxManager["transform"];
}): Promise<PresentationSlide[]> {
  const stage = await fs.realpath(
    await fs.mkdtemp(path.join(scratchRoots()[0] ?? "/tmp", "cowork-presentation-")),
  );
  try {
    assertActive(opts.signal, opts.deadline);
    // The source copy is read-only to children: only its sibling scratch directory
    // is writable. Existing sandbox backends provide full-disk read access, not
    // input-only read grants. Never grant writes to the workspace or runtime.
    const sourcePath = path.join(stage, `source${opts.extension}`);
    const scratch = path.join(stage, "scratch");
    await fs.mkdir(scratch, { mode: 0o700 });
    const pdfPath = path.join(scratch, "source.pdf");
    await fs.writeFile(sourcePath, opts.bytes, { mode: 0o600 });
    // Remove case aliases as well: Windows environment names are case-insensitive.
    const env = Object.fromEntries(
      Object.entries(opts.runtime.env).filter(
        ([key]) =>
          !["TMPDIR", "TMP", "TEMP", "COWORK_SANDBOX", "COWORK_SANDBOX_NETWORK_DISABLED"].includes(
            key.toUpperCase(),
          ),
      ),
    );
    const execute = async (command: string, args: string[]) => {
      assertActive(opts.signal, opts.deadline);
      const sandboxed = opts.transform({
        file: command,
        args,
        cwd: scratch,
        // Previewing untrusted documents must never inherit YOLO or workspace
        // network/write permissions, nor fall back to an unwrapped process.
        policy: { kind: "workspace-write", writableRoots: [scratch], network: false },
      });
      if (
        sandboxed.unsandboxed ||
        sandboxed.sandbox === "none" ||
        !sandboxed.enforcement.filesystem ||
        !sandboxed.enforcement.network ||
        !sandboxed.enforcement.process ||
        !sandboxed.enforcement.integrity
      )
        throw new Error(
          `Sandbox enforcement unavailable; native presentation rendering was not run. ${sandboxed.warning ?? "Install or repair the sandbox backend."}`.trim(),
        );
      assertActive(opts.signal, opts.deadline);
      const result = await opts.runProcess(sandboxed.file, sandboxed.args, {
        cwd: scratch,
        // The managed launcher creates and removes its own isolated LO profile.
        // Keep that profile under this job's stage, including on abrupt exit.
        env: { ...env, TMPDIR: scratch, TMP: scratch, TEMP: scratch, ...sandboxed.env },
        signal: opts.signal,
        timeoutMs: Math.max(1, opts.deadline - Date.now()),
        maxBuffer: 256 * 1024,
        killSignal: "SIGKILL",
        resolve: true,
      });
      assertActive(opts.signal, opts.deadline);
      if (result.exitCode !== 0 || result.errorCode)
        throw new Error(
          result.errorCode ||
            (result.stderr || result.stdout).trim().slice(0, 2_000) ||
            "Native renderer failed.",
        );
    };
    await execute(opts.runtime.soffice, [
      "--headless",
      "--convert-to",
      "pdf",
      "--outdir",
      scratch,
      sourcePath,
    ]);
    const pdf = await fs.lstat(pdfPath);
    if (!pdf.isFile() || pdf.size === 0 || pdf.size > MAX_PRESENTATION_BYTES)
      throw new Error("Native renderer did not produce a bounded PDF.");
    await execute(opts.runtime.pdftoppm, [
      "-png",
      "-scale-to",
      "1600",
      "-f",
      "1",
      "-l",
      String(MAX_PRESENTATION_SLIDES + 1),
      pdfPath,
      path.join(scratch, "slide"),
    ]);
    const images = (await fs.readdir(scratch))
      .flatMap((name) => {
        const match = /^slide-(\d+)\.png$/.exec(name);
        return match ? [{ name, number: Number(match[1]) }] : [];
      })
      .sort((left, right) => left.number - right.number);
    if (
      images.length === 0 ||
      images.length > MAX_PRESENTATION_SLIDES ||
      images.some((image, index) => image.number !== index + 1) ||
      (opts.packagedSlides && images.length !== opts.packagedSlides.length)
    )
      throw new Error("Native renderer did not produce every slide. No partial render was used.");
    let totalBytes = 0;
    const slides: PresentationSlide[] = [];
    for (const [index, image] of images.entries()) {
      assertActive(opts.signal, opts.deadline);
      const imagePath = path.join(scratch, image.name);
      const preview = await readCappedFilePreview(imagePath, MAX_SLIDE_IMAGE_BYTES, {
        expectedCanonicalPath: imagePath,
      });
      assertActive(opts.signal, opts.deadline);
      const bytes = Buffer.from(preview.bytes);
      totalBytes += bytes.byteLength;
      if (
        preview.truncated ||
        totalBytes > MAX_TOTAL_IMAGE_BYTES ||
        !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
      )
        throw new Error("Rendered slide images exceed preview limits or are invalid.");
      const packaged = opts.packagedSlides?.[index];
      slides.push({
        slideIndex: index,
        slideId: packaged?.id ?? String(index + 1),
        title:
          packaged?.shapes.find((shape) => shape.text.trim())?.text.slice(0, 200) ||
          `Slide ${index + 1}`,
        pngBase64: `data:image/png;base64,${bytes.toString("base64")}`,
      });
    }
    return slides;
  } finally {
    await fs.rm(stage, { recursive: true, force: true });
  }
}

export function createPresentationPreviewer(overrides: Partial<PresentationPreviewDeps> = {}) {
  const deps: PresentationPreviewDeps = {
    resolveRuntime: resolveNativeRuntime,
    runProcess: run,
    transform: (input) => sandboxManager.transform(input),
    timeoutMs: PREVIEW_TIMEOUT_MS,
    ...overrides,
  };
  return async (request: PresentationPreviewRequest): Promise<PresentationPreviewResult> => {
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(new Error("Presentation preview timed out.")),
      deps.timeoutMs,
    );
    timer.unref?.();
    const signal = request.signal
      ? AbortSignal.any([request.signal, controller.signal])
      : controller.signal;
    const deadline = Date.now() + deps.timeoutMs;
    try {
      assertActive(signal, deadline);
      const resolvedPath = await raceWithAbort(
        resolveWorkspaceFilePath(request.cwd, request.filePath),
        signal,
        "Presentation preview timed out or was cancelled.",
      );
      assertActive(signal, deadline);
      const extension = path.extname(resolvedPath).toLowerCase();
      if (extension !== ".pptx" && extension !== ".ppt")
        return {
          ok: false,
          error: {
            kind: "unsupported_format",
            message:
              "Presentation preview supports exported PowerPoint decks (.pptx or .ppt). Export JavaScript slide sources first; opening a preview does not execute workspace code.",
          },
        };
      const stat = await raceWithAbort(
        fs.stat(resolvedPath),
        signal,
        "Presentation preview timed out or was cancelled.",
      );
      assertActive(signal, deadline);
      if (!stat.isFile() || stat.size > MAX_PRESENTATION_BYTES)
        throw new Error("Presentation exceeds the 100 MiB preview limit or is not a file.");
      const source = await raceWithAbort(
        readCappedFilePreview(resolvedPath, MAX_PRESENTATION_BYTES, {
          expectedCanonicalPath: resolvedPath,
        }),
        signal,
        "Presentation preview timed out or was cancelled.",
      );
      if (source.truncated) throw new Error("Presentation could not be read completely.");
      const packagedSlides =
        extension === ".pptx"
          ? (
              await raceWithAbort(
                extractPptxSnapshot(source.bytes, {
                  maxSlides: MAX_PRESENTATION_SLIDES,
                  includeMedia: false,
                  signal,
                }),
                signal,
                "Presentation preview timed out or was cancelled.",
              )
            ).slides
          : null;
      assertActive(signal, deadline);
      const version: FileChangeVersion = {
        ...source.version,
        fingerprint: `sha256:${createHash("sha256").update(source.bytes).digest("hex")}`,
      };
      const base = { dependencies: [resolvedPath], path: resolvedPath, version };
      let warning = "The verified native presentation renderer is unavailable.";
      try {
        const runtime = await raceWithAbort(
          deps.resolveRuntime(request.env),
          signal,
          "Presentation preview timed out or was cancelled.",
        );
        assertActive(signal, deadline);
        if (runtime) {
          const slides = await renderNativeSlides({
            bytes: source.bytes,
            extension,
            packagedSlides,
            runtime,
            signal,
            deadline,
            runProcess: deps.runProcess,
            transform: deps.transform,
          });
          assertActive(signal, deadline);
          return { ok: true, ...base, slides, renderingMode: "rendered", warnings: [] };
        }
      } catch (error) {
        assertActive(signal, deadline);
        warning = `Native rendering failed: ${error instanceof Error ? error.message : String(error)}`;
      }
      if (!packagedSlides)
        return {
          ok: false,
          error: {
            kind: "unsupported_format",
            message: `${warning} Export this legacy .ppt deck to .pptx for a text-only preview.`,
          },
        };
      const slides = packagedSlides.map(renderTextSlide);
      assertActive(signal, deadline);
      return {
        ok: true,
        ...base,
        slides,
        renderingMode: "text",
        warnings: [warning, TEXT_PREVIEW_WARNING],
      };
    } catch (error) {
      return {
        ok: false,
        error: {
          kind: "compile_error",
          message: error instanceof Error ? error.message : String(error),
        },
      };
    } finally {
      clearTimeout(timer);
    }
  };
}

export const previewPresentationFile = createPresentationPreviewer();
