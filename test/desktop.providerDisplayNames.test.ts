import { describe, expect, test } from "bun:test";

import { fallbackAuthMethods } from "../apps/desktop/src/lib/providerDisplayNames";

describe("desktop provider fallback auth methods", () => {
  test("keeps Bedrock structured fallback fields intact", () => {
    const methods = fallbackAuthMethods("bedrock");

    expect(methods.map((method) => method.id)).toEqual([
      "aws_default",
      "aws_profile",
      "aws_keys",
      "api_key",
    ]);
    expect(
      methods.find((method) => method.id === "aws_default")?.fields?.map((field) => field.id),
    ).toEqual(["region"]);
    expect(
      methods.find((method) => method.id === "aws_profile")?.fields?.map((field) => field.id),
    ).toEqual(["profile", "region"]);
    expect(
      methods.find((method) => method.id === "aws_keys")?.fields?.map((field) => field.id),
    ).toEqual(["accessKeyId", "secretAccessKey", "sessionToken", "region"]);
    expect(
      methods.find((method) => method.id === "api_key")?.fields?.map((field) => field.id),
    ).toEqual(["apiKey", "region"]);
  });

  test("keeps the LM Studio fallback empty until live auth methods arrive", () => {
    expect(fallbackAuthMethods("lmstudio")).toEqual([]);
  });
});
