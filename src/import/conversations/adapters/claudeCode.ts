import fs from "node:fs/promises";
import path from "node:path";

import { absolutePathStyle, samePath } from "../../../platform/pathString";
import {
  extractTextFromContent,
  makeExternalItemId,
  normalizeExternalConversation,
  normalizeIsoTimestamp,
  normalizeText,
  safePathBasename,
} from "../normalize";
import type {
  ConversationDiscoverOptions,
  ConversationPreviewOptions,
  ConversationSourceCandidate,
  ExternalConversation,
  ExternalConversationItem,
} from "../types";
import {
  asRecord,
  asString,
  listFilesRecursive,
  pathExists,
  readJsonlRecords,
  statSafe,
} from "./common";
import type { ConversationSourceAdapter } from "./types";

const CLAUDE_SOURCE = "claude-code" as const;

function claudeProjectsPath(homedir: string): string {
  return path.join(homedir, ".claude", "projects");
}

function encodeClaudeProjectPath(projectPath: string): string {
  return projectPath.replace(/[:\\/]/g, "-");
}

function decodeProjectPath(projectDirName: string): string | null {
  if (projectDirName.startsWith("-")) {
    return `/${projectDirName.slice(1).replaceAll("-", "/")}`;
  }
  const windowsDrive = /^([A-Za-z])--(.+)$/.exec(projectDirName);
  if (windowsDrive) {
    return `${windowsDrive[1]}:\\${windowsDrive[2]?.replaceAll("-", "\\") ?? ""}`;
  }
  return null;
}

async function readKnownClaudeProjectPaths(
  projectsRoot: string,
): Promise<Map<string, string | null>> {
  const claudeDir = path.dirname(projectsRoot);
  if (path.basename(projectsRoot) !== "projects" || path.basename(claudeDir) !== ".claude") {
    return new Map();
  }

  try {
    const configPath = path.join(path.dirname(claudeDir), ".claude.json");
    const config = asRecord(JSON.parse(await fs.readFile(configPath, "utf8")) as unknown);
    const projects = asRecord(config?.projects);
    if (!projects) return new Map();
    const pathsByEncodedName = new Map<string, string | null>();
    for (const projectPath of Object.keys(projects)) {
      const encodedName = encodeClaudeProjectPath(projectPath);
      if (!pathsByEncodedName.has(encodedName)) {
        pathsByEncodedName.set(encodedName, projectPath);
        continue;
      }
      const previous = pathsByEncodedName.get(encodedName);
      const style = absolutePathStyle(projectPath);
      const previousStyle = previous ? absolutePathStyle(previous) : null;
      if (
        !previous ||
        !style ||
        style !== previousStyle ||
        !samePath(previous, projectPath, style)
      ) {
        // Claude's folder encoding is lossy: literal hyphens and separators both
        // become "-". Never pick an arbitrary cwd when two genuinely different
        // registered projects collide.
        pathsByEncodedName.set(encodedName, null);
      }
    }
    return pathsByEncodedName;
  } catch {
    return new Map();
  }
}

async function countClaudeJsonl(root: string): Promise<number | undefined> {
  if (!(await pathExists(root))) return undefined;
  const files = await listFilesRecursive(root, (filePath) => filePath.endsWith(".jsonl"));
  return files.length;
}

function contentBlocks(message: Record<string, unknown>): unknown[] {
  const content = message.content;
  if (Array.isArray(content)) return content;
  if (content === undefined) return [];
  return [content];
}

function toolUseId(block: Record<string, unknown>): string | null {
  return asString(block.id) ?? asString(block.tool_use_id) ?? asString(block.toolUseId);
}

function extractToolResult(
  record: Record<string, unknown>,
  block: Record<string, unknown>,
): unknown {
  if (record.toolUseResult !== undefined) return record.toolUseResult;
  if (block.content !== undefined) return extractTextFromContent(block.content) || block.content;
  return undefined;
}

