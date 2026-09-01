import type { CoworkJsonRpcClient } from "./jsonRpcClient";

let activeClient: CoworkJsonRpcClient | null = null;
let workspaceRequestGeneration = 0;

export function setActiveCoworkJsonRpcClient(client: CoworkJsonRpcClient | null): void {
  if (client !== activeClient) invalidateWorkspaceRequests();
  activeClient = client;
}

export function getActiveCoworkJsonRpcClient(): CoworkJsonRpcClient | null {
  return activeClient;
}

export function invalidateWorkspaceRequests(): void {
  workspaceRequestGeneration += 1;
}

export function getWorkspaceRequestGeneration(): number {
  return workspaceRequestGeneration;
}
