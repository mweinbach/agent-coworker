import type { CoworkJsonRpcClient } from "./jsonRpcClient";

let activeClient: CoworkJsonRpcClient | null = null;

export function setActiveCoworkJsonRpcClient(client: CoworkJsonRpcClient | null): void {
  activeClient = client;
}

export function getActiveCoworkJsonRpcClient(): CoworkJsonRpcClient | null {
  return activeClient;
}
