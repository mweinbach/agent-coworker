import { describe, expect, test } from "bun:test";

const {
  describeTransportStatus,
  isWorkspaceConnectionReady,
  toneForTransportState,
} = await import("../apps/mobile/src/features/relay/connectionState");

describe("mobile connection state helpers", () => {
  test("only native connected transport unlocks workspace access", () => {
    expect(isWorkspaceConnectionReady({
      status: "connected",
      transportMode: "native",
    })).toBe(true);
    expect(isWorkspaceConnectionReady({
      status: "connected",
      transportMode: "fallback",
    })).toBe(false);
    expect(isWorkspaceConnectionReady({
      status: "error",
      transportMode: "unsupported",
    })).toBe(false);
  });

  test("fallback and unsupported modes surface distinct labels and tones", () => {
    expect(describeTransportStatus({
      status: "connected",
      transportMode: "fallback",
    })).toBe("Fallback demo");
    expect(toneForTransportState({
      status: "connected",
      transportMode: "fallback",
    })).toBe("warning");

    expect(describeTransportStatus({
      status: "error",
      transportMode: "unsupported",
    })).toBe("Unsupported");
    expect(toneForTransportState({
      status: "error",
      transportMode: "unsupported",
    })).toBe("danger");
  });
});
