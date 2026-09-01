import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { parseChildModelRef } from "../models/childModelRouting";
import { createRuntime } from "../runtime";
import { type AgentConfig, defaultRuntimeNameForProvider, type ModelMessage } from "../types";
import { raceWithAbort } from "../utils/abortSignal";

import { AdvancedMemoryStore, resolveMemoriesDir, resolveMemoryFolderName } from "./store";

/** Per-tool truncation cap for tool results in the serialized transcript. */
const TOOL_RESULT_CHAR_CAP = 600;
/** Cap on each transcript batch handed to the generator. */
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
function serializeMessages(messages: ModelMessage[]): string {
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
  return lines.join("\n");
}

/** Compact preview used by transcript tools and skill-improvement evidence. */
export function serializeTurnDelta(messages: ModelMessage[]): string {
  return truncate(serializeMessages(messages), TRANSCRIPT_CHAR_CAP);
}

type MemoryTranscriptBatch = {
  transcript: string;
  processedMessageCount: number;
  fragmentRole?: string;
};

/** Preserve whole messages where possible; oversized messages are retried until every part succeeds. */
function* memoryTranscriptBatches(messages: ModelMessage[]): Generator<MemoryTranscriptBatch> {
  let transcript = "";
  let processedMessageCount = 0;
  for (const [index, message] of messages.entries()) {
    const rendered = serializeMessages([message]);
    if (!rendered) {
      processedMessageCount = index + 1;
      continue;
    }
    if (transcript && transcript.length + 1 + rendered.length > TRANSCRIPT_CHAR_CAP) {
      yield { transcript, processedMessageCount };
      transcript = "";
    }
    if (rendered.length > TRANSCRIPT_CHAR_CAP) {
      for (let offset = 0; offset < rendered.length; ) {
        let end = Math.min(offset + TRANSCRIPT_CHAR_CAP, rendered.length);
        const lastCodeUnit = rendered.charCodeAt(end - 1);
        if (end < rendered.length && lastCodeUnit >= 0xd800 && lastCodeUnit <= 0xdbff) end -= 1;
        yield {
          transcript: rendered.slice(offset, end),
          // A successful fragment cannot checkpoint the rest of its message.
          processedMessageCount: end === rendered.length ? index + 1 : index,
          fragmentRole: message.role,
        };
        offset = end;
      }
    } else {
      transcript += `${transcript ? "\n" : ""}${rendered}`;
    }
    processedMessageCount = index + 1;
  }
  if (transcript) yield { transcript, processedMessageCount };
}

function hasMeaningfulContent(messages: ModelMessage[]): boolean {
  return messages.some((message) => {
    const role = (message as { role?: string }).role;
    return role === "user" || role === "assistant";
  });
}

function hasAssistantMessage(messages: ModelMessage[]): boolean {
  return messages.some((message) => (message as { role?: string }).role === "assistant");
}

/**
 * Split an existing transcript into the same shape the automatic generator sees
 * after each completed assistant response. A follow-up begins with a user
 * message after a previous assistant response; tool messages stay attached to
 * the assistant turn that produced them.
 */
export function splitMessagesForMemoryBackfill(messages: ModelMessage[]): ModelMessage[][] {
  const chunks: ModelMessage[][] = [];
  let current: ModelMessage[] = [];

  for (const message of messages) {
    const role = (message as { role?: string }).role;
    if (role === "user" && current.length > 0 && hasAssistantMessage(current)) {
      chunks.push(current);
      current = [message];
      continue;
    }
    current.push(message);
  }

  if (hasAssistantMessage(current)) {
    chunks.push(current);
  }
  return chunks;
}

export type MemoryGeneratorDeps = {
  createRuntime: typeof createRuntime;
  loadGeneratorPrompt: (config: AgentConfig) => Promise<string>;
  loadConsolidatorPrompt?: (config: AgentConfig) => Promise<string>;
};

async function defaultLoadGeneratorPrompt(config: AgentConfig): Promise<string> {
  const promptPath = path.join(config.builtInDir, "prompts", "memory-generator.md");
  return (await fs.readFile(promptPath, "utf-8")).replace(/\r\n?/g, "\n");
}