function parseClaudeFileMetadata(
  records: Array<Record<string, unknown>>,
  filePath: string,
): {
  title: string;
  cwd: string | null;
  sessionId: string;
  model: string | null;
  createdAt: string;
  updatedAt: string;
  summary: string | null;
} {
  let title: string | null = null;
  let cwd: string | null = null;
  let sessionId: string | null = null;
  let model: string | null = null;
  let summary: string | null = null;
  let createdAt: string | null = null;
  let updatedAt: string | null = null;

  for (const record of records) {
    const ts = asString(record.timestamp);
    if (ts) {
      const iso = normalizeIsoTimestamp(ts, new Date(0).toISOString());
      createdAt ??= iso;
      updatedAt = iso;
    }
    if (record.type === "ai-title") {
      title = asString(record.aiTitle) ?? title;
    }
    cwd ??= asString(record.cwd);
    sessionId ??= asString(record.sessionId) ?? path.basename(filePath, ".jsonl");
    const message = asRecord(record.message);
    if (message) {
      model ??= asString(message.model);
      if (record.type === "summary") {
        summary = extractTextFromContent(message.content) || summary;
      }
    }
    if (record.type === "summary") {
      summary = extractTextFromContent(record.summary) || summary;
    }
  }

  const fallbackTs = new Date(0).toISOString();
  return {
    title: title ?? "Imported Claude Code chat",
    cwd,
    sessionId: sessionId ?? path.basename(filePath, ".jsonl"),
    model,
    createdAt: createdAt ?? fallbackTs,
    updatedAt: updatedAt ?? createdAt ?? fallbackTs,
    summary,
  };
}

export async function parseClaudeCodeJsonl(
  filePath: string,
  projectPathFallback: string | null,
): Promise<ExternalConversation> {
  const warnings: ExternalConversation["warnings"] = [];
  const records = await readJsonlRecords(filePath, warnings);
  const metadata = parseClaudeFileMetadata(records, filePath);
  const sourceId = metadata.sessionId;
  const items: ExternalConversationItem[] = [];
  const pendingToolIndexById = new Map<string, number>();

  for (const record of records) {
    const type = asString(record.type);
    const message = asRecord(record.message);
    if (!message) continue;
    const ts = normalizeIsoTimestamp(record.timestamp, metadata.updatedAt);

    if (type === "user") {
      let handledToolResult = false;
      for (const blockValue of contentBlocks(message)) {
        const block = asRecord(blockValue);
        if (block?.type !== "tool_result") continue;
        handledToolResult = true;
        const id = toolUseId(block);
        const index = id ? pendingToolIndexById.get(id) : undefined;
        const result = extractToolResult(record, block);
        const isError = block.is_error === true || block.isError === true;
        if (index !== undefined) {
          const existing = items[index];
          if (existing?.kind === "tool") {
            items[index] = isError
              ? {
                  ...existing,
                  error: extractTextFromContent(result) || String(result ?? "Tool error"),
                }
              : { ...existing, result };
          }
        } else {
          items.push({
            kind: "tool",
            id: makeExternalItemId({
              source: CLAUDE_SOURCE,
              sourceId,
              index: items.length,
              kind: "tool",
              seed: record,
            }),
            ts,
            name: "tool",
            ...(isError
              ? { error: extractTextFromContent(result) || String(result ?? "Tool error") }
              : { result }),
          });
        }
      }
      if (handledToolResult) {
        warnings.push({
          code: "tool_protocol_redacted",
          message:
            "Claude Code tool-use identifiers were used only for pairing and were not imported as continuation state.",
        });
        continue;
      }
      const text = extractTextFromContent(message.content);
      if (!text) continue;
      items.push({
        kind: "user",
        id: makeExternalItemId({
          source: CLAUDE_SOURCE,
          sourceId,
          index: items.length,
          kind: "user",
          seed: record.uuid ?? text,
        }),
        ts,
        text,
      });
      continue;
    }

    if (type !== "assistant") continue;
    for (const blockValue of contentBlocks(message)) {
      const block = asRecord(blockValue);
      if (!block) {
        const text = extractTextFromContent(blockValue);
        if (text) {
          items.push({
            kind: "assistant",
            id: makeExternalItemId({
              source: CLAUDE_SOURCE,
              sourceId,
              index: items.length,
              kind: "assistant",
              seed: blockValue,
            }),
            ts,
            text,
          });
        }
        continue;
      }
      if (block.type === "text") {
        const text = extractTextFromContent(block);
        if (!text) continue;
        items.push({
          kind: "assistant",
          id: makeExternalItemId({
            source: CLAUDE_SOURCE,
            sourceId,
            index: items.length,
            kind: "assistant",
            seed: block,
          }),
          ts,
          text,
        });
        continue;
      }
      if (block.type === "thinking") {
        const summary = normalizeText(
          asString(block.summary) ?? extractTextFromContent(block.summary),
        );
        if (summary) {
          items.push({
            kind: "reasoning",
            id: makeExternalItemId({
              source: CLAUDE_SOURCE,
              sourceId,
              index: items.length,
              kind: "reasoning",
              seed: summary,
            }),
            ts,
            mode: "summary",
            text: summary,
          });
        }
        warnings.push({
          code: "reasoning_redacted",
          message: "Claude Code thinking signatures and hidden thinking content were redacted.",
        });
        continue;
      }
      if (block.type === "tool_use") {
        const name = normalizeText(asString(block.name) ?? "tool") || "tool";
        const id = toolUseId(block);
        items.push({
          kind: "tool",
          id: makeExternalItemId({
            source: CLAUDE_SOURCE,
            sourceId,
            index: items.length,
            kind: "tool",
            seed: block,
          }),
          ts,
          name,
          ...(block.input !== undefined ? { args: block.input } : {}),
        });
        if (id) pendingToolIndexById.set(id, items.length - 1);
        warnings.push({
          code: "tool_protocol_redacted",
          message:
            "Claude Code tool-use identifiers were used only for pairing and were not imported as continuation state.",
        });
      }
    }
  }

  const cwd = metadata.cwd ?? projectPathFallback;
  const conversationWarnings = [...warnings];
  if (!cwd)
    conversationWarnings.push({
      code: "missing_cwd",
      message: "Claude Code chat did not include a working directory.",
    });
  return normalizeExternalConversation({
    source: CLAUDE_SOURCE,
    sourceId,
    sourcePath: filePath,
    cwd,
    title: metadata.title || safePathBasename(cwd),
    createdAt: metadata.createdAt,
    updatedAt: metadata.updatedAt,
    originalProvider: "anthropic",
    originalModel: metadata.model,
    items,
    summary: metadata.summary,
    warnings: conversationWarnings,
  });
}

