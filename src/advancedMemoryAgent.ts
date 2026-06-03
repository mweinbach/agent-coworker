import { z } from "zod";

import { AdvancedMemoryStore } from "./advancedMemoryStore";
import { parseChildModelRef } from "./models/childModelRouting";
import { createRuntime } from "./runtime";
import type { AgentConfig, ModelMessage } from "./types";
import { normalizeRuntimeNameForProvider } from "./types";

export const DEFAULT_ADVANCED_MEMORY_MODEL_REF = "google:gemini-3.1-flash-lite";

const MAX_DELTA_MESSAGES = 40;
const MAX_CONTENT_CHARS = 6_000;

function truncate(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, maxChars).trimEnd()}\n...[truncated ${value.length - maxChars} chars]`;
}

function compactContent(content: unknown): string {
  if (typeof content === "string") return truncate(content, MAX_CONTENT_CHARS);
  if (!Array.isArray(content)) return truncate(JSON.stringify(content), MAX_CONTENT_CHARS);
  const parts: string[] = [];
  for (const part of content) {
    if (typeof part === "string") {
      parts.push(part);
      continue;
    }
    if (!part || typeof part !== "object") continue;
    const record = part as Record<string, unknown>;
    const text = record.text ?? record.inputText ?? record.outputText;
    if (typeof text === "string") {
      parts.push(text);
      continue;
    }
    const type = typeof record.type === "string" ? record.type : "part";
    parts.push(`[${type}]`);
  }
  return truncate(parts.join("\n"), MAX_CONTENT_CHARS);
}

function compactDelta(messages: ModelMessage[]): string {
  const delta = messages.slice(-MAX_DELTA_MESSAGES);
  if (delta.length === 0) return "No new conversation messages were captured.";
  return delta
    .map((message, index) => {
      const role = typeof message.role === "string" ? message.role : "unknown";
      return `## ${index + 1}. ${role}\n${compactContent(message.content)}`;
    })
    .join("\n\n");
}

function resolveGeneratorConfig(config: AgentConfig): AgentConfig {
  const parsed = parseChildModelRef(
    config.advancedMemoryModelRef ?? DEFAULT_ADVANCED_MEMORY_MODEL_REF,
    config.provider,
    "advanced memory model",
  );
  return {
    ...config,
    provider: parsed.provider,
    model: parsed.modelId,
    runtime: normalizeRuntimeNameForProvider(parsed.provider, undefined),
  };
}

function createAdvancedMemoryTools(store: AdvancedMemoryStore) {
  const upsertMemorySchema = z.object({
    name: z.string().trim().min(1).describe("Short stable file name, with or without .md"),
    content: z.string().trim().min(1).describe("Full Markdown file content"),
  });
  const deleteMemorySchema = z.object({
    name: z.string().trim().min(1),
  });
  return {
    upsertMemory: {
      description:
        "Create or update one advanced memory Markdown file. Content must include YAML frontmatter followed by a Markdown body.",
      inputSchema: upsertMemorySchema,
      execute: async (input: unknown) => {
        const { name, content } = upsertMemorySchema.parse(input);
        const entry = await store.upsert(name, content);
        return `Saved ${entry.fileName}`;
      },
    },
    deleteMemory: {
      description: "Delete one obsolete advanced memory Markdown file by name.",
      inputSchema: deleteMemorySchema,
      execute: async (input: unknown) => {
        const { name } = deleteMemorySchema.parse(input);
        return (await store.remove(name)) ? `Deleted ${name}` : `${name} did not exist`;
      },
    },
    regenerateMemoryIndex: {
      description: "Regenerate MEMORY.md for the active advanced memory folder.",
      inputSchema: z.object({}).strict(),
      execute: async () => {
        const index = await store.regenerateIndex();
        return `Regenerated ${index.indexPath} with ${index.entries.length} entries`;
      },
    },
  };
}

export async function runAdvancedMemoryUpdate(opts: {
  config: AgentConfig;
  sessionId: string;
  deltaMessages: ModelMessage[];
  log?: (line: string) => void;
  createRuntimeImpl?: typeof createRuntime;
}): Promise<boolean> {
  if (!(opts.config.enableMemory ?? true) || !(opts.config.advancedMemory ?? false)) return false;
  if (opts.deltaMessages.length === 0) return false;

  const store = AdvancedMemoryStore.fromConfig(opts.config);
  await store.ensureInitialized();
  const indexBefore = await store.readIndex();
  const generatorConfig = resolveGeneratorConfig(opts.config);
  const runtime = (opts.createRuntimeImpl ?? createRuntime)(generatorConfig);
  const now = new Date().toISOString();
  const system = [
    "You are a headless memory maintenance agent.",
    "Read the latest conversation delta and update durable Markdown memories only when useful.",
    "Be conservative: skip noisy, transient, or duplicate facts.",
    "Use frontmatter exactly like:",
    "---",
    "summary: One concise sentence",
    "topics:",
    "  - topic",
    "sourceSessions:",
    `  - ${opts.sessionId}`,
    `updatedAt: ${now}`,
    "---",
    "# Short Memory Title",
    "",
    "Write durable facts, preferences, decisions, and project knowledge. Do not store secrets.",
    "Call regenerateMemoryIndex after any create, edit, or delete. If no changes are needed, answer NO_CHANGES without tool calls.",
  ].join("\n");

  await runtime.runTurn({
    config: generatorConfig,
    system,
    messages: [
      {
        role: "user",
        content: [
          `Session: ${opts.sessionId}`,
          "",
          "Current MEMORY.md index:",
          indexBefore.indexContent.trim() || "# Memory Index",
          "",
          "Conversation delta:",
          compactDelta(opts.deltaMessages),
        ].join("\n"),
      },
    ],
    tools: createAdvancedMemoryTools(store),
    maxSteps: 8,
    providerOptions: generatorConfig.providerOptions,
    log: opts.log,
  });
  await store.regenerateIndex();
  return true;
}
