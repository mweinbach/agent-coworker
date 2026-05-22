function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function parseInlineMarkdown(text: string): string {
  let html = escapeHtml(text);
  html = html.replace(/\*\*(.*?)\*\*/g, "<strong>$1</strong>");
  html = html.replace(/__(.*?)__/g, "<strong>$1</strong>");
  html = html.replace(/\*(.*?)\*/g, "<em>$1</em>");
  html = html.replace(/_(.*?)_/g, "<em>$1</em>");
  html = html.replace(/`(.*?)`/g, "<code>$1</code>");
  html = html.replace(
    /\[(.*?)\]\((.*?)\)/g,
    '<a href="$2" target="_blank" class="underline text-primary">$1</a>',
  );
  return html;
}

function markdownToHtml(md: string): string {
  if (!md) return "<p><br></p>";
  const lines = md.split(/\r?\n/);
  let html = "";
  let inCodeBlock = false;
  let codeContent: string[] = [];
  let inList = false;
  let listTag = "";
  let currentParagraph: string[] = [];

  const flushParagraph = () => {
    if (currentParagraph.length > 0) {
      html += `<p>${currentParagraph.map((l) => parseInlineMarkdown(l)).join("<br>")}</p>`;
      currentParagraph = [];
    }
  };

  const flushList = () => {
    if (inList) {
      html += `</${listTag}>`;
      inList = false;
    }
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    if (inCodeBlock) {
      if (trimmed.startsWith("```")) {
        html += `<pre><code>${escapeHtml(codeContent.join("\n"))}</code></pre>`;
        inCodeBlock = false;
      } else {
        codeContent.push(line);
      }
      continue;
    }

    if (trimmed.startsWith("```")) {
      flushParagraph();
      flushList();
      inCodeBlock = true;
      codeContent = [];
      continue;
    }

    if (trimmed === "---" || trimmed === "***" || trimmed === "___") {
      flushParagraph();
      flushList();
      html += `<hr>`;
      continue;
    }

    const headingMatch = line.match(/^(#{1,6})\s+(.*)$/);
    if (headingMatch) {
      flushParagraph();
      flushList();
      const level = headingMatch[1].length;
      html += `<h${level}>${parseInlineMarkdown(headingMatch[2])}</h${level}>`;
      continue;
    }

    const listMatch = line.match(/^(\s*)(?:-\s*|\*\s*|\d+\.\s+)(.*)$/);
    if (listMatch) {
      flushParagraph();
      const isOrdered = line.trim().match(/^\d+\./);
      const tag = isOrdered ? "ol" : "ul";
      if (!inList) {
        inList = true;
        listTag = tag;
        html += `<${tag}>`;
      } else if (listTag !== tag) {
        html += `</${listTag}><${tag}>`;
        listTag = tag;
      }
      html += `<li>${parseInlineMarkdown(listMatch[2])}</li>`;
      continue;
    }

    if (trimmed.startsWith(">")) {
      flushParagraph();
      flushList();
      const content = line.replace(/^\s*>\s*/, "");
      html += `<blockquote>${parseInlineMarkdown(content)}</blockquote>`;
      continue;
    }

    if (trimmed === "") {
      flushParagraph();
      flushList();
      continue;
    }

    flushList();
    currentParagraph.push(line);
  }

  flushParagraph();
  flushList();

  return html || "<p><br></p>";
}

const md = `Comprehensive Research Report: Analysis of Litigation and Antitrust Matters Involving Apple and OpenAI (May 2026)
---
Executive Summary
As of mid-May 2026, the intersection of enterprise technology...

---
Section 1: The Musk / xAI Antitrust and Contract Litigation Context
The active litigation initiated by Elon Musk...

### A. The Texas Antitrust Suit: Case Profile & Current Status
**Case Name:** X Corp. and X.AI LLC v. Apple Inc., OpenAI, Inc., OpenAI, L.L.C., and OpenAI OpCo, LLC*
* Docket Number: Case No. 4:25-cv-00914-P`;

console.log(markdownToHtml(md));
