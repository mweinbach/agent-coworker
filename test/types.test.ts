import { describe, expect, test } from "bun:test";
import { resolveProviderName } from "../src/types";

describe("resolveProviderName", () => {
  test("returns exact provider names", () => {
    expect(resolveProviderName("google")).toBe("google");
    expect(resolveProviderName("openai")).toBe("openai");
    expect(resolveProviderName("anthropic")).toBe("anthropic");
    expect(resolveProviderName("bedrock")).toBe("bedrock");
    expect(resolveProviderName("baseten")).toBe("baseten");
    expect(resolveProviderName("together")).toBe("together");
    expect(resolveProviderName("fireworks")).toBe("fireworks");
    expect(resolveProviderName("nvidia")).toBe("nvidia");
    expect(resolveProviderName("lmstudio")).toBe("lmstudio");
    expect(resolveProviderName("minimax")).toBe("minimax");
    expect(resolveProviderName("opencode-go")).toBe("opencode-go");
    expect(resolveProviderName("opencode-zen")).toBe("opencode-zen");
    expect(resolveProviderName("codex-cli")).toBe("codex-cli");
  });

  test("returns null for unknown provider names", () => {
    expect(resolveProviderName("legacy-google-cli")).toBeNull();
    expect(resolveProviderName("legacy-anthropic-cli")).toBeNull();
  });
});
