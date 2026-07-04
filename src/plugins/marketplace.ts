import path from "node:path";
import { z } from "zod";

import { marketplacePluginSourceInput, trimSlashes } from "../extensions/source";
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

function entryInterfaceMeta(entry: MarketplaceEntryInput): {
  displayName?: string;
  icon?: string;
  brandColor?: string;
} {
  const icon = entry.interface?.icon ?? entry.interface?.logo;
  return {
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
    return {
      name: entry.name,
      sourcePath,
      category: entry.category,
      installationPolicy: entry.policy.installation,
      authenticationPolicy: entry.policy.authentication,
      ...(entry.sourceHash ? { sourceHash: entry.sourceHash } : {}),
      ...entryInterfaceMeta(entry),
    };
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
    return {
      name: entry.name,
      sourcePath,
      sourceInput: marketplacePluginSourceInput({
        repo: opts.repo,
        ref: opts.ref,
        sourcePath,
      }),
      category: entry.category,
      installationPolicy: entry.policy.installation,
      authenticationPolicy: entry.policy.authentication,
      ...(entry.sourceHash ? { sourceHash: entry.sourceHash } : {}),
      ...entryInterfaceMeta(entry),
    };
  });
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
  const plugins = mapLocalMarketplaceEntries(
    validated.data.plugins,
    "plugins",
    marketplacePath,
    marketplaceRootDir,
    canonicalMarketplaceRootDir,
  );
  const skills = mapLocalMarketplaceEntries(
    validated.data.skills ?? [],
    "skills",
    marketplacePath,
    marketplaceRootDir,
    canonicalMarketplaceRootDir,
  );

  return {
    name: validated.data.name,
    ...(validated.data.interface?.displayName
      ? { displayName: validated.data.interface.displayName }
      : {}),
    marketplacePath: path.resolve(marketplacePath),
    marketplaceRootDir,
    plugins,
    skills,
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
  const plugins = mapRemoteMarketplaceEntries(validated.data.plugins, "plugins", opts);
  const skills = mapRemoteMarketplaceEntries(validated.data.skills ?? [], "skills", opts);

  return {
    name: validated.data.name,
    ...(validated.data.interface?.displayName
      ? { displayName: validated.data.interface.displayName }
      : {}),
    marketplacePath: opts.marketplacePath,
    marketplaceRootDir,
    plugins,
    skills,
  };
}
