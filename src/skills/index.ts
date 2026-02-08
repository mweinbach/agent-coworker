import fs from "node:fs/promises";
import path from "node:path";

import type { SkillEntry } from "../types";

function extractTriggers(name: string, content: string): string[] {
  const triggerMatch = content.match(/^TRIGGERS?:\s*(.+)$/im);
  if (triggerMatch) {
    return triggerMatch[1]
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean);
  }

  const defaults: Record<string, string[]> = {
    xlsx: ["spreadsheet", "excel", ".xlsx", "csv", "data table", "chart"],
    pptx: ["presentation", "slides", "powerpoint", ".pptx", "deck", "pitch"],
    pdf: ["pdf", ".pdf", "form", "merge", "split"],
    docx: ["document", "word", ".docx", "report", "letter", "memo"],
  };

  return defaults[name] || [name];
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
          const firstLine = content.split("\n")[0]?.replace(/^#+\s*/, "") || item.name;
          seen.add(item.name);
          entries.push({
            name: item.name,
            path: skillPath,
            source,
            triggers: extractTriggers(item.name, content),
            description: firstLine,
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
