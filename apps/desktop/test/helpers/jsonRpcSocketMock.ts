import { JSONRPC_SOCKET_OVERRIDE_KEY } from "../../src/app/store.helpers/jsonRpcSocketOverride";

export class NoopJsonRpcSocket {
  readonly readyPromise = Promise.resolve();

  connect() {}

  async request() {
    return {};
  }

  respond() {
    return true;
  }

  close() {}
}

export function setJsonRpcSocketOverride(socketCtor: unknown) {
  (globalThis as Record<string, unknown>)[JSONRPC_SOCKET_OVERRIDE_KEY] = socketCtor;
}

export function clearJsonRpcSocketOverride() {
  delete (globalThis as Record<string, unknown>)[JSONRPC_SOCKET_OVERRIDE_KEY];
}
