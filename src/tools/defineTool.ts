export type LocalToolDefinition<TOutput = unknown> = {
  description?: string;
  inputSchema?: unknown;
  execute: (input: any) => Promise<TOutput> | TOutput;
};

export function defineTool<T extends LocalToolDefinition>(definition: T): T {
  return definition;
}
