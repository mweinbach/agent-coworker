import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

import type { SkillInstallationDiagnostic, SkillInterfaceMeta } from "../types";
import { isPathInside } from "../utils/paths";

const skillNameSchema = z.string().trim().min(1).max(64);
const kebabSkillNameSchema = skillNameSchema.regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
const skillDescriptionSchema = z.string().trim().min(1).max(1024);
const nonEmptyTrimmedStringSchema = z.string().trim().min(1);
const unknownRecordSchema = z.record(z.string(), z.unknown());
const triggerValueSchema = z.union([z.string(), z.array(z.unknown())]);

const baseSkillFrontMatterSchema = z
  .object({ name: skillNameSchema, description: skillDescriptionSchema })
  .passthrough();

const baseKebabSkillFrontMatterSchema = baseSkillFrontMatterSchema
  .extend({ name: kebabSkillNameSchema })
  .passthrough();

const catalogSkillFrontMatterSchema = baseKebabSkillFrontMatterSchema
  .extend({
    license: nonEmptyTrimmedStringSchema.optional(),
    compatibility: z.string().trim().min(1).max(500).optional(),
    metadata: z.record(z.string(), z.string()).optional(),
    "allowed-tools": nonEmptyTrimmedStringSchema.optional(),
  })
  .passthrough();

type SkillFrontMatter = {
  name: string;
  description: string;
  license?: string;
  compatibility?: string;
  metadata?: Record<string, string>;
  allowedTools?: string;
};

export type ParsedSkillDocument = {
  frontMatter: SkillFrontMatter;
  rawFrontMatter: Record<string, unknown>;
  body: string;
};

type SkillDocumentParserMode = "basic" | "catalog";

export type ParseSkillDocumentOptions = {
  expectedName?: string;
  requireKebabName?: boolean;
  mode?: SkillDocumentParserMode;
};

export function buildDiagnostic(
  code: string,
  severity: SkillInstallationDiagnostic["severity"],
  message: string,
): SkillInstallationDiagnostic {
  return { code, severity, message };
}

function mimeTypeForIconPath(targetPath: string): string {
  switch (path.extname(targetPath).toLowerCase()) {
    case ".svg":
      return "image/svg+xml";
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".webp":
      return "image/webp";
    default:
      return "application/octet-stream";
  }
}

export async function readSkillIconAsDataUri(
  skillRoot: string,
  relativePath: string,
  maxBytes?: number,
): Promise<string | null> {
  const resolvedPath = path.resolve(skillRoot, relativePath);
  if (!isPathInside(skillRoot, resolvedPath)) return null;
  try {
    // Resolve through symlinks before reading so icon paths cannot escape the skill root.
    const [canonicalSkillRoot, canonicalTarget] = await Promise.all([
      fs.realpath(skillRoot),
      fs.realpath(resolvedPath),
    ]);
    if (!isPathInside(canonicalSkillRoot, canonicalTarget)) return null;
    const stat = await fs.stat(canonicalTarget);
    if (!stat.isFile() || (maxBytes !== undefined && stat.size > maxBytes)) return null;
    const buf = await fs.readFile(canonicalTarget);
    return `data:${mimeTypeForIconPath(canonicalTarget)};base64,${buf.toString("base64")}`;
  } catch {
    return null;
  }
}

export function parseSkillDocument(
  raw: string,
  opts: ParseSkillDocumentOptions = {},
): ParsedSkillDocument | null {
  const match = raw.match(/^\ufeff?---\s*\r?\n([\s\S]*?)\r?\n---\s*(?:\r?\n|$)/);
  if (!match?.[1]) return null;

  let parsed: Record<string, unknown>;
  try {
    const validatedYaml = unknownRecordSchema.safeParse(Bun.YAML.parse(match[1]));
    if (!validatedYaml.success) return null;
    parsed = validatedYaml.data;
  } catch {
    return null;
  }

  const schema =
    opts.mode === "catalog"
      ? catalogSkillFrontMatterSchema
      : opts.requireKebabName === false
        ? baseSkillFrontMatterSchema
        : baseKebabSkillFrontMatterSchema;
  const validated = schema.safeParse(parsed);
  if (!validated.success) return null;

  const data = validated.data;
  if (opts.expectedName !== undefined && data.name !== opts.expectedName) return null;

  const catalogData =
    opts.mode === "catalog" ? (data as z.infer<typeof catalogSkillFrontMatterSchema>) : undefined;
  return {
    frontMatter: {
      name: data.name,
      description: data.description,
      ...(catalogData?.license ? { license: catalogData.license } : {}),
      ...(catalogData?.compatibility ? { compatibility: catalogData.compatibility } : {}),
      ...(catalogData?.metadata ? { metadata: catalogData.metadata } : {}),
      ...(catalogData?.["allowed-tools"] ? { allowedTools: catalogData["allowed-tools"] } : {}),
    },
    rawFrontMatter: parsed,
    body: raw.slice(match[0].length),
  };
}

