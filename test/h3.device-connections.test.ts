import { describe, expect, test } from "bun:test";

import { createH3DeviceConnections } from "../src/server/transport/h3/deviceConnections";
import type { HttpJsonRpcConnection } from "../src/server/transport/httpJsonRpcConnection";

function stubConnection(id: string): HttpJsonRpcConnection & { closed: boolean } {
  const connection = {
    closed: false,
    data: { connectionId: id },
    send() {
      return 1;
    },
    addEventSink() {
      return () => {};
    },
    async dispatch() {
      return null;
    },
    close() {
      connection.closed = true;
    },
  };
  return connection as HttpJsonRpcConnection & { closed: boolean };
}

describe("H3 device connections", () => {
  test("reuses one connection per device until close", () => {
    let created = 0;
    const connections = createH3DeviceConnections(() => {
      created += 1;
      return stubConnection(`conn-${created}`);
    });

    expect(connections.current("phone-1")).toBeUndefined();
    const first = connections.get("phone-1");
    expect(connections.get("phone-1")).toBe(first);
    expect(connections.current("phone-1")).toBe(first);
    expect(connections.get("phone-2")).not.toBe(first);
    expect(created).toBe(2);
  });

  test("close tears down the connection and stream owner so reconnect is fresh", () => {
    const created: Array<HttpJsonRpcConnection & { closed: boolean }> = [];
    const connections = createH3DeviceConnections(() => {
      const connection = stubConnection(`conn-${created.length + 1}`);
      created.push(connection);
      return connection;
    });

    const first = connections.get("phone-1");
    const ownerA = Symbol("stream-a");
    const ownerB = Symbol("stream-b");
    connections.setEventStreamOwner("phone-1", ownerA);
    connections.setEventStreamOwner("phone-1", ownerB);
    expect(connections.getEventStreamOwner("phone-1")).toBe(ownerB);

    connections.close("phone-1");
    expect(first).toBe(created[0]);
    expect(created[0]?.closed).toBe(true);
    expect(connections.current("phone-1")).toBeUndefined();
    expect(connections.getEventStreamOwner("phone-1")).toBeUndefined();

    const second = connections.get("phone-1");
    expect(second).not.toBe(first);
    expect(created).toHaveLength(2);
    expect(created[1]?.closed).toBe(false);
  });

  test("close of an unknown device is a no-op and closeAll closes every live connection", () => {
    const created: Array<HttpJsonRpcConnection & { closed: boolean }> = [];
    const connections = createH3DeviceConnections(() => {
      const connection = stubConnection(`conn-${created.length + 1}`);
      created.push(connection);
      return connection;
    });

    connections.close("missing");
    const phone = connections.get("phone-1");
    const tablet = connections.get("tablet-1");
    connections.setEventStreamOwner("phone-1", Symbol("phone"));
    connections.setEventStreamOwner("tablet-1", Symbol("tablet"));

    connections.closeAll();
    expect(phone).toBe(created[0]);
    expect(tablet).toBe(created[1]);
    expect(created.every((connection) => connection.closed)).toBe(true);
    expect(connections.current("phone-1")).toBeUndefined();
    expect(connections.current("tablet-1")).toBeUndefined();
    expect(connections.getEventStreamOwner("phone-1")).toBeUndefined();
    expect(connections.getEventStreamOwner("tablet-1")).toBeUndefined();
  });

  test("clearing a stream owner does not close the connection", () => {
    const connections = createH3DeviceConnections(() => stubConnection("conn-1"));
    const connection = connections.get("phone-1") as HttpJsonRpcConnection & { closed: boolean };
    const owner = Symbol("stream");
    connections.setEventStreamOwner("phone-1", owner);
    connections.clearEventStreamOwner("phone-1");
    expect(connections.getEventStreamOwner("phone-1")).toBeUndefined();
    expect(connections.current("phone-1")).toBe(connection);
    expect(connection.closed).toBe(false);

    connections.setEventStreamOwner("phone-1", owner);
    connections.clearEventStreamOwners();
    expect(connections.getEventStreamOwner("phone-1")).toBeUndefined();
    expect(connections.current("phone-1")).toBe(connection);
  });
});
