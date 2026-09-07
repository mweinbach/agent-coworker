import { z } from "zod";

import { raceWithAbort } from "../utils/abortSignal";
import { isZodSchema } from "./piRuntimeOptions";
import type { RuntimeToolDefinition, RuntimeToolExecutionOptions, RuntimeToolMap } from "./types";

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
      offset: z.number().int().min(0).default(0).describe("Result offset for the same search"),
    })
    .strict(),
);

const callInputSchema = z
  .object({
    name: z.string().trim().min(1).describe("Exact tool name returned by toolSearch"),
    arguments: z
      .record(z.string(), z.unknown())
      .describe("Arguments matching the discovered inputSchema"),
  })
  .strict();

export type ToolCatalogOptions = {
  /** Supplies current, already authority-filtered tools and owns their leases until completion. */
  withTools: <T>(operation: (tools: RuntimeToolMap, errors: string[]) => Promise<T>) => Promise<T>;
  assertCanMutate?: (toolName: string) => void | Promise<void>;
  abortSignal?: AbortSignal;
};

export type ToolCatalogSearchResult = {
  tools: Array<{ name: string; description: string; inputSchema: unknown }>;
  total: number;
  nextOffset?: number;
  errors?: string[];
};

/** Allows host adapters to retain their unavailable-tool wording without rewriting tool failures. */
export class ToolCatalogUnavailableError extends Error {
  constructor(readonly toolName: string) {
    super(
      `Tool ${JSON.stringify(toolName)} is not available. Use toolSearch to find currently available tools.`,
    );
  }
}

const reservedNames = new Set(["toolSearch", "toolCall", "codeMode", "prototype"]);

function callableName(name: string): boolean {
  return !reservedNames.has(name) && !Object.hasOwn(Object.prototype, name);
}

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
  let score = 0;
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

function inputJsonSchema(inputSchema: unknown): unknown {
  // Match direct runtime schema conversion, including schemas with preprocessing.
  // Never return a Zod instance: tool outputs cross JSON/stream boundaries.
  return isZodSchema(inputSchema)
    ? z.toJSONSchema(inputSchema)
    : (inputSchema ?? { type: "object", properties: {} });
}

function validateInput(tool: RuntimeToolDefinition, input: unknown): unknown {
  // Direct runtimes validate Zod schemas (including their null/default preprocessing).
  // JSON Schema-backed tools retain their transport/execute-owned validation.
  if (!isZodSchema(tool.inputSchema)) return input;
  const parsed = tool.inputSchema.safeParse(input);
  if (parsed.success) return parsed.data;
  throw new Error(parsed.error.issues[0]?.message ?? "Invalid tool input.");
}

/** Provider-neutral discovery and dispatch over a fresh, externally owned filtered catalog. */
export function createToolCatalog(options: ToolCatalogOptions) {
  const catalog = {
    async resolveTools(names: readonly string[]): Promise<RuntimeToolMap> {
      assertActive(options.abortSignal);
      return await raceWithAbort(
        options.withTools(async (tools) => {
          assertActive(options.abortSignal);
          return Object.fromEntries(
            [...new Set(names)].flatMap((name) => {
              const tool =
                callableName(name) && Object.hasOwn(tools, name)
                  ? toolDefinition(tools[name])
                  : undefined;
              if (!tool) return [];
              // Retain only schema metadata, never an execute closure whose MCP
              // lease ends with this snapshot. Dispatch acquires a fresh lease,
              // definition, validator, and authority check.
              return [
                [
                  name,
                  {
                    description: tool.description,
                    inputSchema: tool.inputSchema,
                    constrainedSampling: tool.constrainedSampling,
                    executionPolicy: "sequential" as const,
                    execute: (input: unknown, executionOptions?: RuntimeToolExecutionOptions) =>
                      catalog.call({ name, arguments: input }, executionOptions),
                  },
                ],
              ];
            }),
          );
        }),
        options.abortSignal,
      );
    },
    async search(
      input: unknown,
      executionOptions?: RuntimeToolExecutionOptions,
    ): Promise<ToolCatalogSearchResult> {
      const signal = executionSignal(options.abortSignal, executionOptions?.abortSignal);
      assertActive(signal);
      const { query, limit, offset } = searchInputSchema.parse(input);
      return await raceWithAbort(
        options.withTools(async (tools, errors) => {
          assertActive(signal);
          const tokens = [...new Set(searchTokens(query))];
          const matches = Object.entries(tools)
            .flatMap(([name, value]) => {
              if (!callableName(name)) return [];
              const tool = toolDefinition(value);
              if (!tool) return [];
              const description = typeof tool.description === "string" ? tool.description : name;
              const exact = name.toLowerCase() === query.toLowerCase();
              const score = searchScore(name, description, query, tokens);
              return exact || score > 0 ? [{ name, description, tool, score, exact }] : [];
            })
            .sort(
              (left, right) =>
                Number(right.exact) - Number(left.exact) ||
                right.score - left.score ||
                (left.name < right.name ? -1 : left.name > right.name ? 1 : 0),
            );
          const page = matches.slice(offset, offset + limit);
          const result = {
            tools: page.map(({ name, description, tool }) => ({
              name,
              description,
              inputSchema: inputJsonSchema(tool.inputSchema),
            })),
            total: matches.length,
            ...(offset + page.length < matches.length ? { nextOffset: offset + page.length } : {}),
            ...(errors.length > 0 ? { errors: [...errors] } : {}),
          };
          executionOptions?.onToolsDiscovered?.(result.tools.map(({ name }) => name));
          return result;
        }),
        signal,
      );
    },
    async call(input: unknown, executionOptions?: RuntimeToolExecutionOptions): Promise<unknown> {
      const signal = executionSignal(options.abortSignal, executionOptions?.abortSignal);
      assertActive(signal);
      const { name, arguments: args } = callInputSchema.parse(input);
      let executionStarted = false;
      const invocation = options.withTools(async (tools) => {
        assertActive(signal);
        const tool =
          callableName(name) && Object.hasOwn(tools, name)
            ? toolDefinition(tools[name])
            : undefined;
        if (!tool) throw new ToolCatalogUnavailableError(name);
        const parsedInput = validateInput(tool, args);
        await options.assertCanMutate?.(name);
        assertActive(signal);
        executionStarted = true;
        return await tool.execute(
          parsedInput,
          signal ? { ...executionOptions, abortSignal: signal } : executionOptions,
        );
      });
      try {
        return await raceWithAbort(invocation, signal);
      } catch (error) {
        // Discovery/authorization can be abandoned promptly. A dispatched call
        // must settle before its turn and transport lease can be released,
        // even when the underlying tool ignores cancellation.
        if (executionStarted) return await invocation;
        throw error;
      }
    },
  };
  return catalog;
}

export type ToolCatalog = ReturnType<typeof createToolCatalog>;

/** Stable envelopes; discovery does not register tools or cache schemas between calls. */
export function createDeferredToolTools(catalog: ToolCatalog): RuntimeToolMap {
  return {
    toolSearch: {
      description:
        "Search currently available tools by name or capability. Returns a limited set of names, descriptions, and full input schemas. Use toolCall with a returned name and matching arguments. Use nextOffset to browse more matches; search again when tools change.",
      inputSchema: searchInputSchema,
      execute: (input, options) => catalog.search(input, options),
    },
    toolCall: {
      description:
        "Call a currently available tool using its exact name and arguments matching the inputSchema returned by toolSearch. Previously discovered names remain usable while available. Search again if a tool is unavailable or its schema has changed.",
      inputSchema: callInputSchema,
      execute: (input, options) => catalog.call(input, options),
    },
  };
}
