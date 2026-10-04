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
    send: () => 1,
    addEventSink: () => () => undefined,
    dispatch: async () => null,
    close: () => {},
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
    permissions: { ...DEFAULT_H3_TRUSTED_DEVICE_PERMISSIONS, ...permissions },
  };
}

describe("applyTrustedDevicePermissionsToConnection", () => {
  test.each([
    [
      "default pairings cannot read tasks, mutate tasks, or receive workspace control",
      {},
      { workspaceControlEventsAllowed: false, taskReadAllowed: false, taskMutationAllowed: false },
    ],
    [
      "conversations alone enables task reads, not mutations",
      { conversations: true, turns: false },
      { workspaceControlEventsAllowed: false, taskReadAllowed: true, taskMutationAllowed: false },
    ],
    [
      "task mutation requires both conversations and turns (both granted)",
      { conversations: true, turns: true },
      { workspaceControlEventsAllowed: false, taskReadAllowed: true, taskMutationAllowed: true },
    ],
    [
      "task mutation requires both conversations and turns (turns only)",
      { conversations: false, turns: true },
      { workspaceControlEventsAllowed: false, taskReadAllowed: false, taskMutationAllowed: false },
    ],
    [
      "workspace settings toggle control events independently of task flags",
      { conversations: true, turns: true, workspaceSettings: true },
      { workspaceControlEventsAllowed: true, taskReadAllowed: true, taskMutationAllowed: true },
    ],
  ] as const)("%s", (_label, permissions, expected) => {
    const connection = makeConnection();
    applyTrustedDevicePermissionsToConnection(connection, makeDevice(permissions));
    expect(connection.data).toMatchObject(expected);
  });
});
