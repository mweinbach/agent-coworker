#!/usr/bin/env node

import { mkdir, writeFile } from "node:fs/promises";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";

function defaultRuntimeNodeModules() {
  return path.join(
    os.homedir(),
    ".cache",
    "codex-runtimes",
    "codex-primary-runtime",
    "dependencies",
    "node",
    "node_modules",
  );
}

function runtimePackagePath(packageName) {
  return path.join(defaultRuntimeNodeModules(), ...packageName.split("/"));
}

const explicitRequireRoots = (process.env.PPTX_COMEBACK_REQUIRE_ROOTS || "")
  .split(path.delimiter)
  .map((root) => root.trim())
  .filter(Boolean)
  .map((root) => path.join(path.resolve(root), "package.json"));

const artifactToolPackageJson = path.join(runtimePackagePath("@oai/artifact-tool"), "package.json");
const requireCandidateBases = [
  import.meta.url,
  path.join(process.cwd(), "package.json"),
  path.join(defaultRuntimeNodeModules(), "__codex_runtime_require__.mjs"),
  ...(fs.existsSync(artifactToolPackageJson) ? [artifactToolPackageJson] : []),
  ...explicitRequireRoots,
];

const requireCandidates = requireCandidateBases.map((base) => createRequire(base));

function requireAvailable(moduleName) {
  for (const requireFn of requireCandidates) {
    try {
      return requireFn(moduleName);
    } catch {
      // Try the next package root.
    }
  }
  throw new Error(`Cannot resolve required module '${moduleName}' from the bundled Codex runtime`);
}

function parseArgs(argv) {
  const args = {
    color: "#111111",
    format: "",
    output: "",
    size: 128,
    strokeWidth: 1.8,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    const value = argv[i + 1];

    if (key === "--help") args.help = true;
    else if (key === "--list") args.list = true;
    else if (key === "--icon") {
      args.icon = value;
      i += 1;
    } else if (key === "--color") {
      args.color = value;
      i += 1;
    } else if (key === "--format") {
      args.format = value;
      i += 1;
    } else if (key === "--output") {
      args.output = value;
      i += 1;
    } else if (key === "--size") {
      args.size = Number(value);
      i += 1;
    } else if (key === "--stroke-width") {
      args.strokeWidth = Number(value);
      i += 1;
    } else {
      throw new Error(`Unknown argument '${key}'`);
    }
  }

  if (!args.format && args.output) {
    args.format = path.extname(args.output).toLowerCase() === ".svg" ? "svg" : "png";
  }
  if (!args.format) args.format = "png";

  return args;
}

function usage() {
  return [
    "Usage:",
    "  render_lucide_icon.mjs --icon Smartphone --output /path/icon.png [--color '#111111'] [--size 128] [--stroke-width 1.8]",
    "  render_lucide_icon.mjs --icon Smartphone --format svg --output /path/icon.svg",
    "  render_lucide_icon.mjs --list",
  ].join("\n");
}

function normalizeIconName(name) {
  return String(name || "")
    .trim()
    .replace(/(^|[-_\\s]+)([a-zA-Z0-9])/g, (_, __, char) => char.toUpperCase());
}

function iconMap(Lucide) {
  return Lucide.icons || Lucide;
}

function iconEntries(Lucide) {
  return Object.keys(iconMap(Lucide))
    .filter((name) => /^[A-Z]/.test(name))
    .filter((name) => !name.endsWith("Icon"))
    .sort();
}

function resolveIcon(Lucide, requestedName) {
  const icons = iconMap(Lucide);
  const normalized = normalizeIconName(requestedName);
  const candidates = [requestedName, normalized, normalized.replace(/Icon$/, ""), `${normalized}Icon`].filter(Boolean);

  for (const name of candidates) {
    if (icons[name]) return { name, node: icons[name] };
  }

  const lowered = String(requestedName || "").toLowerCase();
  const fuzzy = iconEntries(Lucide).find((name) => name.toLowerCase() === lowered);
  if (fuzzy) return { name: fuzzy, node: icons[fuzzy] };

  throw new Error(`Unknown Lucide icon '${requestedName}'`);
}

function escapeXmlAttribute(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function renderLucideNode(node) {
  const [tag, attrs = {}, children = []] = node;
  const renderedAttrs = Object.entries(attrs)
    .map(([key, value]) => `${key}="${escapeXmlAttribute(value)}"`)
    .join(" ");
  const openTag = renderedAttrs ? `<${tag} ${renderedAttrs}` : `<${tag}`;
  if (!children.length) {
    return `${openTag}/>`;
  }
  return `${openTag}>${children.map(renderLucideNode).join("")}</${tag}>`;
}

function renderSvgMarkup(iconNode, args) {
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${escapeXmlAttribute(args.size)}" height="${escapeXmlAttribute(args.size)}" viewBox="0 0 24 24" fill="none" stroke="${escapeXmlAttribute(args.color)}" stroke-width="${escapeXmlAttribute(args.strokeWidth)}" stroke-linecap="round" stroke-linejoin="round">`,
    iconNode.map(renderLucideNode).join(""),
    "</svg>",
  ].join("");
}

async function renderSvg(svg, output) {
  await mkdir(path.dirname(output), { recursive: true });
  await writeFile(output, `${svg}\n`, "utf8");
  console.log(output);
}

async function renderPng(svg, output) {
  await mkdir(path.dirname(output), { recursive: true });
  try {
    const sharp = requireAvailable("sharp");
    await sharp(Buffer.from(svg, "utf8")).png().toFile(output);
  } catch (sharpError) {
    const { Canvas, loadImage } = requireAvailable("skia-canvas");
    const image = await loadImage(Buffer.from(svg, "utf8"));
    const canvas = new Canvas(image.width, image.height);
    const ctx = canvas.getContext("2d");
    ctx.clearRect(0, 0, image.width, image.height);
    ctx.drawImage(image, 0, 0, image.width, image.height);
    await writeFile(output, await canvas.toBuffer("png"));
    if (process.env.PPTX_COMEBACK_DEBUG) {
      console.warn(`sharp unavailable, used skia-canvas fallback: ${sharpError.message || sharpError}`);
    }
  }
  console.log(output);
}

const args = parseArgs(process.argv.slice(2));

if (args.help) {
  console.log(usage());
  process.exit(0);
}

const Lucide = requireAvailable("lucide");

if (args.list) {
  console.log(iconEntries(Lucide).join("\n"));
  process.exit(0);
}

if (!args.icon || !args.output) {
  throw new Error(usage());
}
if (!Number.isFinite(args.size) || args.size <= 0) {
  throw new Error("--size must be a positive number");
}
if (!Number.isFinite(args.strokeWidth) || args.strokeWidth <= 0) {
  throw new Error("--stroke-width must be a positive number");
}
if (!["png", "svg"].includes(args.format)) {
  throw new Error("--format must be 'png' or 'svg'");
}

const { node } = resolveIcon(Lucide, args.icon);
const svg = renderSvgMarkup(node, args);

if (args.format === "svg") {
  await renderSvg(svg, args.output);
} else {
  await renderPng(svg, args.output);
}
