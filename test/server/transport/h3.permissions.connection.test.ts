import { describe, expect, test } from "bun:test";
import {
  DEFAULT_H3_TRUSTED_DEVICE_PERMISSIONS,
  type H3TrustedDevicePermissions,
  type H3TrustedDeviceRecord,
} from "../../../src/server/transport/h3/pairing";
import { applyTrustedDevicePermissionsToConnection } from "../../../src/server/transport/h3/permissions";
import type { HttpJsonRpcConnection } from "../../../src/server/transport/httpJsonRpcConnection";

function makeConnection(): HttpJsonRpcConnection {
  return {
    data: {
      connectionId: "conn-1",
      protocolMode: "h3",
      workspaceControlEventsAllowed: true,
      taskReadAllowed: true,
      taskMutationAllowed: true,
    },
    send() {
      return 1;
    },
    addEventSink() {
      return () => undefined;
    },
    async dispatch() {
      return null;
    },
    close() {},
  };
}

function makeDevice(permissions: Partial<H3TrustedDevicePermissions> = {}): H3TrustedDeviceRecord {
  return {
    deviceId: "phone-1",
    identityPub: "pub",
    displayName: "Phone",
    fingerprint: "fp",
    sessionTokenHash: "hash",
    lastPairedAt: "2026-06-18T12:00:00.000Z",
    lastConnectedAt: null,
    permissions: {
      ...DEFAULT_H3_TRUSTED_DEVICE_PERMISSIONS,
      ...permissions,
    },
  };
}

describe("applyTrustedDevicePermissionsToConnection", () => {
  test("default pairings cannot read tasks, mutate tasks, or receive workspace control", () => {
    const connection = makeConnection();

    applyTrustedDevicePermissionsToConnection(connection, makeDevice());

    expect(connection.data).toMatchObject({
      workspaceControlEventsAllowed: false,
      taskReadAllowed: false,
      taskMutationAllowed: false,
    });
  });

  test("conversations alone enables task reads, not mutations", () => {
    const connection = makeConnection();

    applyTrustedDevicePermissionsToConnection(
      connection,
      makeDevice({ conversations: true, turns: false }),
    );

    expect(connection.data.taskReadAllowed).toBe(true);
    expect(connection.data.taskMutationAllowed).toBe(false);
    expect(connection.data.workspaceControlEventsAllowed).toBe(false);
  });

  test("task mutation requires both conversations and turns", () => {
    const both = makeConnection();
    const turnsOnly = makeConnection();

    applyTrustedDevicePermissionsToConnection(
      both,
      makeDevice({ conversations: true, turns: true }),
    );
    applyTrustedDevicePermissionsToConnection(
      turnsOnly,
      makeDevice({ conversations: false, turns: true }),
    );

    expect(both.data.taskReadAllowed).toBe(true);
    expect(both.data.taskMutationAllowed).toBe(true);
    expect(turnsOnly.data.taskReadAllowed).toBe(false);
    expect(turnsOnly.data.taskMutationAllowed).toBe(false);
  });

  test("workspace settings toggle control events independently of task flags", () => {
    const connection = makeConnection();

    applyTrustedDevicePermissionsToConnection(
      connection,
      makeDevice({
        conversations: true,
        turns: true,
        workspaceSettings: true,
      }),
    );

    expect(connection.data).toMatchObject({
      workspaceControlEventsAllowed: true,
      taskReadAllowed: true,
      taskMutationAllowed: true,
    });
  });
});
