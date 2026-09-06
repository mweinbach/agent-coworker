import { describe, expect, test } from "bun:test";
import { buildGoogleBuiltInTools } from "../src/runtime/googleNative/toolsAndBuiltIns";
import type { GoogleNativeStepRequest } from "../src/runtime/googleNative/types";
import { buildRequestFingerprint } from "../src/shared/providerContinuation";

describe("native capabilities with deferred schemas", () => {
  const request = {
    model: { id: "gemini-test" },
    systemPrompt: "",
    messages: [],
    tools: [{ name: "toolSearch" }, { name: "toolCall" }],
    streamOptions: { nativeWebSearch: true },
  } as GoogleNativeStepRequest;

  test("retains permitted native web tools without exposing their direct schemas", () => {
    expect(buildGoogleBuiltInTools({ ...request, authorizedToolNames: ["webFetch"] })).toEqual([
      { type: "google_search", search_types: ["web_search"] },
      { type: "url_context" },
    ]);
    expect(buildGoogleBuiltInTools({ ...request, authorizedToolNames: ["read"] })).toEqual([]);
    expect(
      buildGoogleBuiltInTools({
        ...request,
        authorizedToolNames: [],
        tools: [{ name: "webFetch" }],
      }),
    ).toEqual([]);
    expect(
      buildGoogleBuiltInTools({
        ...request,
        authorizedToolNames: ["webFetch"],
        streamOptions: { nativeWebSearch: false },
      }),
    ).toEqual([]);
  });

  test("invalidates continuation when filtered capabilities change", () => {
    const input = {
      modelId: "gemini-test",
      system: "",
      tools: request.tools,
      streamOptions: request.streamOptions,
    };
    const allowed = buildRequestFingerprint({ ...input, authorizedToolNames: ["webFetch"] });
    expect(allowed).not.toBe(buildRequestFingerprint({ ...input, authorizedToolNames: [] }));
    expect(buildRequestFingerprint({ ...input, authorizedToolNames: ["webFetch", "read"] })).toBe(
      buildRequestFingerprint({ ...input, authorizedToolNames: ["read", "webFetch"] }),
    );
  });
});
