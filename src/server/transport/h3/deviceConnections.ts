import type { HttpJsonRpcConnection } from "../httpJsonRpcConnection";

export type H3DeviceConnections = {
  get(deviceId: string): HttpJsonRpcConnection;
  current(deviceId: string): HttpJsonRpcConnection | undefined;
  close(deviceId: string): void;
  closeAll(): void;
  getEventStreamOwner(deviceId: string): symbol | undefined;
  setEventStreamOwner(deviceId: string, owner: symbol): void;
  clearEventStreamOwner(deviceId: string): void;
  clearEventStreamOwners(): void;
};

export function createH3DeviceConnections(
  createConnection: () => HttpJsonRpcConnection,
): H3DeviceConnections {
  const connections = new Map<string, HttpJsonRpcConnection>();
  const eventStreamOwners = new Map<string, symbol>();

  return {
    get(deviceId) {
      const existing = connections.get(deviceId);
      if (existing !== undefined) {
        return existing;
      }
      const connection = createConnection();
      connections.set(deviceId, connection);
      return connection;
    },
    current(deviceId) {
      return connections.get(deviceId);
    },
    close(deviceId) {
      eventStreamOwners.delete(deviceId);
      const connection = connections.get(deviceId);
      if (connection === undefined) {
        return;
      }
      connections.delete(deviceId);
      connection.close();
    },
    closeAll() {
      eventStreamOwners.clear();
      for (const connection of connections.values()) {
        connection.close();
      }
      connections.clear();
    },
    getEventStreamOwner(deviceId) {
      return eventStreamOwners.get(deviceId);
    },
    setEventStreamOwner(deviceId, owner) {
      eventStreamOwners.set(deviceId, owner);
    },
    clearEventStreamOwner(deviceId) {
      eventStreamOwners.delete(deviceId);
    },
    clearEventStreamOwners() {
      eventStreamOwners.clear();
    },
  };
}
