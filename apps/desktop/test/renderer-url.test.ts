import { describe, expect, test } from "bun:test";

import { resolveDesktopRendererUrl } from "../electron/services/rendererUrl";

describe("resolveDesktopRendererUrl", () => {
  test("falls back to desktop dev renderer when URL is unset", () => {
    const result = resolveDesktopRendererUrl(undefined, undefined);
    expect(result.url).toBe("http://localhost:1420");
    expect(result.warning).toBeUndefined();
  });

  test("accepts loopback desktop renderer URL on expected port", () => {
    const result = resolveDesktopRendererUrl("http://localhost:1420", undefined);
    expect(result.url).toBe("http://localhost:1420");
    expect(result.warning).toBeUndefined();
  });

  test("accepts IPv6 loopback desktop renderer URL on expected port", () => {
    const result = resolveDesktopRendererUrl("http://[::1]:1420/", undefined);
    expect(result.url).toBe("http://[::1]:1420/");
    expect(result.warning).toBeUndefined();
  });

  test("rejects harness portal port and falls back to desktop renderer", () => {
    const result = resolveDesktopRendererUrl("http://localhost:3000", undefined);
    expect(result.url).toBe("http://localhost:1420");
    expect(result.warning).toContain("Ignoring ELECTRON_RENDERER_URL");
  });

  test("rejects non-loopback hosts", () => {
    const result = resolveDesktopRendererUrl("http://example.com:1420", undefined);
    expect(result.url).toBe("http://localhost:1420");
    expect(result.warning).toContain("Ignoring ELECTRON_RENDERER_URL");
  });

  test("respects custom desktop renderer port", () => {
    const result = resolveDesktopRendererUrl("http://127.0.0.1:15555", "15555");
    expect(result.url).toBe("http://127.0.0.1:15555");
    expect(result.warning).toBeUndefined();
  });
});
