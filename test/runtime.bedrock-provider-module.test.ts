import { describe, expect, test } from "bun:test";

import { __internal as bedrockProviderModuleInternals } from "../src/runtime/bedrockProviderModule";

const {
  buildAdditionalModelRequestFields,
  getStandardBedrockEndpointRegion,
  shouldUseExplicitBedrockEndpoint,
} = bedrockProviderModuleInternals;

describe("runtime/bedrockProviderModule", () => {
  test("extracts regions only from standard Bedrock runtime endpoints", () => {
    expect(getStandardBedrockEndpointRegion("https://bedrock-runtime.us-east-1.amazonaws.com")).toBe(
      "us-east-1",
    );
    expect(
      getStandardBedrockEndpointRegion("https://bedrock-runtime-fips.us-gov-west-1.amazonaws.com"),
    ).toBe("us-gov-west-1");
    expect(
      getStandardBedrockEndpointRegion("https://bedrock-runtime.cn-north-1.amazonaws.com.cn"),
    ).toBe("cn-north-1");
    expect(getStandardBedrockEndpointRegion("https://custom-bedrock.example.test")).toBeUndefined();
    expect(getStandardBedrockEndpointRegion("not a url")).toBeUndefined();
    expect(getStandardBedrockEndpointRegion(undefined)).toBeUndefined();
  });

  test("uses explicit endpoints only when SDK default resolution cannot safely infer intent", () => {
    expect(
      shouldUseExplicitBedrockEndpoint(
        "https://bedrock-runtime.us-west-2.amazonaws.com",
        undefined,
        false,
      ),
    ).toBe(true);
    expect(
      shouldUseExplicitBedrockEndpoint(
        "https://bedrock-runtime.us-west-2.amazonaws.com",
        "us-east-1",
        false,
      ),
    ).toBe(false);
    expect(
      shouldUseExplicitBedrockEndpoint(
        "https://bedrock-runtime.us-west-2.amazonaws.com",
        undefined,
        true,
      ),
    ).toBe(false);
    expect(
      shouldUseExplicitBedrockEndpoint(
        "https://bedrock-runtime.internal.example.test",
        "us-east-1",
        true,
      ),
    ).toBe(true);
  });

  test("omits unsupported thinking display for GovCloud Claude targets", () => {
    const fields = buildAdditionalModelRequestFields(
      {
        id: "anthropic.claude-sonnet-4-5-20250929-v1:0",
        reasoning: true,
      },
      {
        reasoning: "high",
        region: "us-gov-west-1",
      },
    );

    expect(fields).toEqual({
      thinking: {
        type: "enabled",
        budget_tokens: 16384,
      },
      anthropic_beta: ["interleaved-thinking-2025-05-14"],
    });
  });

  test("defaults commercial Claude thinking display and maps adaptive xhigh by model generation", () => {
    expect(
      buildAdditionalModelRequestFields(
        {
          id: "anthropic.claude-opus-4-6-20260115-v1:0",
          reasoning: true,
        },
        {
          reasoning: "xhigh",
        },
      ),
    ).toEqual({
      thinking: { type: "adaptive", display: "summarized" },
      output_config: { effort: "max" },
    });

    expect(
      buildAdditionalModelRequestFields(
        {
          id: "anthropic.claude-opus-4-7-20260415-v1:0",
          reasoning: true,
        },
        {
          reasoning: "xhigh",
          thinkingDisplay: "full",
        },
      ),
    ).toEqual({
      thinking: { type: "adaptive", display: "full" },
      output_config: { effort: "xhigh" },
    });
  });
});
