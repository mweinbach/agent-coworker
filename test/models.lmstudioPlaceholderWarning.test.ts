import { beforeEach, describe, expect, test } from "bun:test";
import {
  resetLmStudioPlaceholderWarningCacheForTests,
  resolveModelMetadata,
} from "../src/models/metadata";

const MODEL_ID = "qwen/qwen3.6-27b";

function downFetch(): typeof fetch {
  return (async () => {
    throw new TypeError("fetch failed: connection refused");
  }) as unknown as typeof fetch;
}

function upFetch(): typeof fetch {
  return (async () =>
    new Response(
      JSON.stringify({
        models: [
          {
            type: "llm",
            key: MODEL_ID,
            display_name: "Qwen 3.6 27B",
            loaded_instances: [],
            max_context_length: 32768,
          },
        ],
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    )) as unknown as typeof fetch;
}

async function resolveWithPlaceholder(fetchImpl: typeof fetch, log: (msg: string) => void) {
  return await resolveModelMetadata("lmstudio", MODEL_ID, {
    allowPlaceholder: true,
    source: "model",
    env: {},
    fetchImpl,
    log,
  });
}

describe("LM Studio placeholder metadata warning dedupe", () => {
  beforeEach(() => {
    resetLmStudioPlaceholderWarningCacheForTests();
  });

  test("warns once per server+model while the server stays unreachable", async () => {
    const logs: string[] = [];
    const log = (msg: string) => logs.push(msg);

    const first = await resolveWithPlaceholder(downFetch(), log);
    const second = await resolveWithPlaceholder(downFetch(), log);

    expect(first.id).toBe(MODEL_ID);
    expect(second.id).toBe(MODEL_ID);
    expect(logs.filter((msg) => msg.includes("conservative placeholder"))).toHaveLength(1);
  });

  test("warns again after the model resolves successfully (per outage, not per process)", async () => {
    const logs: string[] = [];
    const log = (msg: string) => logs.push(msg);

    await resolveWithPlaceholder(downFetch(), log);
    const recovered = await resolveWithPlaceholder(upFetch(), log);
    expect(recovered.displayName).toBe("Qwen 3.6 27B");
    await resolveWithPlaceholder(downFetch(), log);

    expect(logs.filter((msg) => msg.includes("conservative placeholder"))).toHaveLength(2);
  });
});
