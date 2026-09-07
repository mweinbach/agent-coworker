/** A conservative portable strict-schema subset. Never rewrite optional/default semantics. */
export function supportsConstrainedJsonSchema(schema: unknown): boolean {
  const visited = new Set<object>();
  const allowedKeys = new Set([
    "$schema",
    "type",
    "description",
    "title",
    "properties",
    "required",
    "additionalProperties",
    "items",
    "enum",
    "anyOf",
  ]);
  const visit = (value: unknown): boolean => {
    if (!value || typeof value !== "object" || Array.isArray(value) || visited.has(value)) {
      return false;
    }
    visited.add(value);
    try {
      const node = value as Record<string, unknown>;
      if (Object.keys(node).some((key) => !allowedKeys.has(key))) return false;
      if (Array.isArray(node.anyOf)) return node.anyOf.length > 0 && node.anyOf.every(visit);
      const types = Array.isArray(node.type) ? node.type : [node.type];
      if (
        types.length === 0 ||
        types.some(
          (type) =>
            !["object", "array", "string", "number", "integer", "boolean", "null"].includes(
              type as string,
            ),
        )
      )
        return false;
      if (types.includes("object")) {
        const properties = node.properties;
        if (!properties || typeof properties !== "object" || Array.isArray(properties))
          return false;
        const names = Object.keys(properties);
        const required = node.required;
        if (
          node.additionalProperties !== false ||
          !Array.isArray(required) ||
          required.length !== names.length ||
          names.some((name) => !required.includes(name))
        ) {
          return false;
        }
        if (!Object.values(properties).every(visit)) return false;
      }
      return !types.includes("array") || visit(node.items);
    } finally {
      visited.delete(value);
    }
  };
  return (
    !!schema &&
    typeof schema === "object" &&
    (schema as Record<string, unknown>).type === "object" &&
    visit(schema)
  );
}
