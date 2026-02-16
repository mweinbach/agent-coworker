import type { FeedItem } from "../context/sync";

/**
 * Formats feed items into a plain text transcript.
 */
export function formatTranscript(feed: FeedItem[]): string {
  const lines: string[] = [];

  for (const item of feed) {
    switch (item.type) {
      case "message": {
        const msg = item as any;
        lines.push(`[${msg.role}]`);
        lines.push(msg.text);
        lines.push("");
        break;
      }
      case "tool": {
        const tool = item as any;
        lines.push(`[tool: ${tool.name}] ${tool.status}`);
        if (tool.args) {
          try {
            lines.push(`  args: ${JSON.stringify(tool.args)}`);
          } catch {
            lines.push(`  args: ${String(tool.args)}`);
          }
        }
        lines.push("");
        break;
      }
      case "error": {
        const err = item as any;
        lines.push(`[error] ${err.message}`);
        lines.push("");
        break;
      }
      case "system": {
        const sys = item as any;
        lines.push(`[system] ${sys.line}`);
        break;
      }
    }
  }

  return lines.join("\n");
}
