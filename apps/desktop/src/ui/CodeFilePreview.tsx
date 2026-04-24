import { cjk } from "@streamdown/cjk";
import { code } from "@streamdown/code";
import { math } from "@streamdown/math";
import { mermaid } from "@streamdown/mermaid";
import { useMemo } from "react";
import { defaultRemarkPlugins, Streamdown } from "streamdown";
import { defaultDesktopRehypePlugins } from "../components/ai-elements/message";
import { getExtensionLower } from "../lib/filePreviewKind";

const previewPlugins = { cjk, code, math, mermaid };
const mdRemarkPlugins = [defaultRemarkPlugins.gfm];

function countLines(text: string): number {
  let i = text.length;
  while (i > 0 && text[i - 1] === "\n") i--;
  const trimmed = text.slice(0, i);
  if (trimmed.length === 0) return 1;
  return trimmed.split("\n").length;
}

const EXT_TO_LANGUAGE: Record<string, string> = {
  ".ts": "typescript",
  ".tsx": "tsx",
  ".js": "javascript",
  ".jsx": "jsx",
  ".mjs": "javascript",
  ".cjs": "javascript",
  ".py": "python",
  ".json": "json",
  ".jsonc": "jsonc",
  ".css": "css",
  ".scss": "scss",
  ".html": "html",
  ".htm": "html",
  ".xml": "xml",
  ".yaml": "yaml",
  ".yml": "yaml",
  ".toml": "toml",
  ".ini": "ini",
  ".sh": "bash",
  ".bash": "bash",
  ".zsh": "zsh",
  ".ps1": "powershell",
  ".bat": "batch",
  ".cmd": "batch",
  ".sql": "sql",
  ".graphql": "graphql",
  ".gql": "graphql",
  ".rs": "rust",
  ".go": "go",
  ".rb": "ruby",
  ".php": "php",
  ".java": "java",
  ".kt": "kotlin",
  ".swift": "swift",
  ".c": "c",
  ".h": "c",
  ".cpp": "cpp",
  ".hpp": "cpp",
  ".cs": "csharp",
  ".vue": "vue",
  ".svelte": "svelte",
  ".log": "log",
  ".env": "dotenv",
  ".cfg": "ini",
};

function detectLanguage(filePath: string): string {
  const ext = getExtensionLower(filePath);
  return EXT_TO_LANGUAGE[ext] ?? ext.replace(".", "") ?? "text";
}

function wrapInFence(content: string, language: string): string {
  // Use 4-backtick fences so content containing ``` doesn't break out.
  return `\`\`\`\`${language}\n${content}\n\`\`\`\``;
}

export function CodeFilePreview({ content, filePath }: { content: string; filePath: string }) {
  const language = useMemo(() => detectLanguage(filePath), [filePath]);
  const markdown = useMemo(() => wrapInFence(content, language), [content, language]);
  const lineCount = useMemo(() => countLines(content), [content]);
  const maxLines = 10_000;
  const lineNumbersText = useMemo(() => {
    const count = Math.min(lineCount, maxLines);
    const lines = Array.from({ length: count }, (_, i) => String(i + 1));
    if (lineCount > maxLines) {
      lines.push("…");
    }
    return lines.join("\n");
  }, [lineCount]);

  return (
    <div className="code-file-preview flex">
      <pre className="m-0 shrink-0 select-none pr-4 text-right text-sm text-muted-foreground/50 tabular-nums">
        {lineNumbersText}
      </pre>
      <div className="min-w-0 flex-1">
        <Streamdown
          className="[&>*:first-child]:mt-0 [&>*:last-child]:mb-0 [&_[data-streamdown=code-block]]:my-0 [&_[data-streamdown=code-block]]:gap-0 [&_[data-streamdown=code-block]]:rounded-none [&_[data-streamdown=code-block]]:border-0 [&_[data-streamdown=code-block]]:bg-transparent [&_[data-streamdown=code-block]]:p-0 [&_[data-streamdown=code-block-header]]:hidden [&_[data-streamdown=code-block-body]]:overflow-x-auto [&_[data-streamdown=code-block-body]]:rounded-none [&_[data-streamdown=code-block-body]]:border-0 [&_[data-streamdown=code-block-body]]:bg-transparent [&_[data-streamdown=code-block-body]]:p-0 [&_[data-streamdown=code-block-body]]:text-sm [&_[data-streamdown=code-block-body]>pre>code>span]:block [&_pre]:m-0 [&_pre]:bg-transparent"
          plugins={previewPlugins}
          remarkPlugins={mdRemarkPlugins}
          rehypePlugins={defaultDesktopRehypePlugins}
          controls={false}
          lineNumbers={false}
        >
          {markdown}
        </Streamdown>
      </div>
    </div>
  );
}
