import fs from "node:fs/promises";

import {
  AlignmentType,
  BorderStyle,
  Document,
  ExternalHyperlink,
  Footer,
  HeadingLevel,
  type IParagraphOptions,
  Packer,
  PageNumber,
  Paragraph,
  ShadingType,
  TextRun,
  type ParagraphChild,
} from "docx";

import type { ResearchRecord } from "../types";
import { nodeChildren, nodeText, parseMarkdownAst, trimMarkdownText, type MarkdownNode } from "./markdownAst";
import { buildResearchMarkdownDocument } from "./exportMarkdown";

function headingLevel(depth: number) {
  switch (depth) {
    case 1:
      return HeadingLevel.TITLE;
    case 2:
      return HeadingLevel.HEADING_1;
    case 3:
      return HeadingLevel.HEADING_2;
    default:
      return HeadingLevel.HEADING_3;
  }
}

function paragraphSpacing(after = 160) {
  return {
    after,
    line: 280,
  };
}

function inlineChildren(node: MarkdownNode): ParagraphChild[] {
  const children = nodeChildren(node);
  if (children.length === 0) {
    const text = trimMarkdownText(nodeText(node));
    return text ? [new TextRun(text)] : [];
  }

  const runs: ParagraphChild[] = [];
  for (const child of children) {
    switch (child.type) {
      case "text":
        if (child.value) {
          runs.push(new TextRun(child.value));
        }
        break;
      case "strong":
        runs.push(new TextRun({ text: nodeText(child), bold: true }));
        break;
      case "emphasis":
        runs.push(new TextRun({ text: nodeText(child), italics: true }));
        break;
      case "delete":
        runs.push(new TextRun({ text: nodeText(child), strike: true }));
        break;
      case "inlineCode":
        runs.push(new TextRun({
          text: child.value ?? "",
          font: "Courier New",
          shading: {
            fill: "F3F4F6",
            type: ShadingType.CLEAR,
          },
        }));
        break;
      case "link":
        runs.push(
          new ExternalHyperlink({
            link: child.url ?? "",
            children: [
              new TextRun({
                text: trimMarkdownText(nodeText(child)) || child.url || "",
                style: "Hyperlink",
              }),
            ],
          }),
        );
        break;
      case "break":
        runs.push(new TextRun({ text: "\n" }));
        break;
      case "image":
        runs.push(new TextRun(`[Image: ${child.alt ?? child.url ?? "untitled"}]`));
        break;
      default: {
        const nested = inlineChildren(child);
        if (nested.length > 0) {
          runs.push(...nested);
        } else {
          const fallback = trimMarkdownText(nodeText(child));
          if (fallback) {
            runs.push(new TextRun(fallback));
          }
        }
      }
    }
  }

  return runs;
}

function paragraphFromNode(node: MarkdownNode, options: Partial<IParagraphOptions> = {}): Paragraph {
  const children = inlineChildren(node);
  return new Paragraph({
    children,
    spacing: paragraphSpacing(),
    ...options,
  });
}

function renderList(node: MarkdownNode, depth = 0): Paragraph[] {
  const ordered = node.ordered === true;
  const start = typeof node.start === "number" ? node.start : 1;
  return nodeChildren(node).flatMap((item, index) => {
    const children = nodeChildren(item);
    const prefix = ordered ? `${start + index}.` : "\u2022";
    const firstBlock = children[0];
    const remainingBlocks = children.slice(1);
    const baseRuns = firstBlock?.type === "paragraph"
      ? inlineChildren(firstBlock)
      : [new TextRun(trimMarkdownText(nodeText(item)))];
    const paragraphs = [
      new Paragraph({
        children: [
          new TextRun({ text: `${prefix} `, bold: true }),
          ...baseRuns,
        ],
        spacing: paragraphSpacing(120),
        indent: {
          left: 360 * (depth + 1),
          hanging: 240,
        },
      }),
    ];

    for (const block of remainingBlocks) {
      if (block.type === "list") {
        paragraphs.push(...renderList(block, depth + 1));
        continue;
      }
      paragraphs.push(...renderBlock(block, depth + 1));
    }
    return paragraphs;
  });
}

function renderBlock(node: MarkdownNode, depth = 0): Paragraph[] {
  switch (node.type) {
    case "heading":
      return [
        new Paragraph({
          text: trimMarkdownText(nodeText(node)),
          heading: headingLevel(node.depth ?? 4),
          spacing: paragraphSpacing(180),
        }),
      ];
    case "paragraph":
      return [paragraphFromNode(node)];
    case "list":
      return renderList(node, depth);
    case "blockquote":
      return nodeChildren(node).flatMap((child) => {
        if (child.type === "paragraph") {
          return [
            paragraphFromNode(child, {
              spacing: paragraphSpacing(140),
              indent: {
                left: 480,
              },
              border: {
                left: {
                  color: "CBD5E1",
                  size: 10,
                  style: BorderStyle.SINGLE,
                },
              },
            }),
          ];
        }
        if (child.type === "heading") {
          return [
            new Paragraph({
              text: trimMarkdownText(nodeText(child)),
              heading: headingLevel(child.depth ?? 4),
              spacing: paragraphSpacing(140),
              indent: {
                left: 480,
              },
              border: {
                left: {
                  color: "CBD5E1",
                  size: 10,
                  style: BorderStyle.SINGLE,
                },
              },
            }),
          ];
        }
        return renderBlock(child, depth);
      });
    case "code":
      return [
        new Paragraph({
          children: [
            new TextRun({
              text: node.value ?? "",
              font: "Courier New",
            }),
          ],
          spacing: paragraphSpacing(180),
          border: {
            top: { color: "E5E7EB", size: 6, style: BorderStyle.SINGLE },
            right: { color: "E5E7EB", size: 6, style: BorderStyle.SINGLE },
            bottom: { color: "E5E7EB", size: 6, style: BorderStyle.SINGLE },
            left: { color: "E5E7EB", size: 6, style: BorderStyle.SINGLE },
          },
          shading: {
            fill: "F3F4F6",
            type: ShadingType.CLEAR,
          },
        }),
      ];
    case "thematicBreak":
      return [
        new Paragraph({
          text: "",
          thematicBreak: true,
        }),
      ];
    default: {
      const text = trimMarkdownText(nodeText(node));
      if (text) {
        return [
          new Paragraph({
            text,
            spacing: paragraphSpacing(),
          }),
        ];
      }
      return nodeChildren(node).flatMap((child) => renderBlock(child, depth));
    }
  }
}

export async function exportDocx(opts: {
  outputPath: string;
  research: ResearchRecord;
}): Promise<{ path: string; sizeBytes: number }> {
  const markdown = buildResearchMarkdownDocument(opts.research);
  const blocks = parseMarkdownAst(markdown);
  const doc = new Document({
    title: opts.research.title,
    sections: [{
      footers: {
        default: new Footer({
          children: [
            new Paragraph({
              alignment: AlignmentType.CENTER,
              children: [
                new TextRun("Page "),
                new TextRun({ children: [PageNumber.CURRENT] }),
                new TextRun(" of "),
                new TextRun({ children: [PageNumber.TOTAL_PAGES] }),
              ],
            }),
          ],
        }),
      },
      children: blocks.flatMap((block) => renderBlock(block)),
    }],
  });

  const buffer = await Packer.toBuffer(doc);
  await fs.writeFile(opts.outputPath, buffer);
  const stats = await fs.stat(opts.outputPath);
  return {
    path: opts.outputPath,
    sizeBytes: stats.size,
  };
}
