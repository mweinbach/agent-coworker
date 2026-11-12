import { describe, expect, test } from "bun:test";

const { describeTransportStatus, isWorkspaceConnectionReady } = await import(
  "../apps/mobile/src/features/relay/connectionState"
);

describe("mobile connection state helpers", () => {
  test("only native connected transport unlocks workspace access", () => {
    expect(
      isWorkspaceConnectionReady({
        status: "connected",
        transportMode: "native",
      }),
    ).toBe(true);
    expect(
      isWorkspaceConnectionReady({
        status: "connected",
        transportMode: "fallback",
      }),
    ).toBe(false);
    expect(
      isWorkspaceConnectionReady({
        status: "error",
        transportMode: "unsupported",
      }),
    ).toBe(false);
  });

  test("fallback and unsupported modes surface distinct labels", () => {
    expect(
      describeTransportStatus({
        status: "connected",
        transportMode: "fallback",
      }),
    ).toBe("Fallback demo");

    expect(
      describeTransportStatus({
        status: "error",
        transportMode: "unsupported",
      }),
    ).toBe("Unsupported");
  });
});
