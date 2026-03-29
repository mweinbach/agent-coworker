import { describe, expect, mock, test } from "bun:test";
import { EventEmitter as NodeEventEmitter } from "node:events";

mock.module("expo-modules-core", () => ({
  EventEmitter: class EventEmitter<TEventsMap extends Record<string, (...args: any[]) => void>> {
    private readonly emitter = new NodeEventEmitter();

    addListener<EventName extends keyof TEventsMap>(eventName: EventName, listener: TEventsMap[EventName]) {
      this.emitter.on(String(eventName), listener as (...args: any[]) => void);
      return {
        remove: () => {
          this.emitter.off(String(eventName), listener as (...args: any[]) => void);
        },
      };
    }

    removeAllListeners(eventName: keyof TEventsMap) {
      this.emitter.removeAllListeners(String(eventName));
    }

    emit<EventName extends keyof TEventsMap>(eventName: EventName, ...args: Parameters<TEventsMap[EventName]>) {
      this.emitter.emit(String(eventName), ...args);
    }
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
