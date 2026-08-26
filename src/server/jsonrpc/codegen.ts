import { z } from "zod";

import { jsonRpcSchemaBundleSchema } from "./schema";

function stripSchemaKeyword(record: Record<string, unknown>): Record<string, unknown> {
  const { $schema: _ignored, ...rest } = record;
  return rest;
}

export function buildJsonRpcJsonSchemaArtifact(): string {
  const schema = stripSchemaKeyword(z.toJSONSchema(jsonRpcSchemaBundleSchema) as Record<string, unknown>);
  return `${JSON.stringify(schema)}\n`;
}