async function defaultLoadConsolidatorPrompt(config: AgentConfig): Promise<string> {
  const promptPath = path.join(config.builtInDir, "prompts", "memory-consolidator.md");
  return (await fs.readFile(promptPath, "utf-8")).replace(/\r\n?/g, "\n");
}

const defaultMemoryGeneratorDeps: MemoryGeneratorDeps = {
  createRuntime,
  loadGeneratorPrompt: defaultLoadGeneratorPrompt,
  loadConsolidatorPrompt: defaultLoadConsolidatorPrompt,
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

export type MemoryConsolidatorRunOpts = Omit<MemoryGeneratorRunOpts, "deltaMessages">;

export type MemoryGeneratorRunResult = {
  /** At least one batch completed, possibly before a later failure. */
  ran: boolean;
  /** Every batch completed, or the delta intentionally contained nothing to process. */
  ok: boolean;
  /** Contiguous complete input messages processed successfully; never includes a partial message. */
  processedMessageCount: number;
};

/**
 * Headless agent that maintains the advanced (file-based) memory tree after each
 * turn. Mirrors `DelegateRunner` but with a dedicated prompt and a minimal,
 * Zod-enforced tool surface bound to a single memory folder.
 */
export class MemoryGenerator {
  constructor(private readonly deps: MemoryGeneratorDeps = defaultMemoryGeneratorDeps) {}

  private resolveTargetConfig(config: AgentConfig): AgentConfig {
    const requested =
      config.memoryGenerationModel?.trim() ||
      config.preferredChildModelRef?.trim() ||
      config.preferredChildModel ||
      config.model;
    try {
      const parsed = parseChildModelRef(requested, config.provider, "memory generation model");
      return {
        ...config,
        provider: parsed.provider,
        runtime: defaultRuntimeNameForProvider(parsed.provider),
        model: parsed.modelId,
      };
    } catch {
      return config;
    }
  }

  /**
   * Runs ordered, bounded transcript batches. Failures leave the incomplete
   * suffix unprocessed; callers may checkpoint only processedMessageCount.
   * Empty or tool-only deltas are intentional no-ops. Never throws.
   */
  async run(opts: MemoryGeneratorRunOpts): Promise<MemoryGeneratorRunResult> {
    const log = opts.log ?? (() => {});
    let processedMessageCount = 0;
    let ran = false;
    try {
      opts.abortSignal?.throwIfAborted();
      if (!hasMeaningfulContent(opts.deltaMessages)) {
        return { ran: false, ok: true, processedMessageCount: opts.deltaMessages.length };
      }
      const store = opts.store ?? new AdvancedMemoryStore(resolveMemoriesDir(opts.config));
      const folder = opts.folder ?? resolveMemoryFolderName(opts.config);
      const tools = this.buildTools(store, folder, opts.sessionId);
      const genConfig = this.resolveTargetConfig(opts.config);
      let system: string | undefined;
      let batchNumber = 0;
      for (const batch of memoryTranscriptBatches(opts.deltaMessages)) {
        opts.abortSignal?.throwIfAborted();
        system ??= await this.deps.loadGeneratorPrompt(opts.config);
        opts.abortSignal?.throwIfAborted();
        const userMessage =
          `Active memory folder: ${folder}\n\n` +
          `Batch ${++batchNumber} of an ordered conversation delta. Read existing memories before updating them.\n` +
          (batch.fragmentRole
            ? `This batch contains a fragment of one ${batch.fragmentRole} message; later batches may continue it.\n`
            : "") +
          `\nConversation delta since memory was last updated:\n\n${batch.transcript}`;
        const runtime = this.deps.createRuntime(genConfig);
        let modelAborted = false;
        await raceWithAbort(
          runtime.runTurn({
            config: genConfig,
            system,
            messages: [{ role: "user", content: userMessage }] as ModelMessage[],
            tools,
            maxSteps: 8,
            providerOptions: genConfig.providerOptions,
            abortSignal: opts.abortSignal,
            onModelAbort: () => {
              modelAborted = true;
            },
            log: (line) => log(`[memory] ${line}`),
            enableMcp: false,
          } as Parameters<ReturnType<typeof createRuntime>["runTurn"]>[0]),
          opts.abortSignal,
          "Memory generation aborted.",
        );
        opts.abortSignal?.throwIfAborted();
        if (modelAborted) throw new Error("Memory generation aborted.");
        processedMessageCount = batch.processedMessageCount;
        ran = true;
      }
      return { ran, ok: true, processedMessageCount: opts.deltaMessages.length };
    } catch (error) {
      log(`[memory] generation failed: ${String(error)}`);
      return { ran, ok: false, processedMessageCount };
    }
  }

  /**
   * Runs a reflective cleanup over the active memory folder. `ok` is false only
   * when setup or the runtime failed; empty folders resolve `{ ran: false, ok: true }`.
   * Never throws.
   */
  async consolidate(opts: MemoryConsolidatorRunOpts): Promise<{ ran: boolean; ok: boolean }> {
    const log = opts.log ?? (() => {});
    try {
      opts.abortSignal?.throwIfAborted();
      const store = opts.store ?? new AdvancedMemoryStore(resolveMemoriesDir(opts.config));
      const folder = opts.folder ?? resolveMemoryFolderName(opts.config);
      const memories = await store.listMemories(folder);
      if (memories.length === 0) {
        return { ran: false, ok: true };
      }

      const index = await store.renderIndex(folder);
      const tools = this.buildTools(store, folder, opts.sessionId, {
        includeConsolidationTools: true,
      });
      const system = await (this.deps.loadConsolidatorPrompt ?? defaultLoadConsolidatorPrompt)(
        opts.config,
      );
      const genConfig = this.resolveTargetConfig(opts.config);
      const userMessage = [
        `Active memory folder: ${folder}`,
        `Current MEMORY.md index:\n\n${index || "(empty)"}`,
        `Memory file count: ${memories.length}`,
        "Run one consolidation pass now.",
      ].join("\n\n");

      opts.abortSignal?.throwIfAborted();
      const runtime = this.deps.createRuntime(genConfig);
      let modelAborted = false;
      await raceWithAbort(
        runtime.runTurn({
          config: genConfig,
          system,
          messages: [{ role: "user", content: userMessage }] as ModelMessage[],
          tools,
          maxSteps: 20,
          providerOptions: genConfig.providerOptions,
          abortSignal: opts.abortSignal,
          onModelAbort: () => {
            modelAborted = true;
          },
          log: (line) => log(`[memory] ${line}`),
          enableMcp: false,
        } as Parameters<ReturnType<typeof createRuntime>["runTurn"]>[0]),
        opts.abortSignal,
        "Memory consolidation aborted.",
      );
      opts.abortSignal?.throwIfAborted();
      if (modelAborted) throw new Error("Memory consolidation aborted.");
      return { ran: true, ok: true };
    } catch (error) {
      log(`[memory] consolidation failed: ${String(error)}`);
      return { ran: false, ok: false };
    }
  }

  private buildTools(
    store: AdvancedMemoryStore,
    folder: string,
    sessionId: string,
    opts: { includeConsolidationTools?: boolean } = {},
  ) {
    return {
      ...(opts.includeConsolidationTools
        ? {
            read_index: {
              description: "Read the generated MEMORY.md index for the active folder.",
              inputSchema: z.object({}),
              execute: async () => await store.renderIndex(folder),
            },
          }
        : {}),
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
      ...(opts.includeConsolidationTools
        ? {
            delete_memory: {
              description: "Delete a stale or duplicate memory by slug.",
              inputSchema: z.object({ slug: z.string() }),
              execute: async ({ slug }: { slug: string }) => ({
                ok: await store.deleteMemory(folder, slug),
              }),
            },
          }
        : {}),
      finish: {
        description: "Signal that memory maintenance is complete. Call this when done.",
        inputSchema: z.object({ note: z.string().optional() }),
        execute: async () => ({ ok: true }),
      },
    };
  }
}
