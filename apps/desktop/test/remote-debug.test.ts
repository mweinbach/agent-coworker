import { describe, expect, test } from "bun:test";

import {
  DEFAULT_ELECTRON_REMOTE_DEBUG_PORT,
  resolveElectronRemoteDebugConfig,
} from "../electron/services/remoteDebug";

describe("resolveElectronRemoteDebugConfig", () => {
  test("enables loopback remote debugging by default in unpackaged dev", () => {
    expect(
      resolveElectronRemoteDebugConfig({
        isPackaged: false,
        env: {},
      })
    ).toEqual({
      enabled: true,
      port: DEFAULT_ELECTRON_REMOTE_DEBUG_PORT,
    });
  });

  test("allows opting out explicitly", () => {
    expect(
      resolveElectronRemoteDebugConfig({
        isPackaged: false,
        env: { COWORK_ELECTRON_REMOTE_DEBUG: "0" },
      })
    ).toEqual({
      enabled: false,
      port: DEFAULT_ELECTRON_REMOTE_DEBUG_PORT,
    });
  });

  test("keeps packaged builds disabled", () => {
    expect(
      resolveElectronRemoteDebugConfig({
        isPackaged: true,
        env: { COWORK_ELECTRON_REMOTE_DEBUG: "1", COWORK_ELECTRON_REMOTE_DEBUG_PORT: "9333" },
      })
    ).toEqual({
      enabled: false,
      port: DEFAULT_ELECTRON_REMOTE_DEBUG_PORT,
    });
  });

  test("preserves explicit port overrides", () => {
    expect(
      resolveElectronRemoteDebugConfig({
        isPackaged: false,
        env: { COWORK_ELECTRON_REMOTE_DEBUG_PORT: "9333" },
      })
    ).toEqual({
      enabled: true,
      port: "9333",
    });
  });
});
