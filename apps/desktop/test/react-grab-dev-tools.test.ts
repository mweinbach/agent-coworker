import { describe, expect, mock, test } from "bun:test";

import { maybeLoadReactGrabDevTools } from "../src/lib/reactGrabDevTools";

describe("maybeLoadReactGrabDevTools", () => {
  test("loads the React Grab dev modules in development", async () => {
    const loadReactGrab = mock(async () => ({}));
    const loadReactGrabMcpClient = mock(async () => ({}));

    await maybeLoadReactGrabDevTools(true, {
      loadReactGrab,
      loadReactGrabMcpClient,
    });

    expect(loadReactGrab).toHaveBeenCalledTimes(1);
    expect(loadReactGrabMcpClient).toHaveBeenCalledTimes(1);
  });

  test("skips the React Grab dev modules outside development", async () => {
    const loadReactGrab = mock(async () => ({}));
    const loadReactGrabMcpClient = mock(async () => ({}));

    await maybeLoadReactGrabDevTools(false, {
      loadReactGrab,
      loadReactGrabMcpClient,
    });

    expect(loadReactGrab).not.toHaveBeenCalled();
    expect(loadReactGrabMcpClient).not.toHaveBeenCalled();
  });
});