export async function readSkillDocument(
  skillPath: string,
  opts: ParseSkillDocumentOptions = {},
): Promise<ParsedSkillDocument | null> {
  return parseSkillDocument(await fs.readFile(skillPath, "utf-8"), opts);
}

function stripQuotes(value: string): string {
  const trimmed = value.trim();
  return (trimmed.startsWith('"') && trimmed.endsWith('"') && trimmed.length >= 2) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'") && trimmed.length >= 2)
    ? trimmed.slice(1, -1)
    : trimmed;
}

function parseAgentInterfaceYaml(raw: string): SkillInterfaceMeta {
  let inInterface = false;
  const out: SkillInterfaceMeta = {};

  for (const line of raw.split(/\r?\n/)) {
    if (!inInterface) {
      if (/^interface:\s*$/.test(line.trim())) inInterface = true;
      continue;
    }
    if (line.trim() === "") continue;
    if (!/^\s/.test(line)) break;
    const match = line.match(/^\s+([A-Za-z0-9_]+)\s*:\s*(.+)\s*$/);
    if (!match) continue;
    const value = stripQuotes(match[2] ?? "");
    if (match[1] === "display_name") out.displayName = value;
    else if (match[1] === "short_description") out.shortDescription = value;
    else if (match[1] === "default_prompt") out.defaultPrompt = value;
  }

  return out;
}

export async function readAgentInterface(
  skillRoot: string,
  opts?:
    | ((skillRoot: string, relativePath: string) => Promise<string | null>)
    | { maxIconBytes?: number },
): Promise<SkillInterfaceMeta | undefined> {
  const readIcon =
    typeof opts === "function"
      ? opts
      : (root: string, rel: string) => readSkillIconAsDataUri(root, rel, opts?.maxIconBytes);
  const agentsDir = path.join(skillRoot, "agents");
  let entries: Array<{ name: string; isFile: () => boolean }>;
  try {
    entries = await fs.readdir(agentsDir, { withFileTypes: true, encoding: "utf8" });
  } catch {
    return undefined;
  }
  const agentFiles = entries
    .filter((entry) => entry.isFile() && /\.(ya?ml)$/i.test(entry.name))
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right));
  const primary = agentFiles.find((file) => file.toLowerCase() === "openai.yaml") ?? agentFiles[0];
  if (!primary) return undefined;
  const agents = agentFiles.map((file) => file.replace(/\.(ya?ml)$/i, ""));
  let raw: string;
  try {
    raw = await fs.readFile(path.join(agentsDir, primary), "utf-8");
  } catch {
    return { agents };
  }

  const out: SkillInterfaceMeta = { ...parseAgentInterfaceYaml(raw), agents };
  for (const [pattern, field] of [
    [/^\s+icon_small:\s*(.+)\s*$/m, "iconSmall"],
    [/^\s+icon_large:\s*(.+)\s*$/m, "iconLarge"],
  ] as const) {
    const rel = stripQuotes(raw.match(pattern)?.[1] ?? "");
    const dataUri = rel ? await readIcon(skillRoot, rel) : null;
    if (dataUri) out[field] = dataUri;
  }

  return out;
}

function parseTriggerValue(value: unknown): string[] {
  const parsed = triggerValueSchema.safeParse(value);
  if (!parsed.success) return [];

  const items =
    typeof parsed.data === "string"
      ? parsed.data.split(",")
      : parsed.data.filter(
          (entry): entry is string => nonEmptyTrimmedStringSchema.safeParse(entry).success,
        );
  return items.map((entry) => entry.trim()).filter(Boolean);
}

export function extractSkillTriggers(
  name: string,
  frontMatter?: Record<string, unknown>,
  opts: { defaults?: Record<string, string[]> } = {},
): string[] {
  if (frontMatter) {
    const direct = parseTriggerValue(frontMatter.triggers);
    if (direct.length > 0) return direct;

    const metadata = unknownRecordSchema.safeParse(frontMatter.metadata);
    if (metadata.success) {
      const metadataTriggers = parseTriggerValue(metadata.data.triggers);
      if (metadataTriggers.length > 0) return metadataTriggers;
    }
  }

  return opts.defaults?.[name] ?? [name];
}
