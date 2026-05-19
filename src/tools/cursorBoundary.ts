export const CURSOR_NATIVE_EXECUTION_TOOL_NAMES = new Set([
  "bash",
  "read",
  "write",
  "edit",
  "glob",
  "grep",
  "webSearch",
  "webFetch",
  "notebookEdit",
]);

export function isCursorDynamicCoworkToolName(name: string): boolean {
  return !CURSOR_NATIVE_EXECUTION_TOOL_NAMES.has(name);
}

export function filterToolsForCursorDynamicBoundary<T>(
  tools: Record<string, T>,
): Record<string, T> {
  return Object.fromEntries(
    Object.entries(tools).filter(([name]) => isCursorDynamicCoworkToolName(name)),
  );
}
