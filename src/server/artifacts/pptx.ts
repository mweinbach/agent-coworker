import path from "node:path";

import type JSZip from "jszip";
import {
  asRecord,
  collectRecordsNamed,
  collectText,
  loadBoundedOoxmlPackage,
  normalizeWhitespace,
  numberValue,
  readBoundedTextPart,
  readBoundedXmlPart,
  readMedia,
  readRelationships,
  resolveRelationshipTarget,
  sha256,
  stringValue,
} from "./ooxml";
import type { OoxmlMedia, PptxShape, PptxSlide, PptxSnapshot } from "./types";

const MAX_SLIDES = 10_000;
const MAX_SHAPES_PER_SLIDE = 50_000;

type OrderedSlidePart = {
  id: string;
  part: string;
};

type PptxExtractionOptions = {
  maxSlides?: number;
  includeMedia?: boolean;
  signal?: AbortSignal;
};

export async function extractPptxSnapshot(
  bytes: Uint8Array,
  options: PptxExtractionOptions = {},
): Promise<PptxSnapshot> {
  options.signal?.throwIfAborted();
  const zip = await loadBoundedOoxmlPackage(bytes);
  options.signal?.throwIfAborted();
  const orderedParts = await readOrderedSlideParts(zip, options.signal);
  options.signal?.throwIfAborted();
  if (orderedParts.length === 0) {
    throw new Error("PPTX package does not contain any slides.");
  }
  const maxSlides = Math.min(options.maxSlides ?? MAX_SLIDES, MAX_SLIDES);
  if (!Number.isSafeInteger(maxSlides) || maxSlides < 1) {
    throw new Error("PPTX slide limit must be a positive integer.");
  }
  if (orderedParts.length > maxSlides) {
    throw new Error(`PPTX package exceeds the ${maxSlides}-slide limit.`);
  }

  const slides: PptxSlide[] = [];
  for (const [index, entry] of orderedParts.entries()) {
    options.signal?.throwIfAborted();
    slides.push(await readSlide(zip, entry, index, options));
  }
  options.signal?.throwIfAborted();
  const media = options.includeMedia === false ? [] : await readMedia(zip, "ppt/media/");
  options.signal?.throwIfAborted();
  return {
    slides,
    media,
  };
}

async function readOrderedSlideParts(
  zip: JSZip,
  signal?: AbortSignal,
): Promise<OrderedSlidePart[]> {
  const presentationXml = await readBoundedTextPart(zip, "ppt/presentation.xml");
  signal?.throwIfAborted();
  const presentationRelationships = await readRelationships(zip, "ppt/presentation.xml");
  signal?.throwIfAborted();
  const ordered: OrderedSlidePart[] = [];
  const tagPattern = /<(?:p:)?sldId\b([^>]*)\/?\s*>/gi;
  for (const match of presentationXml.matchAll(tagPattern)) {
    const attributes = match[1] ?? "";
    const relationshipId = attributeValue(attributes, "r:id");
    const stableId = attributeValue(attributes, "id");
    const relationship = relationshipId ? presentationRelationships.get(relationshipId) : null;
    if (!relationship?.type.includes("/slide")) continue;
    ordered.push({
      id: stableId ?? relationshipId ?? relationship.target,
      part: resolveRelationshipTarget("ppt/presentation.xml", relationship.target),
    });
  }
  if (ordered.length > 0) return ordered;

  return Object.keys(zip.files)
    .filter((name) => /^ppt\/slides\/slide\d+\.xml$/i.test(name))
    .toSorted((left, right) => numericPart(left) - numericPart(right))
    .map((part) => ({ id: path.posix.basename(part, ".xml"), part }));
}

function attributeValue(attributes: string, name: string): string | null {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const prefix = name.includes(":") ? "(?:^|\\s)" : "(?:^|\\s)(?![\\w-]+:)";
  const match = attributes.match(new RegExp(`${prefix}${escaped}\\s*=\\s*["']([^"']+)["']`, "i"));
  return match?.[1] ?? null;
}

function numericPart(part: string): number {
  const match = path.posix.basename(part).match(/(\d+)/);
  return match?.[1] ? Number.parseInt(match[1], 10) : Number.MAX_SAFE_INTEGER;
}

