import fs from "node:fs/promises";
import path from "node:path";

import type { SkillEntry } from "../types";

const DEFAULT_TRIGGERS: Record<string, string[]> = {
  spreadsheet: ["spreadsheet", "excel", ".xlsx", "csv", "data table", "chart", "xlsx"],
  slides: ["presentation", "slides", "powerpoint", ".pptx", "deck", "pitch", "pptx"],
  pdf: ["pdf", ".pdf", "form", "merge", "split"],
  doc: ["document", "word", ".docx", "report", "letter", "memo", "docx"],
  // Legacy built-in names kept for compatibility with existing tests/custom skills.
  xlsx: ["spreadsheet", "excel", ".xlsx", "csv", "data table", "chart"],
  pptx: ["presentation", "slides", "powerpoint", ".pptx", "deck", "pitch"],
  docx: ["document", "word", ".docx", "report", "letter", "memo"],
};

function normalizeSkillKey(value: string): string {
  return value.trim().toLowerCase();
}

function uniqueNormalized(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];

  for (const value of values) {
    const key = normalizeSkillKey(value);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(key);
  }

  return out;
}

export function extractTriggers(name: string, content: string): string[] {
  const triggerMatch = content.match(/^\s*TRIGGERS?\s*:\s*(.+)$/im);
  if (triggerMatch) {
    return uniqueNormalized(
      triggerMatch[1]
        .split(",")
        .map((t) => t.trim())
        .filter(Boolean)
    );
  }

  return uniqueNormalized(DEFAULT_TRIGGERS[normalizeSkillKey(name)] || [name]);
}

function extractFrontmatterDescription(content: string): string | null {
  const frontmatterMatch = content.match(/^---\s*\n([\s\S]*?)\n---\s*(?:\n|$)/);
  if (!frontmatterMatch) return null;

  const descriptionMatch = frontmatterMatch[1].match(/^\s*description\s*:\s*["']?(.+?)["']?\s*$/im);
  return descriptionMatch?.[1]?.trim() || null;
}

export function extractDescription(name: string, content: string): string {
  const frontmatterDescription = extractFrontmatterDescription(content);
  if (frontmatterDescription) return frontmatterDescription;

  const firstHeading = content
    .split("\n")
    .find((line) => line.trim().startsWith("#"))
    ?.replace(/^#+\s*/, "")
    .trim();

  return firstHeading || name;
}

export function buildSkillAliasMap(skills: SkillEntry[]): Map<string, string> {
  const aliasToCanonical = new Map<string, string>();

  for (const skill of skills) {
    const canonicalName = normalizeSkillKey(skill.name);
    aliasToCanonical.set(canonicalName, canonicalName);

    for (const trigger of skill.triggers) {
      const alias = normalizeSkillKey(trigger);
      if (!alias || aliasToCanonical.has(alias)) continue;
      aliasToCanonical.set(alias, canonicalName);
    }
  }

  return aliasToCanonical;
}

export function resolveSkillName(requestedName: string, skills: SkillEntry[]): string | null {
  const normalizedRequested = normalizeSkillKey(requestedName);
  if (!normalizedRequested) return null;

  const aliasMap = buildSkillAliasMap(skills);
  return aliasMap.get(normalizedRequested) || null;
}

export async function discoverSkills(skillsDirs: string[]): Promise<SkillEntry[]> {
  const sources: Array<SkillEntry["source"]> = ["project", "user", "built-in"];

  const seen = new Set<string>();
  const entries: SkillEntry[] = [];

  for (let i = 0; i < skillsDirs.length; i++) {
    const dir = skillsDirs[i];
    const source = sources[i] || "built-in";

    try {
      const items = await fs.readdir(dir, { withFileTypes: true });
      for (const item of items) {
        if (!item.isDirectory()) continue;
        if (seen.has(item.name)) continue;

        const skillPath = path.join(dir, item.name, "SKILL.md");
        try {
          const content = await fs.readFile(skillPath, "utf-8");
          seen.add(item.name);
          entries.push({
            name: item.name,
            path: skillPath,
            source,
            triggers: extractTriggers(item.name, content),
            description: extractDescription(item.name, content),
          });
        } catch {
          // No SKILL.md in this folder.
        }
      }
    } catch {
      // Dir doesn't exist.
    }
  }

  return entries;
}
