export type LocalToolDefinition = {
  description?: string;
  inputSchema?: unknown;
  execute: (input: unknown) => Promise<unknown> | unknown;
};

export function defineTool<T extends LocalToolDefinition>(definition: T): T {
  return definition;
}