async function readSlide(
  zip: JSZip,
  entry: OrderedSlidePart,
  index: number,
  options: PptxExtractionOptions,
): Promise<PptxSlide> {
  const root = await readBoundedXmlPart(zip, entry.part);
  options.signal?.throwIfAborted();
  const slide = asRecord(root?.sld);
  if (!slide) throw new Error(`PPTX slide part is invalid: ${entry.part}`);
  const relationships = await readRelationships(zip, entry.part);
  options.signal?.throwIfAborted();
  const mediaPaths = new Set<string>();
  let notesPart: string | null = null;
  for (const relationship of relationships.values()) {
    if (relationship.type.includes("/notesSlide")) {
      notesPart = resolveRelationshipTarget(entry.part, relationship.target);
      continue;
    }
    if (
      relationship.type.includes("/image") ||
      relationship.type.includes("/audio") ||
      relationship.type.includes("/video") ||
      relationship.type.includes("/media")
    ) {
      const target = resolveRelationshipTarget(entry.part, relationship.target);
      if (target.startsWith("ppt/media/")) mediaPaths.add(target);
    }
  }

  const shapes = extractShapes(slide);
  if (shapes.length > MAX_SHAPES_PER_SLIDE) {
    throw new Error(`PPTX slide exceeds the ${MAX_SHAPES_PER_SLIDE}-shape limit: ${entry.part}`);
  }
  const notesRoot = notesPart ? await readBoundedXmlPart(zip, notesPart) : null;
  options.signal?.throwIfAborted();
  const media =
    options.includeMedia === false ? [] : await readMedia(zip, "ppt/media/", mediaPaths);
  options.signal?.throwIfAborted();
  const text = normalizeWhitespace(
    shapes
      .map((shape) => shape.text)
      .filter(Boolean)
      .join("\n"),
  );
  const notes = collectText(notesRoot);
  const fingerprint = sha256(
    JSON.stringify({
      text,
      notes,
      shapes: shapes.map(({ type, id, name, text: shapeText, x, y, width, height }) => ({
        type,
        id,
        name,
        text: shapeText,
        x,
        y,
        width,
        height,
      })),
      media: media.map(({ path: mediaPath, sha256: mediaSha }) => ({
        path: mediaPath,
        sha256: mediaSha,
      })),
    }),
  );
  return {
    id: entry.id,
    part: entry.part,
    index,
    text,
    notes,
    shapes,
    media,
    fingerprint,
  };
}

function extractShapes(slide: Record<string, unknown>): PptxShape[] {
  const output: PptxShape[] = [];
  for (const [nodeName, type] of [
    ["sp", "shape"],
    ["pic", "picture"],
    ["graphicFrame", "graphic"],
    ["cxnSp", "connector"],
    ["grpSp", "group"],
  ] as const) {
    for (const node of collectRecordsNamed(slide, nodeName)) {
      output.push(parseShape(node, type));
    }
  }
  return output;
}

function parseShape(node: Record<string, unknown>, type: PptxShape["type"]): PptxShape {
  const nonVisual =
    asRecord(asRecord(node.nvSpPr)?.cNvPr) ??
    asRecord(asRecord(node.nvPicPr)?.cNvPr) ??
    asRecord(asRecord(node.nvGraphicFramePr)?.cNvPr) ??
    asRecord(asRecord(node.nvCxnSpPr)?.cNvPr) ??
    asRecord(asRecord(node.nvGrpSpPr)?.cNvPr);
  const transform =
    asRecord(asRecord(node.spPr)?.xfrm) ??
    asRecord(asRecord(node.grpSpPr)?.xfrm) ??
    asRecord(node.xfrm);
  const offset = asRecord(transform?.off);
  const extent = asRecord(transform?.ext);
  return {
    type,
    id: stringValue(nonVisual?.id) ?? null,
    name: stringValue(nonVisual?.name) ?? null,
    text: collectText(node),
    x: numberValue(offset?.x),
    y: numberValue(offset?.y),
    width: numberValue(extent?.cx),
    height: numberValue(extent?.cy),
  };
}

export function sameMedia(left: OoxmlMedia[], right: OoxmlMedia[]): boolean {
  return JSON.stringify(mediaIdentity(left)) === JSON.stringify(mediaIdentity(right));
}

function mediaIdentity(media: OoxmlMedia[]): Array<{ path: string; sha256: string }> {
  return media
    .map(({ path: mediaPath, sha256: mediaSha }) => ({ path: mediaPath, sha256: mediaSha }))
    .toSorted((left, right) => left.path.localeCompare(right.path));
}
