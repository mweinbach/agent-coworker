#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import {
  createSlideContext,
  ensureArtifactToolWorkspace,
  importArtifactTool,
  importModuleFresh,
  padSlideNumber,
  parseArgs,
  parseSlideSize,
  requireArg,
  resolveSlideFunction,
  saveBlobToFile,
  slideNumberFromModuleName,
} from "./artifact_tool_utils.mjs";

function usage() {
  return [
    "Usage:",
    "  node scripts/build_artifact_deck.mjs --slides-dir <dir> --out <output.pptx> --preview-dir <dir> [options]",
    "",
    "Options:",
    "  --workspace <dir>           Builder workspace. Defaults to the slides-dir parent.",
    "  --reference-dir <dir>       Optional directory containing slide-XX.png references.",
    "  --layout-dir <dir>          Optional layout JSON directory.",
    "  --contact-sheet <path>      Optional PNG contact sheet path.",
    "  --manifest <path>           Optional JSON manifest path.",
    "  --slide-count <n>           Require exactly n slide modules.",
    "  --slide-size <WxH>          Slide size in pixels. Defaults to 1280x720.",
    "  --scale <number>            Preview render scale. Defaults to 1.",
  ].join("\n");
}

async function discoverSlideModules(slidesDir) {
  const entries = await fs.readdir(slidesDir);
  const modules = entries
    .filter((entry) => /^slide[-_]?\d+\.mjs$/i.test(entry))
    .map((entry) => {
      const absolutePath = path.join(slidesDir, entry);
      return {
        path: absolutePath,
        slideNumber: slideNumberFromModuleName(absolutePath),
      };
    })
    .filter((entry) => Number.isInteger(entry.slideNumber))
    .sort((a, b) => a.slideNumber - b.slideNumber);

  if (modules.length === 0) {
    throw new Error(`No slide modules found in ${slidesDir}. Expected files like slide-01.mjs.`);
  }

  return modules;
}

async function maybeWriteLayout(presentation, slide, layoutPath) {
  try {
    const layoutBlob = await presentation.export({ slide, format: "layout" });
    await fs.mkdir(path.dirname(layoutPath), { recursive: true });
    await fs.writeFile(layoutPath, await layoutBlob.text(), "utf8");
    return { layoutPath };
  } catch (error) {
    return { layoutError: error.message || String(error) };
  }
}

function runContactSheet(previewPaths, outputPath) {
  if (!outputPath) return undefined;
  const scriptPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "make_contact_sheet.py");
  const python = process.env.PYTHON || "python3";
  const result = spawnSync(
    python,
    [scriptPath, "--output", outputPath, ...previewPaths],
    { encoding: "utf8" },
  );
  if (result.status !== 0) {
    throw new Error(
      [
        `Contact sheet generation failed with ${python}.`,
        result.stdout.trim(),
        result.stderr.trim(),
      ]
        .filter(Boolean)
        .join("\n"),
    );
  }
  return outputPath;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(usage());
    return;
  }

  const slidesDir = path.resolve(requireArg(args, "slides-dir"));
  const out = path.resolve(requireArg(args, "out"));
  const previewDir = path.resolve(requireArg(args, "preview-dir"));
  const workspace = path.resolve(args.workspace || path.dirname(slidesDir));
  const referenceDir = args["reference-dir"] ? path.resolve(args["reference-dir"]) : undefined;
  const layoutDir = args["layout-dir"] ? path.resolve(args["layout-dir"]) : undefined;
  const manifestPath = args.manifest
    ? path.resolve(args.manifest)
    : path.join(path.dirname(out), "artifact-build-manifest.json");
  const contactSheetPath = args["contact-sheet"] ? path.resolve(args["contact-sheet"]) : undefined;
  const slideSize = parseSlideSize(args["slide-size"]);
  const scale = args.scale ? Number.parseFloat(args.scale) : 1;

  await ensureArtifactToolWorkspace(workspace);
  const artifact = await importArtifactTool(workspace);
  const { Presentation, PresentationFile } = artifact;
  const modules = await discoverSlideModules(slidesDir);

  if (args["slide-count"] && modules.length !== Number.parseInt(args["slide-count"], 10)) {
    throw new Error(`Expected ${args["slide-count"]} slide modules, found ${modules.length}.`);
  }

  const presentation = Presentation.create({ slideSize });
  const slideRecords = [];

  for (const slideModule of modules) {
    const module = await importModuleFresh(slideModule.path);
    const { name: exportName, fn } = resolveSlideFunction(module, undefined, slideModule.slideNumber);
    const referenceImage = referenceDir
      ? path.join(referenceDir, `slide-${padSlideNumber(slideModule.slideNumber)}.png`)
      : undefined;
    const ctx = createSlideContext(artifact, {
      slideSize,
      slideNumber: slideModule.slideNumber,
      referenceImage,
      outputDir: path.dirname(out),
      assetDir: path.join(workspace, "assets"),
      workspaceDir: workspace,
    });

    const beforeCount = presentation.slides.count;
    const returnedSlide = await fn(presentation, ctx);
    if (presentation.slides.count !== beforeCount + 1) {
      throw new Error(
        `${path.basename(slideModule.path)} must add exactly one slide; count changed from ${beforeCount} to ${presentation.slides.count}.`,
      );
    }
    const slide = returnedSlide || presentation.slides.getItem(presentation.slides.count - 1);
    slideRecords.push({
      slideNumber: slideModule.slideNumber,
      modulePath: slideModule.path,
      exportName,
      slide,
    });
  }

  await fs.mkdir(previewDir, { recursive: true });
  const previewPaths = [];
  const layoutResults = [];
  for (let index = 0; index < slideRecords.length; index += 1) {
    const record = slideRecords[index];
    const previewPath = path.join(previewDir, `slide-${padSlideNumber(index + 1)}.png`);
    const preview = await presentation.export({ slide: record.slide, format: "png", scale });
    await saveBlobToFile(preview, previewPath);
    previewPaths.push(previewPath);

    if (layoutDir) {
      const layoutPath = path.join(layoutDir, `slide-${padSlideNumber(index + 1)}.layout.json`);
      layoutResults.push(await maybeWriteLayout(presentation, record.slide, layoutPath));
    }
  }

  await fs.mkdir(path.dirname(out), { recursive: true });
  const pptx = await PresentationFile.exportPptx(presentation);
  await pptx.save(out);
  const outputStat = await fs.stat(out);
  if (outputStat.size <= 0) {
    throw new Error(`Exported deck is empty: ${out}`);
  }

  const contactSheet = runContactSheet(previewPaths, contactSheetPath);
  const manifest = {
    output: out,
    outputBytes: outputStat.size,
    slideCount: presentation.slides.count,
    slideSize,
    previewDir,
    previewPaths,
    layoutDir,
    layoutResults,
    contactSheet,
    slides: slideRecords.map((record, index) => ({
      index: index + 1,
      requestedSlideNumber: record.slideNumber,
      modulePath: record.modulePath,
      exportName: record.exportName,
    })),
  };
  await fs.mkdir(path.dirname(manifestPath), { recursive: true });
  await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

  console.log(JSON.stringify(manifest, null, 2));
}

main().catch((error) => {
  console.error(error.stack || error.message || String(error));
  console.error(usage());
  process.exit(1);
});
