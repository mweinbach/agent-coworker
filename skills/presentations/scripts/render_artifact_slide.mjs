#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";

import {
  createSlideContext,
  ensureArtifactToolWorkspace,
  importArtifactTool,
  importModuleFresh,
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
    "  node scripts/render_artifact_slide.mjs --slide-module <slide-XX.mjs> --output <preview.png> [options]",
    "",
    "Options:",
    "  --export <name>             Exported function name. Defaults to slideXX/addSlide/default detection.",
    "  --workspace <dir>           Builder workspace. Defaults to the slide module directory.",
    "  --reference-image <path>    Reference PNG path for ctx.referenceImage.",
    "  --layout <path>             Optional layout JSON output path.",
    "  --pptx <path>               Optional one-slide PPTX output path for debugging.",
    "  --slide-size <WxH>          Slide size in pixels. Defaults to 1280x720.",
    "  --scale <number>            Render scale. Defaults to 1.",
  ].join("\n");
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(usage());
    return;
  }

  const slideModule = path.resolve(requireArg(args, "slide-module"));
  const output = path.resolve(requireArg(args, "output"));
  const workspace = path.resolve(args.workspace || path.dirname(slideModule));
  const slideSize = parseSlideSize(args["slide-size"]);
  const scale = args.scale ? Number.parseFloat(args.scale) : 1;
  const slideNumber = slideNumberFromModuleName(slideModule);

  await ensureArtifactToolWorkspace(workspace);
  const artifact = await importArtifactTool(workspace);
  const { Presentation, PresentationFile } = artifact;
  const presentation = Presentation.create({ slideSize });

  const module = await importModuleFresh(slideModule);
  const { name: exportName, fn } = resolveSlideFunction(module, args.export, slideNumber);
  const ctx = createSlideContext(artifact, {
    slideSize,
    slideNumber,
    referenceImage: args["reference-image"] ? path.resolve(args["reference-image"]) : undefined,
    outputDir: path.dirname(output),
    assetDir: path.join(workspace, "assets"),
    workspaceDir: workspace,
  });

  const beforeCount = presentation.slides.count;
  const returnedSlide = await fn(presentation, ctx);
  if (presentation.slides.count !== beforeCount + 1) {
    throw new Error(
      `${exportName} must add exactly one slide; count changed from ${beforeCount} to ${presentation.slides.count}.`,
    );
  }
  const slide = returnedSlide || presentation.slides.getItem(presentation.slides.count - 1);

  const preview = await presentation.export({ slide, format: "png", scale });
  await saveBlobToFile(preview, output);

  const result = { slideModule, exportName, output };

  if (args.layout) {
    try {
      const layoutBlob = await presentation.export({ slide, format: "layout" });
      await fs.mkdir(path.dirname(path.resolve(args.layout)), { recursive: true });
      await fs.writeFile(path.resolve(args.layout), await layoutBlob.text(), "utf8");
      result.layout = path.resolve(args.layout);
    } catch (error) {
      result.layoutError = error.message || String(error);
    }
  }

  if (args.pptx) {
    const pptxPath = path.resolve(args.pptx);
    const pptx = await PresentationFile.exportPptx(presentation);
    await fs.mkdir(path.dirname(pptxPath), { recursive: true });
    await pptx.save(pptxPath);
    result.pptx = pptxPath;
  }

  console.log(JSON.stringify(result, null, 2));
}

main().catch((error) => {
  console.error(error.stack || error.message || String(error));
  console.error(usage());
  process.exit(1);
});
