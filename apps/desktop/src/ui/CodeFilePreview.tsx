import { cjk } from "@streamdown/cjk";
import { code } from "@streamdown/code";
import { math } from "@streamdown/math";
import { mermaid } from "@streamdown/mermaid";
import { AlertTriangleIcon, ExternalLinkIcon } from "lucide-react";
import { useMemo } from "react";
import { defaultRemarkPlugins, Streamdown } from "streamdown";
import { Button } from "../components/ui/button";
import { openPath } from "../lib/desktopCommands";
import { getExtensionLower } from "../lib/filePreviewKind";
import { defaultDesktopRehypePlugins } from "./markdown";

const previewPlugins = { cjk, code, math, mermaid };
const mdRemarkPlugins = [defaultRemarkPlugins.gfm];
const CODE_PREVIEW_MAX_LINES = 10_000;

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
  return EXT_TO_LANGUAGE[ext] || ext.replace(".", "") || "text";
}

function wrapInFence(content: string, language: string): string {
  // Use 4-backtick fences so content containing ``` doesn't break out.
  return `\`\`\`\`${language}\n${content}\n\`\`\`\``;
}

export function CodeFilePreview({ content, filePath }: { content: string; filePath: string }) {
  const language = useMemo(() => detectLanguage(filePath), [filePath]);
  const lineCount = useMemo(() => countLines(content), [content]);
  const isTruncated = lineCount > CODE_PREVIEW_MAX_LINES;

  const truncatedContent = useMemo(() => {
    if (!isTruncated) return content;
    const lines = content.split("\n").slice(0, CODE_PREVIEW_MAX_LINES);
    return lines.join("\n");
  }, [content, isTruncated]);

  const markdown = useMemo(
    () => wrapInFence(truncatedContent, language),
    [truncatedContent, language],
  );
  const lineNumbersText = useMemo(() => {
    const count = Math.min(lineCount, CODE_PREVIEW_MAX_LINES);
    const lines = Array.from({ length: count }, (_, i) => String(i + 1));
    if (isTruncated) {
      lines.push("…");
    }
    return lines.join("\n");
  }, [lineCount, isTruncated]);

  const openExternally = () => {
    if (filePath) void openPath({ path: filePath }).catch(() => {});
  };

  return (
    <div className="flex flex-col">
      {isTruncated ? (
        <div
          role="status"
          data-testid="code-preview-truncated-warning"
          className="flex flex-wrap items-center justify-between gap-2 border-b border-warning/35 bg-warning/10 px-3 py-2 text-xs text-foreground"
        >
          <div className="flex items-center gap-2">
            <AlertTriangleIcon className="size-3.5 shrink-0 text-warning" />
            <span>
              Showing first {CODE_PREVIEW_MAX_LINES.toLocaleString()} lines — open externally for
              the full file.
            </span>
          </div>
          <Button type="button" variant="ghost" size="sm" onClick={openExternally}>
            <ExternalLinkIcon data-icon="inline-start" />
            Open externally
          </Button>
        </div>
      ) : null}
      <div className="code-file-preview flex">
        <pre className="m-0 shrink-0 select-none pr-4 text-right text-sm text-muted-foreground/50 tabular-nums">
          {lineNumbersText}
        </pre>
        <div className="min-w-0 flex-1 select-text">
          <Streamdown
            className="select-text [&>*:first-child]:mt-0 [&>*:last-child]:mb-0 [&_[data-streamdown=code-block]]:my-0 [&_[data-streamdown=code-block]]:gap-0 [&_[data-streamdown=code-block]]:rounded-none [&_[data-streamdown=code-block]]:border-0 [&_[data-streamdown=code-block]]:bg-transparent [&_[data-streamdown=code-block]]:p-0 [&_[data-streamdown=code-block-header]]:hidden [&_[data-streamdown=code-block-body]]:overflow-x-auto [&_[data-streamdown=code-block-body]]:rounded-none [&_[data-streamdown=code-block-body]]:border-0 [&_[data-streamdown=code-block-body]]:bg-transparent [&_[data-streamdown=code-block-body]]:p-0 [&_[data-streamdown=code-block-body]]:text-sm [&_[data-streamdown=code-block-body]>pre>code>span]:block [&_pre]:m-0 [&_pre]:bg-transparent"
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
    </div>
  );
}
