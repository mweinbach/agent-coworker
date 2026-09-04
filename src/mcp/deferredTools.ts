import { z } from "zod";

import type { RuntimeToolDefinition, RuntimeToolMap } from "../runtime/types";
import { raceWithAbort } from "../utils/abortSignal";

const searchInputSchema = z.preprocess(
  (input) => {
    if (!input || typeof input !== "object" || Array.isArray(input)) return input;
    return Object.fromEntries(
      Object.entries(input).filter(
        ([key, value]) => !(value === null && (key === "limit" || key === "offset")),
      ),
    );
  },
  z
    .object({
      query: z
        .string()
        .trim()
        .min(1)
        .max(1000)
        .describe("Tool name or capability keywords; * browses all tools"),
      limit: z.number().int().min(1).max(20).default(5),
      offset: z
        .number()
        .int()
        .min(0)
        .default(0)
        .describe("Result offset for continuing the same search"),
    })
    .strict(),
);

const callInputSchema = z
  .object({
    name: z.string().trim().min(1).describe("Exact MCP tool name returned by toolSearch"),
    arguments: z
      .record(z.string(), z.unknown())
      .describe("Arguments matching the discovered inputSchema"),
  })
  .strict();

type ToolCatalog = Record<string, unknown>;

type DeferredMcpToolOptions = {
  withTools: <T>(operation: (tools: ToolCatalog, errors: string[]) => Promise<T>) => Promise<T>;
  filterTools: (tools: ToolCatalog) => ToolCatalog;
  assertCanMutate?: (toolName: string) => void | Promise<void>;
  abortSignal?: AbortSignal;
};

function toolDefinition(value: unknown): RuntimeToolDefinition | undefined {
  if ((typeof value !== "object" && typeof value !== "function") || value === null)
    return undefined;
  if (!("execute" in value) || typeof value.execute !== "function") return undefined;
  return value as RuntimeToolDefinition;
}

function searchTokens(text: string): string[] {
  return (
    text
      .replace(/([a-z\d])([A-Z])/g, "$1 $2")
      .toLowerCase()
      .match(/[\p{L}\p{N}]+/gu) ?? []
  );
}

function searchScore(name: string, description: string, query: string, tokens: string[]): number {
  if (query === "*") return 1;
  const nameTokens = searchTokens(name);
  const descriptionTokens = searchTokens(description);
  let score = name.toLowerCase() === query.toLowerCase() ? 1000 : 0;
  for (const token of tokens) {
    if (nameTokens.includes(token)) score += 20;
    else if (nameTokens.some((candidate) => candidate.includes(token))) score += 10;
    if (descriptionTokens.includes(token)) score += 4;
    else if (descriptionTokens.some((candidate) => candidate.includes(token))) score += 1;
  }
  return score;
}

function assertActive(signal?: AbortSignal): void {
  if (signal?.aborted) throw new Error("Model turn aborted.");
}

function executionSignal(
  turnSignal?: AbortSignal,
  callSignal?: AbortSignal,
): AbortSignal | undefined {
  if (!turnSignal || !callSignal || turnSignal === callSignal) return turnSignal ?? callSignal;
  return AbortSignal.any([turnSignal, callSignal]);
}

/** Stable model-facing tools whose catalog and transport ownership live outside the turn. */
export function createDeferredMcpTools(options: DeferredMcpToolOptions): RuntimeToolMap {
  return {
    toolSearch: {
      description:
        "Search currently connected MCP tools by name or capability. Returns a limited set of tool names, descriptions, and full input schemas. Call mcpCall with a returned name and arguments matching its inputSchema. Repeat a search when servers change; use nextOffset to browse further matches.",
      inputSchema: searchInputSchema,
      execute: async (input, executionOptions) => {
        const signal = executionSignal(options.abortSignal, executionOptions?.abortSignal);
        assertActive(signal);
        const { query, limit, offset } = searchInputSchema.parse(input);
        return await raceWithAbort(
          options.withTools(async (catalog, errors) => {
            assertActive(signal);
            const tokens = [...new Set(searchTokens(query))];
            const matches = Object.entries(options.filterTools(catalog))
              .flatMap(([name, value]) => {
                const tool = toolDefinition(value);
                if (!tool) return [];
                const description = typeof tool.description === "string" ? tool.description : name;
                const score = searchScore(name, description, query, tokens);
                return score > 0 ? [{ name, description, tool, score }] : [];
              })
              .sort(
                (left, right) =>
                  right.score - left.score ||
                  (left.name < right.name ? -1 : left.name > right.name ? 1 : 0),
              );
            const page = matches.slice(offset, offset + limit);
            return {
              tools: page.map(({ name, description, tool }) => ({
                name,
                description,
                inputSchema: tool.inputSchema ?? { type: "object", properties: {} },
              })),
              total: matches.length,
              ...(offset + page.length < matches.length
                ? { nextOffset: offset + page.length }
                : {}),
              ...(errors.length > 0 ? { errors } : {}),
            };
          }),
          signal,
        );
      },
    },
    mcpCall: {
      description:
        "Call a currently connected MCP tool using its exact name and arguments matching the inputSchema returned by toolSearch. Names discovered earlier in the conversation remain usable while available. Search again if a tool is unavailable or its schema has changed.",
      inputSchema: callInputSchema,
      execute: async (input, executionOptions) => {
        const signal = executionSignal(options.abortSignal, executionOptions?.abortSignal);
        assertActive(signal);
        const { name, arguments: args } = callInputSchema.parse(input);
        let executionStarted = false;
        const invocation = options.withTools(async (catalog) => {
          assertActive(signal);
          const tools = options.filterTools(catalog);
          const tool = Object.hasOwn(tools, name) ? toolDefinition(tools[name]) : undefined;
          if (!tool)
            throw new Error(
              `MCP tool ${JSON.stringify(name)} is not available. Use toolSearch to find currently available tools.`,
            );
          await options.assertCanMutate?.(name);
          assertActive(signal);
          executionStarted = true;
          return await tool.execute(args, signal ? { abortSignal: signal } : undefined);
        });
        try {
          return await raceWithAbort(invocation, signal);
        } catch (error) {
          // Cancellation may stop discovery or authorization immediately. Once
          // dispatched, retain ownership until the tool settles, even if it
          // ignores AbortSignal, so task termination cannot commit too early.
          if (executionStarted) return await invocation;
          throw error;
        }
      },
    },
  };
}
