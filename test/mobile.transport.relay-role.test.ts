import { describe, expect, mock, test } from "bun:test";
import { EventEmitter as NodeEventEmitter } from "node:events";

import "./helpers/mock-react-native";

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
