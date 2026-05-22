import { afterEach, describe, expect, test } from "bun:test";
import type { Interactions } from "@google/genai";
import { createResearchInteractionStream } from "../src/server/research/researchRuntime";
import { DEFAULT_RESEARCH_AGENT_ID, RESEARCH_AGENT_ID_VALUES } from "../src/server/research/types";

const originalFetchDescriptor = Object.getOwnPropertyDescriptor(globalThis, "fetch");

function googleSseResponse(events: Array<Record<string, unknown>>): Response {
  return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

describe("research Interactions runtime", () => {
  afterEach(() => {
    if (originalFetchDescriptor) {
      Object.defineProperty(globalThis, "fetch", originalFetchDescriptor);
    }
  });

  test("Deep Research SDK contract stays aligned with supported agents and config", () => {
    const params = {
      agent: DEFAULT_RESEARCH_AGENT_ID,
      input: "Investigate current benchmark movement.",
      background: true,
      stream: true,
      store: true,
      agent_config: {
        type: "deep-research",
        thinking_summaries: "auto",
        visualization: "auto",
        collaborative_planning: true,
      },
    } satisfies Interactions.CreateAgentInteractionParamsStreaming;

    expect(RESEARCH_AGENT_ID_VALUES).toContain(params.agent);
    expect(params.agent_config.type).toBe("deep-research");
  });

  test("createResearchInteractionStream posts the current Deep Research request body through the SDK", async () => {
    const seen: Array<{ url: string; body: Record<string, unknown> }> = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const bodyText =
        typeof init?.body === "string" ? init.body : await new Response(init?.body).text();
      seen.push({ url: String(input), body: JSON.parse(bodyText) as Record<string, unknown> });
      return googleSseResponse([
        {
          event_type: "interaction.created",
          interaction: { id: "research-interaction", status: "in_progress" },
        },
      ]);
    }) as typeof fetch;

    const stream = await createResearchInteractionStream({
      apiKey: "test-google-api-key",
      input: "Research this.",
      previousInteractionId: "previous-research",
      thinkingSummaries: "none",
      visualization: "off",
      collaborativePlanning: true,
      tools: [{ google_search: {} }, { url_context: {} }],
    });

    const iterator = stream[Symbol.asyncIterator]();
    const first = await iterator.next();

    expect(first.value).toMatchObject({ event_type: "interaction.created" });
    expect(seen).toHaveLength(1);
    expect(seen[0]?.url).toContain("/v1beta/interactions");
    expect(seen[0]?.body).toMatchObject({
      agent: DEFAULT_RESEARCH_AGENT_ID,
      input: "Research this.",
      background: true,
      stream: true,
      store: true,
      previous_interaction_id: "previous-research",
      tools: [{ google_search: {} }, { url_context: {} }],
      agent_config: {
        type: "deep-research",
        thinking_summaries: "none",
        visualization: "off",
        collaborative_planning: true,
      },
    });
  });
});
