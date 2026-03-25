import { describe, expect, mock, test } from "bun:test";

mock.module("expo-modules-core", () => ({
  EventEmitter: class EventEmitter {
    addListener() {
      return { remove() {} };
    }

    removeAllListeners() {}
  },
  requireOptionalNativeModule: () => null,
}));

const { __internal } = await import("../apps/mobile/modules/remodex-secure-transport/src");

describe("mobile relay websocket headers", () => {
  test("uses the hosted relay iphone role for mobile socket upgrades", () => {
    expect(__internal.buildRelaySocketHeaders({
      phoneDeviceId: "phone-1",
      phoneIdentityPublicKey: "phone-public-key",
    })).toEqual({
      "x-role": "iphone",
      "x-phone-device-id": "phone-1",
      "x-phone-identity-public-key": "phone-public-key",
    });
  });
});
