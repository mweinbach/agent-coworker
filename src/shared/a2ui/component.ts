/**
 * The "basic catalog" component types that the desktop renderer knows how to
 * paint. Components outside this set are shown as a diagnostic card so the
 * user can still see that the agent tried to render something.
 */
export const A2UI_BASIC_CATALOG_ID = "https://a2ui.org/specification/v0_9/basic_catalog.json";

/**
 * Canonical set of component types from the v0.9 basic catalog that we
 * currently render. Matches the names used in the spec examples and keeps
 * the surface area small for the first implementation.
 *
 * See https://github.com/google/A2UI/blob/main/specification/v0_9/basic_catalog.json
 */
export const SUPPORTED_BASIC_CATALOG_COMPONENT_TYPES = [
  "Text",
  "Heading",
  "Paragraph",
  "Column",
  "Row",
  "Stack",
  "Divider",
  "Spacer",
  "Button",
  "TextField",
  "TextArea",
  "Checkbox",
  "Select",
  "Link",
  "ProgressBar",
  "Image",
  "List",
  "Card",
  "Badge",
  "Table",
] as const;

export type SupportedBasicComponentType = (typeof SUPPORTED_BASIC_CATALOG_COMPONENT_TYPES)[number];

export function isSupportedBasicComponentType(
  value: unknown,
): value is SupportedBasicComponentType {
  return (
    typeof value === "string" &&
    (SUPPORTED_BASIC_CATALOG_COMPONENT_TYPES as readonly string[]).includes(value)
  );
}

/**
 * Human-readable description of which catalog components we render. Surfaces
 * outside the basic catalog still render (with a fallback card), but new
 * component types fall back to a diagnostic component.
 */
export function describeSupportedComponents(): string {
  return SUPPORTED_BASIC_CATALOG_COMPONENT_TYPES.join(", ");
}

export function isBasicCatalogId(catalogId: string): boolean {
  if (catalogId === A2UI_BASIC_CATALOG_ID) return true;
  // Allow versioned overrides or trailing slashes.
  try {
    const url = new URL(catalogId);
    return url.hostname === "a2ui.org" && url.pathname.includes("basic_catalog");
  } catch {
    return false;
  }
}
