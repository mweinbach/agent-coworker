import path from "node:path";
import { z } from "zod";

import { isPathInside, resolveMaybeRelative } from "../utils/paths";

const nonEmptyTrimmedStringSchema = z.string().trim().min(1);

const marketplaceSourceSchema = z.object({
  source: z.literal("local"),
  path: nonEmptyTrimmedStringSchema,
}).strict();

const marketplacePluginPolicySchema = z.object({
  installation: nonEmptyTrimmedStringSchema,
  authentication: nonEmptyTrimmedStringSchema,
}).strict();

const marketplacePluginInterfaceSchema = z.object({
  displayName: nonEmptyTrimmedStringSchema.optional(),
}).strict();

const marketplacePluginEntrySchema = z.object({
  name: nonEmptyTrimmedStringSchema,
  source: marketplaceSourceSchema,
  policy: marketplacePluginPolicySchema,
  category: nonEmptyTrimmedStringSchema,
  interface: marketplacePluginInterfaceSchema.optional(),
}).strict();

const marketplaceInterfaceSchema = z.object({
  displayName: nonEmptyTrimmedStringSchema.optional(),
}).strict();

const marketplaceDocumentSchema = z.object({
  name: nonEmptyTrimmedStringSchema,
  interface: marketplaceInterfaceSchema.optional(),
  plugins: z.array(marketplacePluginEntrySchema),
}).strict();

export interface ParsedMarketplacePluginEntry {
  name: string;
  sourcePath: string;
  category: string;
  installationPolicy: string;
  authenticationPolicy: string;
  displayName?: string;
}

export interface ParsedMarketplaceDocument {
  name: string;
  displayName?: string;
  marketplacePath: string;
  marketplaceRootDir: string;
  plugins: ParsedMarketplacePluginEntry[];
}

function formatZodError(error: z.ZodError): string {
  const issue = error.issues[0];
  if (!issue) return "validation failed";
  const issuePath = issue.path.length > 0 ? issue.path.join(".") : "root";
  return `${issuePath}: ${issue.message}`;
}

export function parsePluginMarketplace(rawJson: string, marketplacePath: string): ParsedMarketplaceDocument {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawJson);
  } catch (error) {
    throw new Error(`marketplace.json: invalid JSON in ${marketplacePath}: ${String(error)}`);
  }

  const validated = marketplaceDocumentSchema.safeParse(parsed);
  if (!validated.success) {
    throw new Error(`marketplace.json: ${formatZodError(validated.error)}`);
  }

  const marketplaceRootDir = path.dirname(path.resolve(marketplacePath));
  const plugins = validated.data.plugins.map((plugin) => {
    const sourcePathRaw = plugin.source.path;
    if (!sourcePathRaw.startsWith("./")) {
      throw new Error(
        `marketplace.json: plugins.${plugin.name}.source.path must start with "./" in ${marketplacePath}`,
      );
    }
    const sourcePath = resolveMaybeRelative(sourcePathRaw, marketplaceRootDir);
    if (!isPathInside(marketplaceRootDir, sourcePath)) {
      throw new Error(
        `marketplace.json: plugins.${plugin.name}.source.path resolves outside marketplace root in ${marketplacePath}`,
      );
    }
    return {
      name: plugin.name,
      sourcePath,
      category: plugin.category,
      installationPolicy: plugin.policy.installation,
      authenticationPolicy: plugin.policy.authentication,
      ...(plugin.interface?.displayName ? { displayName: plugin.interface.displayName } : {}),
    };
  });

  return {
    name: validated.data.name,
    ...(validated.data.interface?.displayName ? { displayName: validated.data.interface.displayName } : {}),
    marketplacePath: path.resolve(marketplacePath),
    marketplaceRootDir,
    plugins,
  };
}
