export type FilePreviewKind =
  | "markdown"
  | "text"
  | "pdf"
  | "image"
  | "docx"
  | "xlsx"
  | "unsupported"
  | "unknown";

const MARKDOWN_EXT = new Set([".md", ".mdx"]);
const TEXTLIKE_EXT = new Set([
  ".txt",
  ".log",
  ".json",
  ".jsonc",
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".css",
  ".scss",
  ".html",
  ".htm",
  ".xml",
  ".yaml",
  ".yml",
  ".toml",
  ".ini",
  ".cfg",
  ".env",
  ".sh",
  ".bash",
  ".zsh",
  ".ps1",
  ".bat",
  ".cmd",
  ".sql",
  ".graphql",
  ".gql",
  ".rs",
  ".go",
  ".py",
  ".rb",
  ".php",
  ".java",
  ".kt",
  ".swift",
  ".c",
  ".h",
  ".cpp",
  ".hpp",
  ".cs",
  ".vue",
  ".svelte",
]);
const IMAGE_EXT = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp", ".ico", ".avif"]);

export function getExtensionLower(filePath: string): string {
  const base = filePath.replace(/\\/g, "/").split("/").pop() ?? "";
  const dot = base.lastIndexOf(".");
  if (dot <= 0) return "";
  return base.slice(dot).toLowerCase();
}

export function getFilePreviewKind(filePath: string): FilePreviewKind {
  const ext = getExtensionLower(filePath);
  if (ext === ".pdf") return "pdf";
  if (MARKDOWN_EXT.has(ext)) return "markdown";
  if (ext === ".docx") return "docx";
  if (ext === ".doc") return "unsupported";
  if (ext === ".xlsx") return "xlsx";
  if (ext === ".pptx" || ext === ".ppt") return "unsupported";
  if (IMAGE_EXT.has(ext)) return "image";
  if (ext === ".svg") return "image";
  if (TEXTLIKE_EXT.has(ext)) return "text";
  return "unknown";
}

export function mimeForPreviewKind(kind: FilePreviewKind, ext: string): string {
  if (kind === "pdf") return "application/pdf";
  if (kind === "image") {
    if (ext === ".svg") return "image/svg+xml";
    if (ext === ".png") return "image/png";
    if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
    if (ext === ".webp") return "image/webp";
    if (ext === ".gif") return "image/gif";
    return "application/octet-stream";
  }
  return "application/octet-stream";
}
