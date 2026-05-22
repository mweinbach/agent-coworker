import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

export const DEFAULT_SLIDE_SIZE = { width: 1280, height: 720 };
const MIN_ARTIFACT_TOOL_VERSION = "2.7.3";

export function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (!key.startsWith("--")) {
      throw new Error(`Unexpected positional argument: ${key}`);
    }
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) {
      args[key.slice(2)] = true;
      continue;
    }
    args[key.slice(2)] = value;
    index += 1;
  }
  return args;
}

export function requireArg(args, key) {
  const value = args[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Missing required --${key}`);
  }
  return value;
}

export function parseSlideSize(value) {
  if (!value) return DEFAULT_SLIDE_SIZE;
  const match = String(value).match(/^(\d+)x(\d+)$/);
  if (!match) {
    throw new Error(`Expected slide size as WIDTHxHEIGHT, got: ${value}`);
  }
  return {
    width: Number.parseInt(match[1], 10),
    height: Number.parseInt(match[2], 10),
  };
}

export function padSlideNumber(value) {
  return String(value).padStart(2, "0");
}

export function slideNumberFromModuleName(filePath) {
  const base = path.basename(filePath);
  const match = base.match(/^slide[-_]?(\d+)\.mjs$/i);
  if (!match) return undefined;
  return Number.parseInt(match[1], 10);
}

function defaultRuntimeNodeModules() {
  return path.join(
    process.env.HOME || process.cwd(),
    ".cache",
    "codex-runtimes",
    ["codex", "primary", "runtime"].join("-"),
    "dependencies",
    "node",
    "node_modules",
  );
}

function packageJsonPath(packageDir) {
  return path.join(packageDir, "package.json");
}

function readPackageJson(packageDir) {
  const packagePath = packageJsonPath(packageDir);
  if (!fsSync.existsSync(packagePath)) return undefined;
  try {
    return JSON.parse(fsSync.readFileSync(packagePath, "utf8"));
  } catch {
    return undefined;
  }
}

function isNamedPackage(packageDir, packageName) {
  const packageJson = readPackageJson(packageDir);
  return packageJson?.name === packageName;
}

function isSamePackageLocation(targetPackage, sourcePackage) {
  try {
    return fsSync.realpathSync(targetPackage) === fsSync.realpathSync(sourcePackage);
  } catch {
    return false;
  }
}

function isArtifactToolPackage(packageDir) {
  return isNamedPackage(packageDir, "@oai/artifact-tool");
}

function artifactToolEntrypointPath(packageDir) {
  const candidates = [
    path.join(packageDir, "dist", "node", "artifact_tool.mjs"),
    path.join(packageDir, "dist", "artifact_tool.mjs"),
  ];
  return candidates.find((candidate) => fsSync.existsSync(candidate));
}

function compareSemver(left, right) {
  const leftParts = String(left || "0.0.0").split(".").map((part) => Number.parseInt(part, 10) || 0);
  const rightParts = String(right || "0.0.0").split(".").map((part) => Number.parseInt(part, 10) || 0);
  for (let index = 0; index < Math.max(leftParts.length, rightParts.length); index += 1) {
    const delta = (leftParts[index] || 0) - (rightParts[index] || 0);
    if (delta !== 0) return delta;
  }
  return 0;
}

function artifactToolExportPath(packageDir, exportName) {
  const packageJson = readPackageJson(packageDir);
  const exportValue = packageJson?.exports?.[exportName];
  const relativePath =
    typeof exportValue === "string"
      ? exportValue
      : exportValue?.import || exportValue?.default || exportValue?.node;
  if (!relativePath) return undefined;
  const resolved = path.join(packageDir, relativePath);
  return fsSync.existsSync(resolved) ? resolved : undefined;
}

function validateArtifactToolPresentationJsx(packageDir, context) {
  const requiredExports = [
    "./presentation-jsx",
    "./presentation-jsx/jsx-runtime",
    "./presentation-jsx/jsx-dev-runtime",
  ];
  const missing = requiredExports.filter((exportName) => !artifactToolExportPath(packageDir, exportName));
  if (missing.length) {
    throw new Error(
      [
        `Expected ${context} to expose artifact-tool presentation JSX exports.`,
        `Missing exports: ${missing.join(", ")}.`,
        "Refresh the @oai/artifact-tool runtime bundle before retrying.",
      ].join("\n"),
    );
  }
}

function validateArtifactToolPackage(packageDir, context) {
  const packageJson = readPackageJson(packageDir);
  if (!isArtifactToolPackage(packageDir)) {
    const found = packageJson ? packageJson.name || "unknown package" : "missing package.json";
    throw new Error(
      [
        `Expected ${context} to point to @oai/artifact-tool.`,
        `Checked ${packageDir}; found ${found}.`,
      ].join("\n"),
    );
  }
  if (compareSemver(packageJson.version, MIN_ARTIFACT_TOOL_VERSION) < 0) {
    throw new Error(
      [
        `Expected ${context} to point to @oai/artifact-tool ${MIN_ARTIFACT_TOOL_VERSION} or newer.`,
        `Checked ${packageDir}; found @oai/artifact-tool@${packageJson.version || "unknown"}.`,
      ].join("\n"),
    );
  }
  const entrypoint = artifactToolEntrypointPath(packageDir);
  if (!entrypoint) {
    throw new Error(
      [
        `Expected ${context} to include a built artifact-tool entrypoint.`,
        `Checked ${path.join(packageDir, "dist", "node", "artifact_tool.mjs")} and ${path.join(packageDir, "dist", "artifact_tool.mjs")}.`,
        "Build the local artifact-tool bundle before retrying.",
      ].join("\n"),
    );
  }
  validateArtifactToolPresentationJsx(packageDir, context);
  return { packageDir: path.resolve(packageDir), entrypoint: path.resolve(entrypoint) };
}

function findArtifactToolPackage() {
  return validateArtifactToolPackage(
    runtimePackagePath("@oai/artifact-tool"),
    "the bundled Codex runtime @oai/artifact-tool package",
  );
}

function runtimePackagePath(packageName) {
  return path.join(defaultRuntimeNodeModules(), ...packageName.split("/"));
}

function findOptionalRuntimePackage(packageName) {
  const runtimePackage = runtimePackagePath(packageName);
  if (isNamedPackage(runtimePackage, packageName)) {
    return runtimePackage;
  }
  return undefined;
}

function workspacePackagePath(workspaceDir, packageName) {
  return path.join(workspaceDir, "node_modules", ...packageName.split("/"));
}

async function ensureWorkspacePackage(workspaceDir, packageName, sourcePackage) {
  const target = workspacePackagePath(workspaceDir, packageName);
  await fs.mkdir(path.dirname(target), { recursive: true });

  const existing = await fs.lstat(target).catch(() => undefined);
  if (existing) {
    if (
      fsSync.existsSync(packageJsonPath(target)) &&
      isNamedPackage(target, packageName) &&
      isSamePackageLocation(target, sourcePackage)
    ) {
      return target;
    }
    if (existing.isSymbolicLink()) {
      await fs.rm(target, { recursive: true, force: true });
    } else {
      throw new Error(`${target} exists but is not ${packageName}.`);
    }
  }

  await fs.symlink(sourcePackage, target, process.platform === "win32" ? "junction" : "dir");
  return target;
}

async function ensureModulePackage(workspaceDir) {
  const packagePath = path.join(workspaceDir, "package.json");
  if (!fsSync.existsSync(packagePath)) {
    await fs.writeFile(
      packagePath,
      `${JSON.stringify({ private: true, type: "module" }, null, 2)}\n`,
      "utf8",
    );
    return;
  }

  const packageJson = JSON.parse(await fs.readFile(packagePath, "utf8"));
  if (packageJson.type !== "module") {
    throw new Error(`${packagePath} exists but does not set "type": "module".`);
  }
}

export async function ensureArtifactToolWorkspace(workspaceDir) {
  const resolvedWorkspace = path.resolve(workspaceDir);
  await fs.mkdir(resolvedWorkspace, { recursive: true });
  await ensureModulePackage(resolvedWorkspace);

  const { packageDir: sourcePackage } = findArtifactToolPackage();
  await ensureWorkspacePackage(resolvedWorkspace, "@oai/artifact-tool", sourcePackage);

  const lucidePackage = findOptionalRuntimePackage("lucide");
  if (lucidePackage) {
    await ensureWorkspacePackage(resolvedWorkspace, "lucide", lucidePackage);
  }

  return { workspaceDir: resolvedWorkspace, packageDir: sourcePackage };
}

export async function importArtifactTool(workspaceDir) {
  const { entrypoint } = findArtifactToolPackage();
  return import(pathToFileURL(entrypoint).href);
}

export async function importModuleFresh(modulePath) {
  const resolved = path.resolve(modulePath);
  const stat = await fs.stat(resolved);
  return import(`${pathToFileURL(resolved).href}?mtime=${stat.mtimeMs}`);
}

export function resolveSlideFunction(module, exportName, slideNumber) {
  const candidates = [];
  if (exportName) candidates.push(exportName);
  if (slideNumber !== undefined) {
    candidates.push(`slide${padSlideNumber(slideNumber)}`, `slide${slideNumber}`);
  }
  candidates.push("addSlide", "default");

  for (const candidate of candidates) {
    if (typeof module[candidate] === "function") {
      return { name: candidate, fn: module[candidate] };
    }
  }

  throw new Error(`Could not find slide function. Tried: ${candidates.join(", ")}`);
}

export async function readImageBlob(imagePath) {
  const bytes = await fs.readFile(imagePath);
  if (!bytes.byteLength) {
    throw new Error(`Image file is empty: ${imagePath}`);
  }
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
}

export async function saveBlobToFile(blob, outputPath) {
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  if (blob && typeof blob.arrayBuffer === "function") {
    await fs.writeFile(outputPath, Buffer.from(await blob.arrayBuffer()));
    return;
  }
  if (blob instanceof Uint8Array || Buffer.isBuffer(blob)) {
    await fs.writeFile(outputPath, Buffer.from(blob));
    return;
  }
  throw new Error("Expected a Blob or Uint8Array.");
}

function escapeXmlAttribute(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function iconNameCandidates(name) {
  const raw = String(name || "").trim();
  const pascal = raw
    .split(/[^a-zA-Z0-9]+/)
    .filter(Boolean)
    .map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`)
    .join("");
  return [...new Set([raw, raw.replace(/Icon$/, ""), pascal, pascal.replace(/Icon$/, "")].filter(Boolean))];
}

