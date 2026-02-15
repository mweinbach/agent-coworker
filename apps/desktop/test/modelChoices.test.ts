import { describe, expect, test } from "bun:test";

import { MODEL_CHOICES, modelOptionsForProvider } from "../src/lib/modelChoices";

describe("modelOptionsForProvider", () => {
  test("includes a custom current model as a selectable option", () => {
    const provider = "openai" as const;
    const curated = MODEL_CHOICES[provider];
    expect(curated.length).toBeGreaterThan(0);

    const custom = `custom-model-${crypto.randomUUID()}`;
    const opts = modelOptionsForProvider(provider, custom);
    expect(opts[0]).toBe(custom);
    expect(opts).toContain(custom);
  });

  test("does not duplicate curated models", () => {
    const provider = "openai" as const;
    const curated = MODEL_CHOICES[provider];
    expect(curated.length).toBeGreaterThan(0);

    const existing = curated[0]!;
    const opts = modelOptionsForProvider(provider, `  ${existing}  `);
    const count = opts.filter((m) => m === existing).length;
    expect(count).toBe(1);
  });
});

