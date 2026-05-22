export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

export function parseInlineMarkdown(text: string): string {
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

export function markdownToHtml(md: string): string {
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

export function nodeToMarkdown(node: Node): string {
  let result = "";
  for (let i = 0; i < node.childNodes.length; i++) {
    const child = node.childNodes[i];
    if (child.nodeType === Node.TEXT_NODE) {
      result += child.textContent;
    } else if (child.nodeType === Node.ELEMENT_NODE) {
      const el = child as HTMLElement;
      const tagName = el.tagName.toLowerCase();

      switch (tagName) {
        case "p":
          result += `${nodeToMarkdown(el)}\n\n`;
          break;
        case "strong":
        case "b":
          result += `**${nodeToMarkdown(el)}**`;
          break;
        case "em":
        case "i":
          result += `*${nodeToMarkdown(el)}*`;
          break;
        case "h1":
          result += `# ${nodeToMarkdown(el)}\n\n`;
          break;
        case "h2":
          result += `## ${nodeToMarkdown(el)}\n\n`;
          break;
        case "h3":
          result += `### ${nodeToMarkdown(el)}\n\n`;
          break;
        case "h4":
          result += `#### ${nodeToMarkdown(el)}\n\n`;
          break;
        case "h5":
          result += `##### ${nodeToMarkdown(el)}\n\n`;
          break;
        case "h6":
          result += `###### ${nodeToMarkdown(el)}\n\n`;
          break;
        case "ul":
          result += `${nodeToMarkdown(el)}\n`;
          break;
        case "ol":
          result += `${nodeToMarkdown(el)}\n`;
          break;
        case "li":
          result += `- ${nodeToMarkdown(el)}\n`;
          break;
        case "pre":
          result += `\`\`\`\n${el.innerText}\n\`\`\`\n\n`;
          break;
        case "code":
          result += `\`${nodeToMarkdown(el)}\``;
          break;
        case "blockquote":
          result += `> ${nodeToMarkdown(el)}\n\n`;
          break;
        case "hr":
          result += `---\n\n`;
          break;
        case "a":
          result += `[${nodeToMarkdown(el)}](${el.getAttribute("href") ?? ""})`;
          break;
        case "br":
          result += "\n";
          break;
        case "div":
          result += `${nodeToMarkdown(el)}\n`;
          break;
        default:
          result += nodeToMarkdown(el);
      }
    }
  }
  return result;
}

export function cleanMarkdown(md: string): string {
  return md.replace(/\n{3,}/g, "\n\n").trim();
}