async function loadLucide(workspaceDir) {
  const resolverPath = path.join(path.resolve(workspaceDir), "__lucide_resolver__.mjs");
  const requireFromWorkspace = createRequire(resolverPath);
  const entrypoint = requireFromWorkspace.resolve("lucide");
  return import(pathToFileURL(entrypoint).href);
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

async function lucideSvgDataUrl(workspaceDir, name, options = {}) {
  const lucide = await loadLucide(workspaceDir);
  const iconName = iconNameCandidates(name).find((candidate) => lucide.icons?.[candidate] || lucide[candidate]);
  const iconNode = iconName ? lucide.icons?.[iconName] || lucide[iconName] : undefined;
  if (!iconNode) {
    throw new Error(`Lucide icon not found: ${name}`);
  }

  const {
    color = "#111827",
    strokeWidth = 2,
    width = 24,
    height = 24,
    className,
  } = options;
  const classAttr = className ? ` class="${escapeXmlAttribute(className)}"` : "";
  const svg = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${escapeXmlAttribute(width)}" height="${escapeXmlAttribute(height)}" viewBox="0 0 24 24" fill="none" stroke="${escapeXmlAttribute(color)}" stroke-width="${escapeXmlAttribute(strokeWidth)}" stroke-linecap="round" stroke-linejoin="round"${classAttr}>`,
    iconNode.map(renderLucideNode).join(""),
    "</svg>",
  ].join("");
  return `data:image/svg+xml;base64,${Buffer.from(svg, "utf8").toString("base64")}`;
}

