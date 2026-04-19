import { describe, test, expect } from "bun:test";

import {
  A2UI_PROTOCOL_VERSION,
  envelopeKind,
  envelopeSurfaceId,
  parseA2uiEnvelope,
} from "../../src/shared/a2ui/protocol";

describe("parseA2uiEnvelope", () => {
  test("accepts a minimal createSurface envelope", () => {
    const result = parseA2uiEnvelope({
      version: A2UI_PROTOCOL_VERSION,
      createSurface: {
        surfaceId: "s1",
        catalogId: "https://a2ui.org/specification/v0_9/basic_catalog.json",
      },
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(envelopeKind(result.envelope)).toBe("createSurface");
      expect(envelopeSurfaceId(result.envelope)).toBe("s1");
    }
  });

  test("accepts a JSON string payload", () => {
    const result = parseA2uiEnvelope(
      JSON.stringify({
        version: A2UI_PROTOCOL_VERSION,
        deleteSurface: { surfaceId: "s1" },
      }),
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(envelopeKind(result.envelope)).toBe("deleteSurface");
  });

  test("rejects other versions with a clear error", () => {
    const result = parseA2uiEnvelope({ version: "v0.8.1", createSurface: { surfaceId: "s", catalogId: "c" } });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("unsupported A2UI version");
  });

  test("rejects multi-op envelopes", () => {
    const result = parseA2uiEnvelope({
      version: A2UI_PROTOCOL_VERSION,
      createSurface: { surfaceId: "s1", catalogId: "c" },
      deleteSurface: { surfaceId: "s1" },
    });
    expect(result.ok).toBe(false);
  });

  test("rejects empty envelopes", () => {
    const result = parseA2uiEnvelope({ version: A2UI_PROTOCOL_VERSION });
    expect(result.ok).toBe(false);
  });

  test("rejects malformed JSON strings", () => {
    const result = parseA2uiEnvelope("{not json");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("not valid JSON");
  });

  test("rejects updateComponents with nothing to do", () => {
    const result = parseA2uiEnvelope({
      version: A2UI_PROTOCOL_VERSION,
      updateComponents: { surfaceId: "s1" },
    });
    expect(result.ok).toBe(false);
  });

  test("accepts updateDataModel with delete flag", () => {
    const result = parseA2uiEnvelope({
      version: A2UI_PROTOCOL_VERSION,
      updateDataModel: { surfaceId: "s1", path: "/name", value: null, delete: true },
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(envelopeKind(result.envelope)).toBe("updateDataModel");
  });

  test("enforces envelope size cap for string payloads", () => {
    const big = "x".repeat(130 * 1024);
    const result = parseA2uiEnvelope(big);
    expect(result.ok).toBe(false);
  });

  test("enforces envelope size cap for object payloads", () => {
    const result = parseA2uiEnvelope({
      version: A2UI_PROTOCOL_VERSION,
      createSurface: {
        surfaceId: "s1",
        catalogId: "https://a2ui.org/specification/v0_9/basic_catalog.json",
        dataModel: {
          payload: "x".repeat(130 * 1024),
        },
      },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("envelope exceeds");
  });
});
