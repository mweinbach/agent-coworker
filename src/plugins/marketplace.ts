import path from "node:path";
import { z } from "zod";

import { marketplacePluginSourceInput, trimSlashes } from "../extensions/source";
import { formatZodError } from "../mcp/configRegistry/parser";
import {
  canonicalizePathForBoundaryCheckSync,
  isPathInside,
  resolveMaybeRelative,
} from "../utils/paths";

const nonEmptyTrimmedStringSchema = z.string().trim().min(1);
const sourceHashSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/);

const marketplaceSourceSchema = z
  .object({
    source: z.literal("local"),
    path: nonEmptyTrimmedStringSchema,
  })
  .strict();

const marketplacePolicySchema = z
  .object({
    installation: nonEmptyTrimmedStringSchema,
    authentication: nonEmptyTrimmedStringSchema,
  })
  .strict();

const marketplaceEntryInterfaceSchema = z
  .object({
    displayName: nonEmptyTrimmedStringSchema.optional(),
    icon: nonEmptyTrimmedStringSchema.optional(),
    logo: nonEmptyTrimmedStringSchema.optional(),
    brandColor: nonEmptyTrimmedStringSchema.optional(),
  })
  .strict();

// Plugins and standalone skills share the same marketplace entry shape; the only
// difference is which array they live under and how each resolves on install.
const marketplaceEntrySchema = z
  .object({
    name: nonEmptyTrimmedStringSchema,
    source: marketplaceSourceSchema,
    policy: marketplacePolicySchema,
    category: nonEmptyTrimmedStringSchema,
    interface: marketplaceEntryInterfaceSchema.optional(),
    sourceHash: sourceHashSchema.optional(),
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
    plugins: z.array(marketplaceEntrySchema),
    skills: z.array(marketplaceEntrySchema).optional(),
  })
  .strict();

type MarketplaceEntryInput = z.infer<typeof marketplaceEntrySchema>;
type MarketplaceEntryKind = "plugins" | "skills";

interface ParsedMarketplaceEntry {
  name: string;
  sourcePath: string;
  sourceInput?: string;
  category: string;
  installationPolicy: string;
  authenticationPolicy: string;
  displayName?: string;
  icon?: string;
  brandColor?: string;
  sourceHash?: string;
}

export interface ParsedMarketplaceDocument {
  name: string;
  displayName?: string;
  marketplacePath: string;
  marketplaceRootDir: string;
  plugins: ParsedMarketplaceEntry[];
  skills: ParsedMarketplaceEntry[];
}

function validateMarketplaceRelativeSourcePath(
  sourcePathRaw: string,
  entryName: string,
  marketplacePath: string,
  kind: MarketplaceEntryKind,
) {
  if (!sourcePathRaw.startsWith("./")) {
    throw new Error(
      `marketplace.json: ${kind}.${entryName}.source.path must start with "./" in ${marketplacePath}`,
    );
  }
  const normalized = path.posix.normalize(sourcePathRaw);
  if (path.posix.isAbsolute(normalized) || normalized === ".." || normalized.startsWith("../")) {
    throw new Error(
      `marketplace.json: ${kind}.${entryName}.source.path resolves outside marketplace root in ${marketplacePath}`,
    );
  }
  return trimSlashes(normalized);
}

function buildParsedMarketplaceEntry(
  entry: MarketplaceEntryInput,
  sourcePath: string,
  sourceInput?: string,
): ParsedMarketplaceEntry {
  const icon = entry.interface?.icon ?? entry.interface?.logo;
  return {
    name: entry.name,
    sourcePath,
    ...(sourceInput ? { sourceInput } : {}),
    category: entry.category,
    installationPolicy: entry.policy.installation,
    authenticationPolicy: entry.policy.authentication,
    ...(entry.sourceHash ? { sourceHash: entry.sourceHash } : {}),
    ...(entry.interface?.displayName ? { displayName: entry.interface.displayName } : {}),
    ...(icon ? { icon } : {}),
    ...(entry.interface?.brandColor ? { brandColor: entry.interface.brandColor } : {}),
  };
}

function mapLocalMarketplaceEntries(
  entries: MarketplaceEntryInput[],
  kind: MarketplaceEntryKind,
  marketplacePath: string,
  marketplaceRootDir: string,
  canonicalMarketplaceRootDir: string,
): ParsedMarketplaceEntry[] {
  return entries.map((entry) => {
    const sourcePathRaw = entry.source.path;
    validateMarketplaceRelativeSourcePath(sourcePathRaw, entry.name, marketplacePath, kind);
    const sourcePath = resolveMaybeRelative(sourcePathRaw, marketplaceRootDir);
    const canonicalSourcePath = canonicalizePathForBoundaryCheckSync(sourcePath);
    if (!isPathInside(canonicalMarketplaceRootDir, canonicalSourcePath)) {
      throw new Error(
        `marketplace.json: ${kind}.${entry.name}.source.path resolves outside marketplace root in ${marketplacePath}`,
      );
    }
    return buildParsedMarketplaceEntry(entry, sourcePath);
  });
}

function mapRemoteMarketplaceEntries(
  entries: MarketplaceEntryInput[],
  kind: MarketplaceEntryKind,
  opts: { marketplacePath: string; repo: string; ref: string },
): ParsedMarketplaceEntry[] {
  return entries.map((entry) => {
    const sourcePath = validateMarketplaceRelativeSourcePath(
      entry.source.path,
      entry.name,
      opts.marketplacePath,
      kind,
    );
    return buildParsedMarketplaceEntry(
      entry,
      sourcePath,
      marketplacePluginSourceInput({
        repo: opts.repo,
        ref: opts.ref,
        sourcePath,
      }),
    );
  });
}

function parseRawMarketplaceDocument(
  rawJson: string,
  marketplacePath: string,
): z.infer<typeof marketplaceDocumentSchema> {
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
  return validated.data;
}

export function parsePluginMarketplace(
  rawJson: string,
  marketplacePath: string,
): ParsedMarketplaceDocument {
  const data = parseRawMarketplaceDocument(rawJson, marketplacePath);
  const marketplaceRootDir = path.dirname(path.resolve(marketplacePath));
  const canonicalMarketplaceRootDir = canonicalizePathForBoundaryCheckSync(marketplaceRootDir);

  return {
    name: data.name,
    ...(data.interface?.displayName ? { displayName: data.interface.displayName } : {}),
    marketplacePath: path.resolve(marketplacePath),
    marketplaceRootDir,
    plugins: mapLocalMarketplaceEntries(
      data.plugins,
      "plugins",
      marketplacePath,
      marketplaceRootDir,
      canonicalMarketplaceRootDir,
    ),
    skills: mapLocalMarketplaceEntries(
      data.skills ?? [],
      "skills",
      marketplacePath,
      marketplaceRootDir,
      canonicalMarketplaceRootDir,
    ),
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
  const data = parseRawMarketplaceDocument(rawJson, opts.marketplacePath);

  return {
    name: data.name,
    ...(data.interface?.displayName ? { displayName: data.interface.displayName } : {}),
    marketplacePath: opts.marketplacePath,
    marketplaceRootDir: `https://github.com/${opts.repo}/tree/${opts.ref}`,
    plugins: mapRemoteMarketplaceEntries(data.plugins, "plugins", opts),
    skills: mapRemoteMarketplaceEntries(data.skills ?? [], "skills", opts),
  };
}
