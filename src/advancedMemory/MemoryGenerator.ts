import path from "node:path";
import fs from "node:fs/promises";

import { normalizeModelIdForProvider } from "../models/metadata";
import { createRuntime } from "../runtime";
import type { AgentConfig, ModelMessage } from "../types";
import { z } from "zod";

import { AdvancedMemoryStore, resolveMemoriesDir, resolveMemoryFolderName } from "./store";

/** Per-tool truncation cap for tool results in the serialized transcript. */
const TOOL_RESULT_CHAR_CAP = 600;
/** Overall cap on the serialized delta handed to the generator. */
const TRANSCRIPT_CHAR_CAP = 24_000;

function truncate(value: string, max: number): string {
  if (value.length <= max) return value;
  return `${value.slice(0, max - 1)}…`;
}

function partText(part: unknown): string {
  if (!part || typeof part !== "object") return "";
  const record = part as Record<string, unknown>;
  if (typeof record.text === "string") return record.text;
  return "";
}

function stringifyToolInput(input: unknown): string {
  if (input == null) return "";
  try {
    return truncate(JSON.stringify(input), 300);
  } catch {
    return "";
  }
}

function stringifyToolOutput(output: unknown): string {
  if (output == null) return "";
  if (typeof output === "string") return output;
  const record = output as Record<string, unknown>;
  if (typeof record.value === "string") return record.value;
  try {
    return JSON.stringify(output);
  } catch {
    return "";
  }
}

/**
 * Render the conversation delta into a compact, token-frugal transcript: user
 * and assistant text, tool calls (name + small args), and truncated tool
 * results. Reasoning is omitted to save tokens.
 */
export function serializeTurnDelta(messages: ModelMessage[]): string {
  const lines: string[] = [];
  for (const message of messages) {
    const role = (message as { role?: string }).role;
    const content = (message as { content?: unknown }).content;
    if (role === "user") {
      const text =
        typeof content === "string"
          ? content
          : Array.isArray(content)
            ? content.map(partText).filter(Boolean).join("")
            : "";
      if (text.trim()) lines.push(`USER: ${text.trim()}`);
      continue;
    }
    if (role === "assistant") {
      if (typeof content === "string") {
        if (content.trim()) lines.push(`ASSISTANT: ${content.trim()}`);
        continue;
      }
      if (!Array.isArray(content)) continue;
      for (const part of content) {
        if (!part || typeof part !== "object") continue;
        const type = (part as Record<string, unknown>).type;
        if (type === "text" || type === "output_text") {
          const text = partText(part).trim();
          if (text) lines.push(`ASSISTANT: ${text}`);
        } else if (type === "tool-call") {
          const record = part as Record<string, unknown>;
          const name = typeof record.toolName === "string" ? record.toolName : "tool";
          const args = stringifyToolInput(record.input ?? record.args);
          lines.push(`ASSISTANT → ${name}(${args})`);
        }
      }
      continue;
    }
    if (role === "tool") {
      if (!Array.isArray(content)) continue;
      for (const part of content) {
        if (!part || typeof part !== "object") continue;
        const record = part as Record<string, unknown>;
        if (record.type !== "tool-result") continue;
        const name = typeof record.toolName === "string" ? record.toolName : "tool";
        const out = truncate(stringifyToolOutput(record.output).trim(), TOOL_RESULT_CHAR_CAP);
        if (out) lines.push(`TOOL[${name}]: ${out}`);
      }
    }
  }
  return truncate(lines.join("\n"), TRANSCRIPT_CHAR_CAP);
}

function hasMeaningfulContent(messages: ModelMessage[]): boolean {
  return messages.some((message) => {
    const role = (message as { role?: string }).role;
    return role === "user" || role === "assistant";
  });
}

export type MemoryGeneratorDeps = {
  createRuntime: typeof createRuntime;
  loadGeneratorPrompt: (config: AgentConfig) => Promise<string>;
};

async function defaultLoadGeneratorPrompt(config: AgentConfig): Promise<string> {
  const promptPath = path.join(config.builtInDir, "prompts", "memory-generator.md");
  return (await fs.readFile(promptPath, "utf-8")).replace(/\r\n?/g, "\n");
}

const defaultMemoryGeneratorDeps: MemoryGeneratorDeps = {
  createRuntime,
  loadGeneratorPrompt: defaultLoadGeneratorPrompt,
};

export type MemoryGeneratorRunOpts = {
  config: AgentConfig;
  sessionId: string;
  deltaMessages: ModelMessage[];
  log?: (line: string) => void;
  abortSignal?: AbortSignal;
  /** Override the resolved store (testing). */
  store?: AdvancedMemoryStore;
  /** Override the resolved folder (testing). */
  folder?: string;
};

