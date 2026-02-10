import fs from "node:fs/promises";
import path from "node:path";

import { tool } from "ai";
import { z } from "zod";

import { discoverSkills, resolveSkillName } from "../skills/index";
import type { ToolContext } from "./context";

const loadedSkills = new Map<string, string>();

async function readIfExists(p: string): Promise<string | null> {
  try {
    return await fs.readFile(p, "utf-8");
  } catch {
    return null;
  }
}

async function listFilesIfExists(dir: string, maxEntries = 20): Promise<string[]> {
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    const files: string[] = [];

    for (const entry of entries) {
      if (entry.isDirectory()) continue;
      files.push(entry.name);
      if (files.length >= maxEntries) break;
    }

    return files.sort((a, b) => a.localeCompare(b));
  } catch {
    return [];
  }
}

async function collectSkillReferences(skillPath: string): Promise<string> {
  const skillDir = path.dirname(skillPath);
  const buckets = ["references", "scripts", "assets", "agents"] as const;
  const lines: string[] = [];

  for (const bucket of buckets) {
    const files = await listFilesIfExists(path.join(skillDir, bucket));
    if (files.length === 0) continue;
    lines.push(`- ${bucket}/`);
    for (const file of files) {
      lines.push(`  - ${bucket}/${file}`);
    }
  }

  if (lines.length === 0) {
    return "";
  }

  return `\n\n## Skill references index\n${lines.join("\n")}\n\nOpen these files with the read tool when you need implementation details.`;
}

async function resolveSkillRequest(
  requestedName: string,
  skillsDirs: string[]
): Promise<{ canonicalName: string; skillPath: string; content: string } | null> {
  const discovered = await discoverSkills(skillsDirs);
  const canonicalName = resolveSkillName(requestedName, discovered);
  const entry = discovered.find((s) => s.name.toLowerCase() === canonicalName?.toLowerCase());

  if (entry) {
    const content = await readIfExists(entry.path);
    if (content) {
      return {
        canonicalName: entry.name,
        skillPath: entry.path,
        content,
      };
    }
  }

  // Compatibility fallback for flat-file layout skills/<name>.md
  for (const dir of skillsDirs) {
    const p = path.join(dir, `${requestedName}.md`);
    const content = await readIfExists(p);
    if (content) {
      return {
        canonicalName: requestedName,
        skillPath: p,
        content,
      };
    }
  }

  return null;
}

export function createSkillTool(ctx: ToolContext) {
  return tool({
    description: `Load a skill (usually SKILL.md) to get specialized instructions.

Use this before producing deliverables like spreadsheets, slides, PDFs, or Word docs.
Use canonical skill names listed in the system prompt (e.g. 'spreadsheet', 'slides', 'pdf', 'doc').
Alias names are accepted and resolved automatically.`,
    inputSchema: z.object({
      skillName: z.string().describe("Canonical or alias skill name to load (e.g. 'spreadsheet' or 'xlsx')."),
    }),
    execute: async ({ skillName }) => {
      const resolved = await resolveSkillRequest(skillName, ctx.config.skillsDirs);
      if (!resolved) {
        return `Skill "${skillName}" not found.`;
      }

      const cacheKey = resolved.canonicalName.toLowerCase();
      if (loadedSkills.has(cacheKey)) {
        return loadedSkills.get(cacheKey)!;
      }

      const aliasNote = skillName.toLowerCase() !== resolved.canonicalName.toLowerCase()
        ? `Resolved skill \"${skillName}\" -> \"${resolved.canonicalName}\".\n\n`
        : "";

      const references = await collectSkillReferences(resolved.skillPath);
      const payload = `${aliasNote}# Loaded skill: ${resolved.canonicalName}\n\n${resolved.content}${references}`;

      loadedSkills.set(cacheKey, payload);
      return payload;
    },
  });
}
