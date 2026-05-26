import { normalizeInlineLinkHref } from "@/features/cowork/inlineMarkdown";

export type CodeBlockData = { type: "code"; language: string; content: string };

export type RichBlock =
  | { type: "paragraph"; content: string }
  | { type: "heading"; level: number; content: string }
  | { type: "bullet-list"; items: string[] }
  | { type: "numbered-list"; items: string[] }
  | { type: "sources"; items: Array<{ label: string; href: string }> }
  | { type: "horizontal-rule" }
  | CodeBlockData;

const HORIZONTAL_RULE_PATTERN = /^[ \t]*([-*_])[ \t]*(?:\1[ \t]*){2,}$/;

function extractLinkFromLine(line: string): { label: string; href: string } | null {
  const markdownMatch = line.match(/^\s*[-*•]?\s*\[([^\]]+)\]\(([^)]+)\)\s*$/);
  if (markdownMatch) {
    const href = normalizeInlineLinkHref(markdownMatch[2]);
    if (href) {
      return { label: markdownMatch[1], href };
    }
  }

  const urlMatch = line.match(/^\s*[-*•]?\s*((?:https?:\/\/|www\.)[^\s]+)\s*$/i);
  if (urlMatch) {
    const href = normalizeInlineLinkHref(urlMatch[1]);
    if (href) {
      return { label: urlMatch[1], href };
    }
  }

  return null;
}

function parseCodeBlocks(text: string): Array<{ type: "text"; content: string } | CodeBlockData> {
  const blocks: Array<{ type: "text"; content: string } | CodeBlockData> = [];
  const codeBlockRegex = /```(\w*)\n([\s\S]*?)```/g;
  let lastIndex = 0;
  let match = codeBlockRegex.exec(text);
  while (match !== null) {
    if (match.index > lastIndex) {
      blocks.push({ type: "text", content: text.slice(lastIndex, match.index) });
    }
    blocks.push({ type: "code", language: match[1] || "", content: match[2] });
    lastIndex = match.index + match[0].length;
    match = codeBlockRegex.exec(text);
  }

  if (lastIndex < text.length) {
    blocks.push({ type: "text", content: text.slice(lastIndex) });
  }

  return blocks;
}

function parseTextSections(text: string): RichBlock[] {
  const sections = text.split(/\n{2,}/);
  const blocks: RichBlock[] = [];

  for (const section of sections) {
    const trimmed = section.trim();
    if (!trimmed) continue;

    const lines = trimmed.split("\n").map((line) => line.trimEnd());
    const nonEmptyLines = lines.filter((line) => line.trim().length > 0);
    if (nonEmptyLines.length === 0) continue;

    if (
      nonEmptyLines.length === 1 &&
      HORIZONTAL_RULE_PATTERN.test(nonEmptyLines[0]?.trim() ?? "")
    ) {
      blocks.push({ type: "horizontal-rule" });
      continue;
    }

    const firstLine = nonEmptyLines[0]?.trim() ?? "";
    const sourcesStartIndex = nonEmptyLines.findIndex((line) => /^sources:?$/i.test(line.trim()));
    if (sourcesStartIndex >= 0) {
      if (sourcesStartIndex > 0) {
        blocks.push({
          type: "paragraph",
          content: nonEmptyLines.slice(0, sourcesStartIndex).join("\n"),
        });
      }
      const sourceItems = nonEmptyLines
        .slice(sourcesStartIndex + 1)
        .map((line) => extractLinkFromLine(line))
        .filter((item): item is { label: string; href: string } => item !== null);
      if (sourceItems.length > 0) {
        blocks.push({ type: "sources", items: sourceItems });
        continue;
      }
    }

    if (/^sources:?$/i.test(firstLine)) {
      const sourceItems = nonEmptyLines
        .slice(1)
        .map((line) => extractLinkFromLine(line))
        .filter((item): item is { label: string; href: string } => item !== null);
      if (sourceItems.length > 0) {
        blocks.push({ type: "sources", items: sourceItems });
        continue;
      }
    }

    const headingMatch = firstLine.match(/^(#{1,6})\s+(.+)$/);
    if (headingMatch && nonEmptyLines.length === 1) {
      blocks.push({
        type: "heading",
        level: headingMatch[1].length,
        content: headingMatch[2],
      });
      continue;
    }

    const isBulletList = nonEmptyLines.every((line) => /^[-*•]\s+/.test(line.trim()));
    if (isBulletList) {
      blocks.push({
        type: "bullet-list",
        items: nonEmptyLines.map((line) => line.trim().replace(/^[-*•]\s+/, "")),
      });
      continue;
    }

    const isNumberedList = nonEmptyLines.every((line) => /^\d+\.\s+/.test(line.trim()));
    if (isNumberedList) {
      blocks.push({
        type: "numbered-list",
        items: nonEmptyLines.map((line) => line.trim().replace(/^\d+\.\s+/, "")),
      });
      continue;
    }

    blocks.push({ type: "paragraph", content: trimmed });
  }

  return blocks;
}

export function parseRichBlocks(text: string): RichBlock[] {
  const codeAwareBlocks = parseCodeBlocks(text);
  const richBlocks: RichBlock[] = [];

  for (const block of codeAwareBlocks) {
    if (block.type === "code") {
      richBlocks.push(block);
      continue;
    }
    richBlocks.push(...parseTextSections(block.content));
  }

  return richBlocks;
}