/**
 * Headless agent that maintains the advanced (file-based) memory tree after each
 * turn. Mirrors `DelegateRunner` but with a dedicated prompt and a minimal,
 * Zod-enforced tool surface bound to a single memory folder.
 */
export class MemoryGenerator {
  constructor(private readonly deps: MemoryGeneratorDeps = defaultMemoryGeneratorDeps) {}

  private resolveModel(config: AgentConfig): string {
    const requested =
      config.memoryGenerationModel?.trim() || config.preferredChildModel || config.model;
    try {
      return normalizeModelIdForProvider(config.provider, requested, "memory generation model");
    } catch {
      return config.model;
    }
  }

  async run(opts: MemoryGeneratorRunOpts): Promise<{ ran: boolean }> {
    const log = opts.log ?? (() => {});
    if (!hasMeaningfulContent(opts.deltaMessages)) {
      return { ran: false };
    }
    const transcript = serializeTurnDelta(opts.deltaMessages);
    if (!transcript.trim()) return { ran: false };

    const store =
      opts.store ?? new AdvancedMemoryStore(resolveMemoriesDir(opts.config));
    const folder = opts.folder ?? resolveMemoryFolderName(opts.config);

    const tools = this.buildTools(store, folder, opts.sessionId);
    const system = await this.deps.loadGeneratorPrompt(opts.config);
    const model = this.resolveModel(opts.config);
    const genConfig: AgentConfig = { ...opts.config, model };

    const userMessage =
      `Active memory folder: ${folder}\n\n` +
      `Conversation delta since memory was last updated:\n\n${transcript}`;

    try {
      const runtime = this.deps.createRuntime(genConfig);
      await runtime.runTurn({
        config: genConfig,
        system,
        messages: [{ role: "user", content: userMessage }] as ModelMessage[],
        tools,
        maxSteps: 8,
        providerOptions: genConfig.providerOptions,
        abortSignal: opts.abortSignal,
        log: (line) => log(`[memory] ${line}`),
        enableMcp: false,
      } as Parameters<ReturnType<typeof createRuntime>["runTurn"]>[0]);
      return { ran: true };
    } catch (error) {
      log(`[memory] generation failed: ${String(error)}`);
      return { ran: false };
    }
  }

  private buildTools(store: AdvancedMemoryStore, folder: string, sessionId: string) {
    return {
      list_memories: {
        description: "List existing memories in the active folder (slug, name, description, type).",
        inputSchema: z.object({}),
        execute: async () => {
          const entries = await store.listMemories(folder);
          return entries.map((e) => ({
            slug: e.slug,
            name: e.name,
            description: e.description,
            type: e.type,
          }));
        },
      },
      read_memory: {
        description: "Read the full content of an existing memory by slug.",
        inputSchema: z.object({ slug: z.string() }),
        execute: async ({ slug }: { slug: string }) => {
          const entry = await store.readMemory(folder, slug);
          if (!entry) return { found: false };
          return { found: true, ...entry };
        },
      },
      write_memory: {
        description:
          "Create or overwrite a memory. Use for genuinely new topics; prefer edit_memory to refine existing ones.",
        inputSchema: z.object({
          slug: z.string().optional(),
          name: z.string(),
          description: z.string(),
          type: z.enum(["feedback", "project", "note"]).optional(),
          body: z.string(),
        }),
        execute: async (input: {
          slug?: string;
          name: string;
          description: string;
          type?: "feedback" | "project" | "note";
          body: string;
        }) => {
          const entry = await store.writeMemory(folder, {
            ...input,
            originSessionId: sessionId,
          });
          return { ok: true, slug: entry.slug };
        },
      },
      edit_memory: {
        description: "Refine, extend, or correct an existing memory by slug.",
        inputSchema: z.object({
          slug: z.string(),
          name: z.string().optional(),
          description: z.string().optional(),
          type: z.enum(["feedback", "project", "note"]).optional(),
          body: z.string().optional(),
        }),
        execute: async (input: {
          slug: string;
          name?: string;
          description?: string;
          type?: "feedback" | "project" | "note";
          body?: string;
        }) => {
          const entry = await store.editMemory(folder, input.slug, {
            ...input,
            originSessionId: sessionId,
          });
          if (!entry) return { ok: false, reason: "not_found" };
          return { ok: true, slug: entry.slug };
        },
      },
      finish: {
        description: "Signal that memory maintenance is complete. Call this when done.",
        inputSchema: z.object({ note: z.string().optional() }),
        execute: async () => ({ ok: true }),
      },
    };
  }
}
