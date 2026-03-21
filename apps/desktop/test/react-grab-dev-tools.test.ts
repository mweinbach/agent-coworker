import { describe, expect, mock, test } from "bun:test";

import { maybeLoadReactGrabDevTools, shouldLoadReactGrabDevTools } from "../src/lib/reactGrabDevTools";

describe("maybeLoadReactGrabDevTools", () => {
  test("loads the React Grab dev modules in development", async () => {
    const loadReactGrab = mock(async () => ({}));
    const loadReactGrabMcpClient = mock(async () => ({}));

    await maybeLoadReactGrabDevTools(true, {
      loadReactGrab,
      loadReactGrabMcpClient,
    }, "Mozilla/5.0");

    expect(loadReactGrab).toHaveBeenCalledTimes(1);
    expect(loadReactGrabMcpClient).toHaveBeenCalledTimes(1);
  });

  test("skips the React Grab dev modules outside development", async () => {
    const loadReactGrab = mock(async () => ({}));
    const loadReactGrabMcpClient = mock(async () => ({}));

    await maybeLoadReactGrabDevTools(false, {
      loadReactGrab,
      loadReactGrabMcpClient,
    }, "Mozilla/5.0");

    expect(loadReactGrab).not.toHaveBeenCalled();
    expect(loadReactGrabMcpClient).not.toHaveBeenCalled();
  });

  test("skips the React Grab dev modules in Linux Electron development", async () => {
    const loadReactGrab = mock(async () => ({}));
    const loadReactGrabMcpClient = mock(async () => ({}));

    await maybeLoadReactGrabDevTools(true, {
      loadReactGrab,
      loadReactGrabMcpClient,
    }, "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Cowork/0.1.31 Electron/41.0.3 Safari/537.36");

    expect(loadReactGrab).not.toHaveBeenCalled();
    expect(loadReactGrabMcpClient).not.toHaveBeenCalled();
  });
});

describe("shouldLoadReactGrabDevTools", () => {
  test("allows non-Electron development environments", () => {
    expect(shouldLoadReactGrabDevTools(true, "Mozilla/5.0")).toBe(true);
  });

  test("blocks Linux Electron development environments", () => {
    expect(
      shouldLoadReactGrabDevTools(
        true,
        "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Cowork/0.1.31 Electron/41.0.3 Safari/537.36",
      ),
    ).toBe(false);
  });
});
