import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

import { formatZodError } from "../mcp/configRegistry/parser";
import type { MCPServerConfig } from "../types";

const stringMapSchema = z.record(z.string(), z.string());

const stdioTransportSchema = z
  .object({
    type: z.literal("stdio"),
    command: z.string().trim().min(1),
    args: z.array(z.string()).optional(),
    env: stringMapSchema.optional(),
    cwd: z.string().trim().min(1).optional(),
  })
  .strict();

const httpTransportSchema = z
  .object({
    type: z.enum(["http", "sse"]),
    url: z.string().trim().min(1),
    headers: stringMapSchema.optional(),
  })
  .strict();

const transportSchema = z.discriminatedUnion("type", [stdioTransportSchema, httpTransportSchema]);

const authSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("none") }).strict(),
  z
    .object({
      type: z.literal("api_key"),
      headerName: z.string().trim().min(1).optional(),
      prefix: z.string().trim().min(1).optional(),
      keyId: z.string().trim().min(1).optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("oauth"),
      scope: z.string().trim().min(1).optional(),
      resource: z.string().trim().min(1).optional(),
      oauthMode: z.enum(["auto", "code"]).optional(),
    })
    .strict(),
]);

const mcpServerMetaFields = {
  enabled: z.boolean().optional(),
  required: z.boolean().optional(),
  retries: z.number().finite().optional(),
  auth: authSchema.optional(),
  icon: z.string().trim().min(1).optional(),
};

const wrappedMcpServerConfigSchema = z
  .object({
    transport: transportSchema,
    ...mcpServerMetaFields,
  })
  .strict();

const shorthandMcpServerConfigSchema = z.union([
  stdioTransportSchema.extend(mcpServerMetaFields).strict(),
  httpTransportSchema.extend(mcpServerMetaFields).strict(),
]);

const mcpServerConfigSchema = z.union([
  wrappedMcpServerConfigSchema,
  shorthandMcpServerConfigSchema,
]);

const mcpDocumentSchema = z
  .object({
    mcpServers: z.record(z.string().trim().min(1), mcpServerConfigSchema).default({}),
  })
  .strict();

function parsePluginMcpDocument(
  rawJson: string,
  filePath = ".mcp.json",
): { servers: MCPServerConfig[] } {
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
    .map(([name, config]): MCPServerConfig => {
      if ("transport" in config) {
        return { name, ...config };
      }
      const { enabled, required, retries, auth, icon } = config;
      const transport: MCPServerConfig["transport"] =
        "command" in config
          ? {
              type: "stdio",
              command: config.command,
              ...(config.args ? { args: config.args } : {}),
              ...(config.env ? { env: config.env } : {}),
              ...(config.cwd ? { cwd: config.cwd } : {}),
            }
          : {
              type: config.type,
              url: config.url,
              ...(config.headers ? { headers: config.headers } : {}),
            };
      return {
        name,
        transport,
        ...(enabled !== undefined ? { enabled } : {}),
        ...(required !== undefined ? { required } : {}),
        ...(retries !== undefined ? { retries } : {}),
        ...(auth ? { auth } : {}),
        ...(icon ? { icon } : {}),
      };
    })
    .sort((left, right) => left.name.localeCompare(right.name));

  return { servers };
}

export async function readPluginMcpServers(
  mcpPath: string | undefined,
): Promise<MCPServerConfig[]> {
  if (!mcpPath) return [];
  const raw = await fs.readFile(mcpPath, "utf-8");
  return parsePluginMcpDocument(raw, mcpPath).servers;
}
