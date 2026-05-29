import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import type { SessionEvent } from "../../src/server/protocol";
import type { AgentConfig } from "../../src/types";
import {
  fs,
  makeConfig,
  makeSession,
  os,
  path,
  REAL_AGENT,
  resetAgentSessionMocks,
  waitForCondition,
} from "./agentSession.harness";

type SkillsCatalogEvent = Extract<SessionEvent, { type: "skills_catalog" }>;

function marketplaceFetch(skillNames: string[]): typeof fetch {
  const doc = {
    name: "cowork-test",
    interface: { displayName: "Cowork Test" },
    plugins: [],
    skills: skillNames.map((name) => ({
      name,
      source: { source: "local", path: `./skills/${name}` },
      policy: { installation: "AVAILABLE", authentication: "NONE" },
      category: "Authoring",
    })),
  };
  return (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (
      url.startsWith("https://api.github.com/") &&
      url.includes("/contents/.agents/plugins/marketplace.json")
    ) {
      return new Response(
        JSON.stringify({
          type: "file",
          name: "marketplace.json",
          path: ".agents/plugins/marketplace.json",
          download_url: "https://download.test/marketplace.json",
        }),
        { headers: { "content-type": "application/json" } },
      );
    }
    if (url === "https://download.test/marketplace.json") {
      return new Response(JSON.stringify(doc), { headers: { "content-type": "application/json" } });
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
}

describe("AgentSession skills marketplace", () => {
  beforeEach(async () => {
    await resetAgentSessionMocks();
  });

  afterAll(() => {
    mock.module("../../src/agent", () => REAL_AGENT);
    mock.restore();
  });

  test("getSkillsCatalog delivers available marketplace skills in one emit, deduped against installed", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "session-skills-market-"));
    const skillsDir = path.join(root, "home", ".cowork", "skills");
    for (const name of ["create-skill", "create-plugin"]) {
      await fs.mkdir(path.join(skillsDir, name), { recursive: true });
      await fs.writeFile(
        path.join(skillsDir, name, "SKILL.md"),
        `---\nname: ${name}\ndescription: installed ${name}\n---\n# ${name}\n`,
        "utf-8",
      );
    }

    const originalFetch = globalThis.fetch;
    globalThis.fetch = marketplaceFetch(["create-skill", "create-plugin", "apple-native-transcribe"]);

    try {
      const cfg: AgentConfig = { ...makeConfig(root), skillsDirs: [skillsDir] };
      const { session, events } = makeSession({ config: cfg });

      await session.getSkillsCatalog();
      await waitForCondition(() => events.some((event) => event.type === "skills_catalog"));

      const catalogEvents = events.filter(
        (event): event is SkillsCatalogEvent => event.type === "skills_catalog",
      );
      const last = catalogEvents.at(-1);
      // create-skill + create-plugin are installed, so only the uninstalled marketplace
      // skill is offered — and it's delivered in this single emit (not a partial local one).
      expect(last?.catalog.availableSkills.map((skill) => skill.name)).toEqual([
        "apple-native-transcribe",
      ]);
      expect(last?.availableSkillsPartial).toBeUndefined();
    } finally {
      globalThis.fetch = originalFetch;
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
