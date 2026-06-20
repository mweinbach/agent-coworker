const TASK_READ_METHODS = new Set([
  "task/list",
  "task/read",
  "task/artifact/version/compare",
  "task/artifact/version/preview",
]);

export type TaskRpcPermission = "conversations" | "turns";

export function getTaskRpcRequiredPermissions(method: string): TaskRpcPermission[] {
  if (!method.startsWith("task/")) return [];
  return TASK_READ_METHODS.has(method) ? ["conversations"] : ["conversations", "turns"];
}