export const claudeCodeConversationAdapter: ConversationSourceAdapter = {
  source: CLAUDE_SOURCE,

  async discover(opts: ConversationDiscoverOptions): Promise<ConversationSourceCandidate[]> {
    const roots =
      opts.explicitPaths && opts.explicitPaths.length > 0
        ? opts.explicitPaths
        : [claudeProjectsPath(opts.homedir)];
    const candidates: ConversationSourceCandidate[] = [];
    for (const root of roots) {
      const available = await pathExists(root);
      candidates.push({
        source: CLAUDE_SOURCE,
        id: `claude-code:${root}`,
        path: root,
        available,
        ...(available
          ? { conversationCount: await countClaudeJsonl(root) }
          : { warning: "Claude Code projects directory was not found." }),
      });
    }
    return candidates;
  },

  async preview(
    candidate: ConversationSourceCandidate,
    opts: ConversationPreviewOptions,
  ): Promise<ExternalConversation[]> {
    if (!candidate.available) return [];
    const stat = await statSafe(candidate.path);
    const files = stat?.isFile()
      ? [candidate.path]
      : await listFilesRecursive(candidate.path, (filePath) => filePath.endsWith(".jsonl"));
    const limit = Math.max(1, Math.min(1000, Math.floor(opts.limit ?? 250)));
    const sorted = await Promise.all(
      files.map(async (filePath) => ({
        filePath,
        stat: await fs.stat(filePath).catch(() => null),
      })),
    );
    sorted.sort((left, right) => (right.stat?.mtimeMs ?? 0) - (left.stat?.mtimeMs ?? 0));
    const selected = sorted.slice(0, limit);
    const knownProjectPaths = stat?.isFile()
      ? new Map<string, string | null>()
      : await readKnownClaudeProjectPaths(candidate.path);
    const conversations: ExternalConversation[] = [];
    for (const entry of selected) {
      const relative = path.relative(candidate.path, entry.filePath);
      const projectDir = relative.split(path.sep)[0] ?? "";
      const fallback = knownProjectPaths.has(projectDir)
        ? (knownProjectPaths.get(projectDir) ?? null)
        : decodeProjectPath(projectDir);
      conversations.push(await parseClaudeCodeJsonl(entry.filePath, fallback));
    }
    return conversations;
  },
};
