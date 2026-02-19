import fs from "node:fs/promises";
import path from "node:path";

import type { SkillEntry } from "../types";

type SkillFrontMatter = {
  name: string;
  description: string;
  license?: string;
  compatibility?: string;
  metadata?: Record<string, string>;
  allowedTools?: string;
};

type ParsedSkillDocument = {
  frontMatter: SkillFrontMatter;
  rawFrontMatter: Record<string, unknown>;
  body: string;
};

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stripQuotes(v: string): string {
  const trimmed = v.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"') && trimmed.length >= 2) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'") && trimmed.length >= 2)
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function splitFrontMatter(raw: string): { frontMatterRaw: string | null; body: string } {
  // Tolerate an optional UTF-8 BOM at the start of the file.
  const re = /^\ufeff?---\s*\r?\n([\s\S]*?)\r?\n---\s*(?:\r?\n|$)/;
  const m = raw.match(re);
  if (!m) return { frontMatterRaw: null, body: raw };
  return { frontMatterRaw: m[1] ?? "", body: raw.slice(m[0].length) };
}

function parseYamlFrontMatter(frontMatterRaw: string): Record<string, unknown> | null {
  try {
    const parsed = Bun.YAML.parse(frontMatterRaw);
    if (!isPlainRecord(parsed)) return null;
    return parsed;
  } catch {
    return null;
  }
}

function parseMetadataMap(value: unknown): Record<string, string> | null {
  if (!isPlainRecord(value)) return null;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(value)) {
    if (typeof v !== "string") return null;
    out[k] = v;
  }
  return out;
}

function parseSkillFrontMatter(raw: string, skillDirName: string): ParsedSkillDocument | null {
  const { frontMatterRaw, body } = splitFrontMatter(raw);
  if (!frontMatterRaw) return null;

  const parsed = parseYamlFrontMatter(frontMatterRaw);
  if (!parsed) return null;

  const nameRaw = parsed.name;
  const descriptionRaw = parsed.description;

  if (typeof nameRaw !== "string" || typeof descriptionRaw !== "string") {
    return null;
  }

  const name = nameRaw.trim();
  const description = descriptionRaw.trim();

  // Agent Skills spec constraints.
  if (!name || name.length > 64) return null;
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) return null;
  if (name !== skillDirName) return null;

  if (!description || description.length > 1024) return null;

  let license: string | undefined;
  if (parsed.license !== undefined) {
    if (typeof parsed.license !== "string") return null;
    const value = parsed.license.trim();
    if (!value) return null;
    license = value;
  }

  let compatibility: string | undefined;
  if (parsed.compatibility !== undefined) {
    if (typeof parsed.compatibility !== "string") return null;
    const value = parsed.compatibility.trim();
    if (!value || value.length > 500) return null;
    compatibility = value;
  }

  let metadata: Record<string, string> | undefined;
  if (parsed.metadata !== undefined) {
    const m = parseMetadataMap(parsed.metadata);
    if (!m) return null;
    metadata = m;
  }

  let allowedTools: string | undefined;
  const allowedToolsRaw = parsed["allowed-tools"];
  if (allowedToolsRaw !== undefined) {
    if (typeof allowedToolsRaw !== "string") return null;
    const value = allowedToolsRaw.trim();
    if (!value) return null;
    allowedTools = value;
  }

  return {
    frontMatter: {
      name,
      description,
      ...(license ? { license } : {}),
      ...(compatibility ? { compatibility } : {}),
      ...(metadata ? { metadata } : {}),
      ...(allowedTools ? { allowedTools } : {}),
    },
    rawFrontMatter: parsed,
    body,
  };
}

function parseTriggerValue(value: unknown): string[] {
  if (typeof value === "string") {
    return value
      .split(",")
      .map((v) => v.trim())
      .filter(Boolean);
  }
  if (Array.isArray(value)) {
    return value
      .filter((v): v is string => typeof v === "string")
      .map((v) => v.trim())
      .filter(Boolean);
  }
  return [];
}

