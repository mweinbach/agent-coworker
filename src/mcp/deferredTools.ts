import { z } from "zod";

import { createToolCatalog, ToolCatalogUnavailableError } from "../runtime/toolCatalog";
import type { RuntimeToolMap } from "../runtime/types";

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

/** Compatibility envelopes over the shared catalog, retaining MCP metadata and transport leases. */
export function createDeferredMcpTools(options: DeferredMcpToolOptions): RuntimeToolMap {
  const catalog = createToolCatalog({
    withTools: (operation) =>
      options.withTools(async (tools, errors) => {
        // The shared catalog checks each executable definition before discovery/dispatch.
        return await operation(options.filterTools(tools) as RuntimeToolMap, errors);
      }),
    assertCanMutate: options.assertCanMutate,
    abortSignal: options.abortSignal,
  });
  return {
    toolSearch: {
      description:
        "Search currently connected MCP tools by name or capability. Returns a limited set of tool names, descriptions, and full input schemas. Call mcpCall with a returned name and arguments matching its inputSchema. Repeat a search when servers change; use nextOffset to browse further matches.",
      inputSchema: searchInputSchema,
      execute: (input, executionOptions) => catalog.search(input, executionOptions),
    },
    mcpCall: {
      description:
        "Call a currently connected MCP tool using its exact name and arguments matching the inputSchema returned by toolSearch. Names discovered earlier in the conversation remain usable while available. Search again if a tool is unavailable or its schema has changed.",
      inputSchema: callInputSchema,
      execute: async (input, executionOptions) => {
        try {
          return await catalog.call(input, executionOptions);
        } catch (error) {
          if (error instanceof ToolCatalogUnavailableError) {
            throw new Error(
              `MCP tool ${JSON.stringify(error.toolName)} is not available. Use toolSearch to find currently available tools.`,
            );
          }
          throw error;
        }
      },
    },
  };
}
