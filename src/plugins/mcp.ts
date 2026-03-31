import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

import type { MCPServerConfig } from "../types";
import { isPathInside } from "../utils/paths";
import { isRecord } from "../utils/typeGuards";

const stringMapSchema = z.record(z.string(), z.string());

const stdioTransportSchema = z.object({
  type: z.literal("stdio"),
  command: z.string().trim().min(1),
  args: z.array(z.string()).optional(),
  env: stringMapSchema.optional(),
  cwd: z.string().trim().min(1).optional(),
}).strict();

const httpTransportSchema = z.object({
  type: z.enum(["http", "sse"]),
  url: z.string().trim().min(1),
  headers: stringMapSchema.optional(),
}).strict();

const transportSchema = z.discriminatedUnion("type", [stdioTransportSchema, httpTransportSchema]);

const authSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("none") }).strict(),
  z.object({
    type: z.literal("api_key"),
    headerName: z.string().trim().min(1).optional(),
    prefix: z.string().trim().min(1).optional(),
    keyId: z.string().trim().min(1).optional(),
  }).strict(),
  z.object({
    type: z.literal("oauth"),
    scope: z.string().trim().min(1).optional(),
    resource: z.string().trim().min(1).optional(),
    oauthMode: z.enum(["auto", "code"]).optional(),
  }).strict(),
]);

const mcpServerConfigSchema = z.object({
  transport: transportSchema,
  required: z.boolean().optional(),
  retries: z.number().finite().optional(),
  auth: authSchema.optional(),
}).strict();

const mcpDocumentSchema = z.object({
  mcpServers: z.record(z.string().trim().min(1), mcpServerConfigSchema).default({}),
}).strict();

function formatZodError(error: z.ZodError): string {
  const issue = error.issues[0];
  if (!issue) return "validation failed";
  const issuePath = issue.path.length > 0 ? issue.path.join(".") : "root";
  return `${issuePath}: ${issue.message}`;
}

export function parsePluginMcpDocument(rawJson: string, filePath = ".mcp.json"): { servers: MCPServerConfig[] } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawJson);
  } catch (error) {
    throw new Error(`${path.basename(filePath)}: invalid JSON: ${String(error)}`);
  }

  const validated = mcpDocumentSchema.safeParse(parsed);
  if (!validated.success) {
    throw new Error(`${path.basename(filePath)}: ${formatZodError(validated.error)}`);
  }

  const servers = Object.entries(validated.data.mcpServers)
    .map(([name, config]) => ({ name, ...config }))
    .sort((left, right) => left.name.localeCompare(right.name));

  return { servers };
}

function coerceAppPathSummary(value: unknown): string[] {
  if (typeof value === "string" && value.trim().length > 0) {
    return [value.trim()];
  }
  if (Array.isArray(value)) {
    return value
      .filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
      .map((entry) => entry.trim());
  }
  if (isRecord(value)) {
    return Object.keys(value);
  }
  return [];
}

export async function readPluginMcpServerNames(mcpPath: string | undefined): Promise<string[]> {
  if (!mcpPath) return [];
  try {
    const raw = await fs.readFile(mcpPath, "utf-8");
    return parsePluginMcpDocument(raw, mcpPath).servers.map((server) => server.name);
  } catch {
    return [];
  }
}

export async function readPluginMcpServers(mcpPath: string | undefined): Promise<MCPServerConfig[]> {
  if (!mcpPath) return [];
  const raw = await fs.readFile(mcpPath, "utf-8");
  return parsePluginMcpDocument(raw, mcpPath).servers;
}

export async function readPluginAppIds(appPath: string | undefined): Promise<string[]> {
  if (!appPath) return [];
  try {
    const raw = await fs.readFile(appPath, "utf-8");
    const parsed = JSON.parse(raw);
    if (!isRecord(parsed)) return [];
    return coerceAppPathSummary(parsed.apps ?? parsed).sort((left, right) => left.localeCompare(right));
  } catch {
    return [];
  }
}

export function validatePluginMcpPath(pluginRoot: string, mcpPath: string | undefined): string | null {
  if (!mcpPath) return null;
  const resolved = path.resolve(mcpPath);
  if (!isPathInside(pluginRoot, resolved)) {
    return `Plugin MCP path resolves outside plugin root: ${resolved}`;
  }
  return null;
}