function normalizeFrame(options) {
  const left = options.left ?? options.x ?? 0;
  const top = options.top ?? options.y ?? 0;
  const width = options.width ?? options.w;
  const height = options.height ?? options.h;
  if (!Number.isFinite(width) || !Number.isFinite(height)) {
    throw new Error("Frame requires width and height.");
  }
  return { left, top, width, height };
}

export function createSlideContext(artifact, options = {}) {
  const slideSize = options.slideSize ?? DEFAULT_SLIDE_SIZE;
  const transparent = "#00000000";

  const ctx = {
    W: slideSize.width,
    H: slideSize.height,
    slideSize,
    slideNumber: options.slideNumber,
    referenceImage: options.referenceImage,
    outputDir: options.outputDir,
    assetDir: options.assetDir,
    workspaceDir: options.workspaceDir,
    fonts: {
      title: options.titleFont ?? "Aptos Display",
      body: options.bodyFont ?? "Aptos",
      mono: options.monoFont ?? "Aptos Mono",
    },
    artifact,
    readImageBlob,
    line(fill = transparent, width = 0, style = "solid") {
      return { style, fill, width };
    },
    addShape(slide, optionsForShape) {
      const {
        geometry = "rect",
        fill = transparent,
        line = { style: "solid", fill: transparent, width: 0 },
        name,
        ...frameOptions
      } = optionsForShape;
      const shape = slide.shapes.add({
        geometry,
        name,
        position: normalizeFrame(frameOptions),
        fill,
        line,
      });
      return shape;
    },
    addText(slide, optionsForText) {
      const {
        text = "",
        size,
        fontSize = size ?? 24,
        color = "#111827",
        bold = false,
        face,
        typeface = face ?? ctx.fonts.body,
        align = "left",
        valign = "top",
        fill = transparent,
        line = { style: "solid", fill: transparent, width: 0 },
        insets = { left: 0, right: 0, top: 0, bottom: 0 },
        name,
        ...frameOptions
      } = optionsForText;
      const shape = ctx.addShape(slide, {
        ...frameOptions,
        name,
        geometry: "rect",
        fill,
        line,
      });
      shape.text = text;
      shape.text.fontSize = fontSize;
      shape.text.color = color;
      shape.text.bold = Boolean(bold);
      shape.text.typeface = typeface;
      shape.text.alignment = align;
      shape.text.verticalAlignment = valign;
      shape.text.insets = insets;
      return shape;
    },
    async addImage(slide, optionsForImage) {
      const {
        path: imagePath,
        blob,
        dataUrl,
        uri,
        fit = "cover",
        alt = "",
        name,
        ...frameOptions
      } = optionsForImage;
      const source = blob
        ? { blob }
        : dataUrl
          ? { dataUrl }
          : uri
            ? { uri }
            : { blob: await readImageBlob(imagePath) };
      const image = slide.images.add({ ...source, fit, alt, name });
      image.position = normalizeFrame(frameOptions);
      return image;
    },
    async addLucideIcon(slide, optionsForIcon) {
      const {
        name,
        icon = name,
        color = "#111827",
        strokeWidth = 2,
        alt,
        fit = "contain",
        ...frameOptions
      } = optionsForIcon;
      if (!ctx.workspaceDir) {
        throw new Error("ctx.addLucideIcon requires ctx.workspaceDir.");
      }
      return ctx.addImage(slide, {
        ...frameOptions,
        dataUrl: await lucideSvgDataUrl(ctx.workspaceDir, icon, { color, strokeWidth }),
        fit,
        alt: alt ?? `${icon} icon`,
        name: frameOptions.name,
      });
    },
  };

  return ctx;
}
