import path from "node:path";
import { z } from "zod";

import { marketplacePluginSourceInput, trimSlashes } from "../extensions/source";
import {
  canonicalizePathForBoundaryCheckSync,
  isPathInside,
  resolveMaybeRelative,
} from "../utils/paths";

const nonEmptyTrimmedStringSchema = z.string().trim().min(1);

const marketplaceSourceSchema = z
  .object({
    source: z.literal("local"),
    path: nonEmptyTrimmedStringSchema,
  })
  .strict();

const marketplacePluginPolicySchema = z
  .object({
    installation: nonEmptyTrimmedStringSchema,
    authentication: nonEmptyTrimmedStringSchema,
  })
  .strict();

const marketplacePluginInterfaceSchema = z
  .object({
    displayName: nonEmptyTrimmedStringSchema.optional(),
  })
  .strict();

const marketplacePluginEntrySchema = z
  .object({
    name: nonEmptyTrimmedStringSchema,
    source: marketplaceSourceSchema,
    policy: marketplacePluginPolicySchema,
    category: nonEmptyTrimmedStringSchema,
    interface: marketplacePluginInterfaceSchema.optional(),
  })
  .strict();

const marketplaceInterfaceSchema = z
  .object({
    displayName: nonEmptyTrimmedStringSchema.optional(),
  })
  .strict();

const marketplaceDocumentSchema = z
  .object({
    name: nonEmptyTrimmedStringSchema,
    interface: marketplaceInterfaceSchema.optional(),
    plugins: z.array(marketplacePluginEntrySchema),
  })
  .strict();

interface ParsedMarketplacePluginEntry {
  name: string;
  sourcePath: string;
  sourceInput?: string;
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

function validateMarketplaceRelativeSourcePath(
  sourcePathRaw: string,
  entryName: string,
  marketplacePath: string,
) {
  if (!sourcePathRaw.startsWith("./")) {
    throw new Error(
      `marketplace.json: plugins.${entryName}.source.path must start with "./" in ${marketplacePath}`,
    );
  }
  const normalized = path.posix.normalize(sourcePathRaw);
  if (path.posix.isAbsolute(normalized) || normalized === ".." || normalized.startsWith("../")) {
    throw new Error(
      `marketplace.json: plugins.${entryName}.source.path resolves outside marketplace root in ${marketplacePath}`,
    );
  }
  return trimSlashes(normalized);
}

export function parsePluginMarketplace(
  rawJson: string,
  marketplacePath: string,
): ParsedMarketplaceDocument {
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
  const canonicalMarketplaceRootDir = canonicalizePathForBoundaryCheckSync(marketplaceRootDir);
  const plugins = validated.data.plugins.map((plugin) => {
    const sourcePathRaw = plugin.source.path;
    validateMarketplaceRelativeSourcePath(sourcePathRaw, plugin.name, marketplacePath);
    const sourcePath = resolveMaybeRelative(sourcePathRaw, marketplaceRootDir);
    const canonicalSourcePath = canonicalizePathForBoundaryCheckSync(sourcePath);
    if (!isPathInside(canonicalMarketplaceRootDir, canonicalSourcePath)) {
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
    ...(validated.data.interface?.displayName
      ? { displayName: validated.data.interface.displayName }
      : {}),
    marketplacePath: path.resolve(marketplacePath),
    marketplaceRootDir,
    plugins,
  };
}

export function parseRemotePluginMarketplace(
  rawJson: string,
  opts: {
    marketplacePath: string;
    repo: string;
    ref: string;
  },
): ParsedMarketplaceDocument {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawJson);
  } catch (error) {
    throw new Error(`marketplace.json: invalid JSON in ${opts.marketplacePath}: ${String(error)}`);
  }

  const validated = marketplaceDocumentSchema.safeParse(parsed);
  if (!validated.success) {
    throw new Error(`marketplace.json: ${formatZodError(validated.error)}`);
  }

  const marketplaceRootDir = `https://github.com/${opts.repo}/tree/${opts.ref}`;
  const plugins = validated.data.plugins.map((plugin) => {
    const sourcePath = validateMarketplaceRelativeSourcePath(
      plugin.source.path,
      plugin.name,
      opts.marketplacePath,
    );
    return {
      name: plugin.name,
      sourcePath,
      sourceInput: marketplacePluginSourceInput({
        repo: opts.repo,
        ref: opts.ref,
        sourcePath,
      }),
      category: plugin.category,
      installationPolicy: plugin.policy.installation,
      authenticationPolicy: plugin.policy.authentication,
      ...(plugin.interface?.displayName ? { displayName: plugin.interface.displayName } : {}),
    };
  });

  return {
    name: validated.data.name,
    ...(validated.data.interface?.displayName
      ? { displayName: validated.data.interface.displayName }
      : {}),
    marketplacePath: opts.marketplacePath,
    marketplaceRootDir,
    plugins,
  };
}