function mimeTypeForPath(p: string): string {
  const ext = path.extname(p).toLowerCase();
  switch (ext) {
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

async function readFileAsDataUri(p: string): Promise<string | null> {
  try {
    const buf = await fs.readFile(p);
    const mime = mimeTypeForPath(p);
    return `data:${mime};base64,${Buffer.from(buf).toString("base64")}`;
  } catch {
    return null;
  }
}

function parseAgentInterfaceYaml(raw: string): SkillEntry["interface"] | null {
  // This is intentionally a tiny parser for our controlled format:
  //
  // interface:
  //   display_name: "..."
  //   short_description: "..."
  //   icon_small: "./assets/foo.svg"
  //   icon_large: "./assets/foo.png"
  //   default_prompt: "..."
  const lines = raw.split(/\r?\n/);
  let inInterface = false;
  const out: NonNullable<SkillEntry["interface"]> = {};

  for (const line of lines) {
    if (!inInterface) {
      if (/^interface:\s*$/.test(line.trim())) {
        inInterface = true;
      }
      continue;
    }

    if (line.trim() === "") continue;
    if (!/^\s/.test(line)) break; // end of interface block or new top-level block

    const m = line.match(/^\s+([A-Za-z0-9_]+)\s*:\s*(.+)\s*$/);
    if (!m) continue;
    const k = m[1] ?? "";
    const v = stripQuotes(m[2] ?? "");

    switch (k) {
      case "display_name":
        out.displayName = v;
        break;
      case "short_description":
        out.shortDescription = v;
        break;
      case "default_prompt":
        out.defaultPrompt = v;
        break;
      // icon paths handled by caller (need skill root to resolve)
      default:
        break;
    }
  }

  return Object.keys(out).length > 0 ? out : null;
}

async function readAgentInterface(skillRoot: string): Promise<SkillEntry["interface"] | undefined> {
  const agentsDir = path.join(skillRoot, "agents");
  let entries: Array<{ name: string; isFile: boolean }> = [];
  try {
    const dirents = await fs.readdir(agentsDir, { withFileTypes: true });
    entries = dirents.map((d) => ({ name: d.name, isFile: d.isFile() }));
  } catch {
    return undefined;
  }

  const agentFiles = entries
    .filter((e) => e.isFile && /\.(ya?ml)$/i.test(e.name))
    .map((e) => e.name)
    .sort((a, b) => a.localeCompare(b));

  if (agentFiles.length === 0) return undefined;

  const primary = agentFiles.find((f) => f.toLowerCase() === "openai.yaml") ?? agentFiles[0]!;
  let raw: string;
  try {
    raw = await fs.readFile(path.join(agentsDir, primary), "utf-8");
  } catch {
    return { agents: agentFiles.map((f) => f.replace(/\.(ya?ml)$/i, "")) };
  }

  const parsed = parseAgentInterfaceYaml(raw);
  const agents = agentFiles.map((f) => f.replace(/\.(ya?ml)$/i, ""));
  const out: NonNullable<SkillEntry["interface"]> = { ...(parsed ?? {}), agents };

  // Best-effort icon resolution. Paths in yaml are intended to be relative to the skill root.
  const iconSmallPathMatch = raw.match(/^\s+icon_small:\s*(.+)\s*$/m);
  const iconLargePathMatch = raw.match(/^\s+icon_large:\s*(.+)\s*$/m);
  const iconSmallRel = iconSmallPathMatch ? stripQuotes(iconSmallPathMatch[1] ?? "") : "";
  const iconLargeRel = iconLargePathMatch ? stripQuotes(iconLargePathMatch[1] ?? "") : "";

  if (iconSmallRel) {
    const abs = path.resolve(skillRoot, iconSmallRel);
    const dataUri = await readFileAsDataUri(abs);
    if (dataUri) out.iconSmall = dataUri;
  }
  if (iconLargeRel) {
    const abs = path.resolve(skillRoot, iconLargeRel);
    const dataUri = await readFileAsDataUri(abs);
    if (dataUri) out.iconLarge = dataUri;
  }

  return out;
}

export function extractTriggers(name: string, frontMatter?: Record<string, unknown>): string[] {
  if (frontMatter) {
    const direct = parseTriggerValue(frontMatter.triggers);
    if (direct.length > 0) return direct;

    if (isPlainRecord(frontMatter.metadata)) {
      const metadataTriggers = parseTriggerValue(frontMatter.metadata.triggers);
      if (metadataTriggers.length > 0) return metadataTriggers;
    }
  }

  const defaults: Record<string, string[]> = {
    xlsx: ["spreadsheet", "excel", ".xlsx", "csv", "data table", "chart"],
    pptx: ["presentation", "slides", "powerpoint", ".pptx", "deck", "pitch"],
    pdf: ["pdf", ".pdf", "form", "merge", "split"],
    docx: ["document", "word", ".docx", "report", "letter", "memo"],
    spreadsheet: ["spreadsheet", "excel", ".xlsx", "csv", "data table", "chart"],
    slides: ["presentation", "slides", "powerpoint", ".pptx", "deck", "pitch"],
    doc: ["document", "word", ".docx", "report", "letter", "memo"],
  };

  return defaults[name] || [name];
}

export async function discoverSkills(
  skillsDirs: string[],
  opts: { includeDisabled?: boolean } = {}
): Promise<SkillEntry[]> {
  const sources: Array<SkillEntry["source"]> = ["project", "global", "user", "built-in"];

  const seen = new Set<string>();
  const entries: SkillEntry[] = [];

  const disabledGlobalDir =
    opts.includeDisabled && skillsDirs.length >= 2 ? path.join(path.dirname(skillsDirs[1]!), "disabled-skills") : null;

  for (let i = 0; i < skillsDirs.length; i++) {
    const dir = skillsDirs[i];
    const source = sources[i] || "built-in";

    // When requested, also include disabled global skills.
    const scanDirs =
      opts.includeDisabled && source === "global" && disabledGlobalDir ? [dir, disabledGlobalDir] : [dir];
    const enabledByDir = (d: string) => (disabledGlobalDir && d === disabledGlobalDir ? false : true);

    for (const scanDir of scanDirs) {
      const enabled = enabledByDir(scanDir);
      try {
        const items = await fs.readdir(scanDir, { withFileTypes: true });
        for (const item of items) {
          if (!item.isDirectory()) continue;

          const skillPath = path.join(scanDir, item.name, "SKILL.md");
          try {
            const content = await fs.readFile(skillPath, "utf-8");
            const parsed = parseSkillFrontMatter(content, item.name);
            if (!parsed) continue;

            const name = parsed.frontMatter.name;
            if (seen.has(name)) continue;

            const interfaceMeta = await readAgentInterface(path.dirname(skillPath));
            const triggers = extractTriggers(name, parsed.rawFrontMatter);

            seen.add(name);
            entries.push({
              name,
              path: skillPath,
              source,
              enabled,
              triggers,
              description: parsed.frontMatter.description,
              interface: interfaceMeta,
            });
          } catch {
            // No readable SKILL.md in this folder.
          }
        }
      } catch {
        // Dir doesn't exist.
      }
    }
  }

  return entries;
}

export function stripSkillFrontMatter(raw: string): string {
  const { body } = splitFrontMatter(raw);
  return body.trimStart();
}
