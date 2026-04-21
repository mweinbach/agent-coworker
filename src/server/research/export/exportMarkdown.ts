import fs from "node:fs/promises";

import type { ResearchRecord, ResearchSource } from "../types";

function formatIsoDate(iso: string): string {
  try {
    return new Intl.DateTimeFormat("en-US", {
      dateStyle: "long",
      timeStyle: "short",
      timeZone: "UTC",
    }).format(new Date(iso));
  } catch {
    return iso;
  }
}

function formatSource(source: ResearchSource): string {
  const label = source.title?.trim() || source.url;
  const suffix = source.host ? ` (${source.host})` : "";
  return label === source.url
    ? `- ${source.url}${suffix}`
    : `- [${label}](${source.url})${suffix}`;
}

export function buildResearchMarkdownDocument(research: ResearchRecord): string {
  const report = research.outputsMarkdown.trim() || "_No report content generated yet._";
  const sections: string[] = [
    `# ${research.title.trim() || "Untitled research"}`,
    "",
    `Generated: ${formatIsoDate(research.updatedAt)}`,
    `Status: ${research.status}`,
    "",
  ];

  if (research.prompt.trim()) {
    sections.push("## Prompt", "", research.prompt.trim(), "");
  }

  sections.push("## Report", "", report, "");

  if (research.thoughtSummaries.length > 0) {
    sections.push("## Thought Summaries", "");
    for (const thought of research.thoughtSummaries) {
      sections.push(`- ${thought.text}`);
    }
    sections.push("");
  }

  if (research.sources.length > 0) {
    sections.push("## Sources", "");
    for (const source of research.sources) {
      sections.push(formatSource(source));
    }
    sections.push("");
  }

  return `${sections.join("\n").trim()}\n`;
}

export async function exportMarkdown(opts: {
  outputPath: string;
  research: ResearchRecord;
}): Promise<{ path: string; sizeBytes: number }> {
  const markdown = buildResearchMarkdownDocument(opts.research);
  await fs.writeFile(opts.outputPath, markdown, "utf-8");
  const stats = await fs.stat(opts.outputPath);
  return {
    path: opts.outputPath,
    sizeBytes: stats.size,
  };
}

