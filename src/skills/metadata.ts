import fs from "node:fs/promises";
import { z } from "zod";

const skillNameSchema = z.string().trim().min(1).max(64);
const kebabSkillNameSchema = skillNameSchema.regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
const skillDescriptionSchema = z.string().trim().min(1).max(1024);
const nonEmptyTrimmedStringSchema = z.string().trim().min(1);
const unknownRecordSchema = z.record(z.string(), z.unknown());
const stringMetadataSchema = z.record(z.string(), z.string());
const triggerValueSchema = z.union([z.string(), z.array(z.unknown())]);

const baseSkillFrontMatterSchema = z
  .object({
    name: skillNameSchema,
    description: skillDescriptionSchema,
  })
  .passthrough();

const baseKebabSkillFrontMatterSchema = z
  .object({
    name: kebabSkillNameSchema,
    description: skillDescriptionSchema,
  })
  .passthrough();

const catalogSkillFrontMatterSchema = z
  .object({
    name: kebabSkillNameSchema,
    description: skillDescriptionSchema,
    license: nonEmptyTrimmedStringSchema.optional(),
    compatibility: z.string().trim().min(1).max(500).optional(),
    metadata: stringMetadataSchema.optional(),
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

function splitSkillDocument(raw: string): { frontMatterRaw: string | null; body: string } {
  const match = raw.match(/^\ufeff?---\s*\r?\n([\s\S]*?)\r?\n---\s*(?:\r?\n|$)/);
  if (!match) {
    return { frontMatterRaw: null, body: raw };
  }
  return {
    frontMatterRaw: match[1] ?? "",
    body: raw.slice(match[0].length),
  };
}

function parseYamlFrontMatter(frontMatterRaw: string): Record<string, unknown> | null {
  try {
    const parsed = Bun.YAML.parse(frontMatterRaw);
    const validated = unknownRecordSchema.safeParse(parsed);
    return validated.success ? validated.data : null;
  } catch {
    return null;
  }
}

export function parseSkillDocument(
  raw: string,
  opts: ParseSkillDocumentOptions = {},
): ParsedSkillDocument | null {
  const { frontMatterRaw, body } = splitSkillDocument(raw);
  if (!frontMatterRaw) {
    return null;
  }

  const parsed = parseYamlFrontMatter(frontMatterRaw);
  if (!parsed) {
    return null;
  }

  const schema =
    opts.mode === "catalog"
      ? catalogSkillFrontMatterSchema
      : opts.requireKebabName === false
        ? baseSkillFrontMatterSchema
        : baseKebabSkillFrontMatterSchema;
  const validated = schema.safeParse(parsed);
  if (!validated.success) {
    return null;
  }

  const data = validated.data;
  if (opts.expectedName !== undefined && data.name !== opts.expectedName) {
    return null;
  }

  const frontMatter: SkillFrontMatter = {
    name: data.name,
    description: data.description,
  };

  if (opts.mode === "catalog") {
    const catalogData = data as z.infer<typeof catalogSkillFrontMatterSchema>;
    if (catalogData.license) {
      frontMatter.license = catalogData.license;
    }
    if (catalogData.compatibility) {
      frontMatter.compatibility = catalogData.compatibility;
    }
    if (catalogData.metadata) {
      frontMatter.metadata = catalogData.metadata;
    }
    if (catalogData["allowed-tools"]) {
      frontMatter.allowedTools = catalogData["allowed-tools"];
    }
  }

  return {
    frontMatter,
    rawFrontMatter: parsed,
    body,
  };
}

export async function readSkillDocument(
  skillPath: string,
  opts: ParseSkillDocumentOptions = {},
): Promise<ParsedSkillDocument | null> {
  return parseSkillDocument(await fs.readFile(skillPath, "utf-8"), opts);
}

function parseTriggerValue(value: unknown): string[] {
  const parsed = triggerValueSchema.safeParse(value);
  if (!parsed.success) {
    return [];
  }

  if (typeof parsed.data === "string") {
    return parsed.data
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean);
  }

  return parsed.data
    .filter((entry): entry is string => nonEmptyTrimmedStringSchema.safeParse(entry).success)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

export function extractSkillTriggers(
  name: string,
  frontMatter?: Record<string, unknown>,
  opts: { defaults?: Record<string, string[]> } = {},
): string[] {
  if (frontMatter) {
    const direct = parseTriggerValue(frontMatter.triggers);
    if (direct.length > 0) {
      return direct;
    }

    const metadata = unknownRecordSchema.safeParse(frontMatter.metadata);
    if (metadata.success) {
      const metadataTriggers = parseTriggerValue(metadata.data.triggers);
      if (metadataTriggers.length > 0) {
        return metadataTriggers;
      }
    }
  }

  return opts.defaults?.[name] ?? [name];
}
