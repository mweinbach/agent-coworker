/**
 * Adapts tool definitions between agent-coworker and pi framework formats.
 *
 * Pi uses `AgentTool` with TypeBox schemas and a specific `execute` signature:
 *   execute(toolCallId, params, signal?, onUpdate?) => Promise<AgentToolResult>
 *
 * Our tools currently return plain values from `execute`. This adapter bridges the gap.
 */

import { Type, type TSchema } from "@sinclair/typebox";
import type {
  AgentTool,
  AgentToolResult,
  AgentToolUpdateCallback,
  TextContent,
  ImageContent,
} from "./types";

/**
 * Simplified tool definition used during migration.
 * Tools provide a TypeBox schema and an execute function that returns arbitrary data.
 * The adapter wraps the result into pi's `AgentToolResult` format.
 */
export interface SimpleToolDef<TParameters extends TSchema = TSchema> {
  name: string;
  label?: string;
  description: string;
  parameters: TParameters;
  execute: (params: Record<string, any>, signal?: AbortSignal) => Promise<unknown>;
}

/**
 * Converts a `SimpleToolDef` into a pi `AgentTool`.
 *
 * The key difference is that pi expects `execute` to return `AgentToolResult`
 * with `{ content: (TextContent | ImageContent)[], details: any }`.
 * Our tools return plain strings or objects — this wrapper serializes them.
 */
export function toAgentTool<T extends TSchema>(def: SimpleToolDef<T>): AgentTool<T> {
  return {
    name: def.name,
    label: def.label ?? def.name,
    description: def.description,
    parameters: def.parameters,
    execute: async (
      _toolCallId: string,
      params: Record<string, any>,
      signal?: AbortSignal,
      _onUpdate?: AgentToolUpdateCallback,
    ): Promise<AgentToolResult<any>> => {
      const raw = await def.execute(params, signal);
      return wrapToolResult(raw);
    },
  };
}

/**
 * Wraps an arbitrary tool return value into pi's `AgentToolResult` format.
 */
export function wrapToolResult(raw: unknown): AgentToolResult<any> {
  if (raw === undefined || raw === null) {
    return {
      content: [{ type: "text", text: "" } as TextContent],
      details: {},
    };
  }

  if (typeof raw === "string") {
    return {
      content: [{ type: "text", text: raw } as TextContent],
      details: {},
    };
  }

  // If the value already looks like an AgentToolResult, pass it through.
  if (isAgentToolResult(raw)) {
    return raw;
  }

  // For objects/arrays, serialize to JSON text content.
  const text = JSON.stringify(raw);
  return {
    content: [{ type: "text", text } as TextContent],
    details: raw,
  };
}

function isAgentToolResult(v: unknown): v is AgentToolResult<any> {
  if (typeof v !== "object" || v === null) return false;
  const obj = v as Record<string, unknown>;
  return Array.isArray(obj.content) && obj.content.length > 0;
}

/**
 * Converts a record of `AgentTool` objects (keyed by name) into the array
 * format that pi expects.
 */
export function toolRecordToArray(tools: Record<string, AgentTool>): AgentTool[] {
  return Object.values(tools);
}

/**
 * Converts a pi `AgentTool[]` back to a name-keyed record (for MCP merging, etc.).
 */
export function toolArrayToRecord(tools: AgentTool[]): Record<string, AgentTool> {
  const record: Record<string, AgentTool> = {};
  for (const tool of tools) {
    record[tool.name] = tool;
  }
  return record;
}

/**
 * Wraps an AI SDK tool (from @ai-sdk/mcp) into a pi AgentTool.
 *
 * AI SDK tools have: { description, parameters (Zod/JSON Schema), execute(args, opts?) }
 * Pi tools expect:    { name, label, description, parameters (TypeBox), execute(toolCallId, params, signal?, onUpdate?) }
 *
 * We use Type.Unsafe() for the parameters schema as a passthrough, since MCP servers
 * handle their own validation and the parameter schema is only used for LLM guidance.
 */
export function wrapAiSdkTool(name: string, tool: Record<string, any>): AgentTool {
  // Extract the JSON Schema from the AI SDK tool's parameters.
  // AI SDK tools store schema either as .jsonSchema or via Zod .shape.
  const jsonSchema = tool.parameters?.jsonSchema ?? tool.parameters ?? {};

  return {
    name,
    label: name,
    description: tool.description ?? "",
    // Use Type.Unsafe with the raw JSON schema so pi passes it through to the LLM.
    parameters: Type.Unsafe(jsonSchema),
    execute: async (
      _toolCallId: string,
      params: unknown,
      signal?: AbortSignal,
      _onUpdate?: AgentToolUpdateCallback,
    ): Promise<AgentToolResult<any>> => {
      // AI SDK tools accept (args, options?) where options may include { abortSignal }.
      const raw = await tool.execute(params, signal ? { abortSignal: signal } : undefined);
      return wrapToolResult(raw);
    },
  } as AgentTool;
}

/**
 * Converts a record of AI SDK MCP tools into a record of pi AgentTools.
 */
export function wrapMcpToolRecord(tools: Record<string, unknown>): Record<string, AgentTool> {
  const record: Record<string, AgentTool> = {};
  for (const [name, tool] of Object.entries(tools)) {
    if (typeof tool === "object" && tool !== null && "execute" in tool) {
      record[name] = wrapAiSdkTool(name, tool as Record<string, any>);
    }
  }
  return record;
}
