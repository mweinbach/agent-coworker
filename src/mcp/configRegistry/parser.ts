import { z } from "zod";

import type { MCPServerConfig } from "../../types";

const stringMap = z.record(z.string(), z.string());

const stdioTransport = z.object({
  type: z.literal("stdio"),
  command: z.string().trim().min(1),
  args: z.array(z.string()).optional(),
  env: stringMap.optional(),
  cwd: z.string().trim().min(1).optional(),
});

const httpTransport = z.object({
  type: z.enum(["http", "sse"]),
  url: z.string().trim().min(1),
  headers: stringMap.optional(),
});

const transportSchema = z.discriminatedUnion("type", [stdioTransport, httpTransport]);

const authSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("none") }),
  z.object({
    type: z.literal("api_key"),
    headerName: z.string().trim().min(1).optional(),
    prefix: z.string().trim().min(1).optional(),
    keyId: z.string().trim().min(1).optional(),
  }),
  z.object({
    type: z.literal("oauth"),
    scope: z.string().trim().min(1).optional(),
    resource: z.string().trim().min(1).optional(),
    oauthMode: z.enum(["auto", "code"]).optional(),
  }),
]);

const mcpServerSchema = z.object({
  name: z.string().trim().min(1),
  transport: transportSchema,
  required: z.boolean().optional(),
  retries: z.number().finite().optional(),
  auth: authSchema.optional(),
});

const mcpServersDocumentSchema = z.object({
  servers: z.array(mcpServerSchema).default([]),
});

const DEFAULT_MCP_SERVERS = { servers: [] } as const;
export const DEFAULT_MCP_SERVERS_DOCUMENT = `${JSON.stringify(DEFAULT_MCP_SERVERS, null, 2)}\n`;

function formatZodError(error: z.ZodError): string {
  const issue = error.issues[0];
  if (!issue) return "validation failed";
  const path = issue.path.length > 0 ? issue.path.join(".") : "root";
  return `${path}: ${issue.message}`;
}

export function parseMCPServersDocument(rawJson: string): { servers: MCPServerConfig[] } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawJson);
  } catch (error) {
    throw new Error(`mcp-servers.json: invalid JSON: ${String(error)}`);
  }

  const result = mcpServersDocumentSchema.safeParse(parsed);
  if (!result.success) {
    throw new Error(`mcp-servers.json: ${formatZodError(result.error)}`);
  }

  return { servers: result.data.servers };
}

export function parseMCPServerConfig(raw: unknown): MCPServerConfig {
  const result = mcpServerSchema.safeParse(raw);
  if (!result.success) {
    throw new Error(`mcp-servers.json: ${formatZodError(result.error)}`);
  }
  return result.data;
}
