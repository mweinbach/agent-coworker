import { describe, expect, test } from "bun:test";

import {
  buildMentionCatalog,
  detectActiveMentionQuery,
  extractReferencesFromText,
  MAX_TURN_REFERENCES,
  parseComposerSegments,
} from "../apps/desktop/src/ui/chat/composerMentions";

function skill(name: string, extra: Record<string, unknown> = {}): any {
  return {
    name,
    path: `/skills/${name}/SKILL.md`,
    source: "built-in",
    enabled: true,
    triggers: [],
    description: `${name} skill`,
    ...extra,
  };
}

function pluginCatalog(names: string[]): any {
  return {
    plugins: names.map((name) => ({
      id: name,
      name,
      displayName: `${name} suite`,
      description: `${name} plugin`,
      scope: "user",
      discoveryKind: "direct",
      warnings: [],
      installed: true,
      enabled: true,
      rootDir: "",
      manifestPath: "",
      skillsPath: "",
      skills: [],
      mcpServers: [],
      apps: [],
    })),
    availablePlugins: [],
    warnings: [],
  };
}

describe("composerMentions.buildMentionCatalog", () => {
  test("collects enabled skills and plugins; names are longest-first", () => {
    const catalog = buildMentionCatalog(
      [skill("pdf"), skill("pdf-tools"), skill("disabled-one", { enabled: false })],
      pluginCatalog(["acme"]),
    );
    expect(catalog.kindByName.get("pdf")).toBe("skill");
    expect(catalog.kindByName.get("pdf-tools")).toBe("skill");
    expect(catalog.kindByName.get("acme")).toBe("plugin");
    expect(catalog.kindByName.has("disabled-one")).toBe(false);
    // longest-first ordering enables greedy matching
    expect(catalog.names.indexOf("pdf-tools")).toBeLessThan(catalog.names.indexOf("pdf"));
  });

  test("skill wins when a name is both a skill and a plugin", () => {
    const catalog = buildMentionCatalog([skill("shared")], pluginCatalog(["shared"]));
    expect(catalog.kindByName.get("shared")).toBe("skill");
    // The shadowed plugin is intentionally hidden so selecting it cannot emit a skill ref.
    expect(catalog.items.filter((i) => i.name === "shared")).toHaveLength(1);
    expect(catalog.items.find((i) => i.name === "shared")?.kind).toBe("skill");
  });

  test("badges skills by source and plugin-owned skills by plugin display name", () => {
    const catalog = buildMentionCatalog(
      [
        skill("local", { source: "project" }),
        skill("from-plugin", { plugin: { displayName: "Acme Suite" } }),
      ],
      null,
    );
    expect(catalog.items.find((i) => i.name === "local")?.badge).toBe("Project");
    expect(catalog.items.find((i) => i.name === "from-plugin")?.badge).toBe("Acme Suite");
  });
});

describe("composerMentions.parseComposerSegments", () => {
  const catalog = buildMentionCatalog(
    [skill("code"), skill("code-review"), skill("documents")],
    pluginCatalog(["acme"]),
  );

  test("longest match wins (@code-review over @code)", () => {
    const segments = parseComposerSegments("run @code-review now", catalog);
    const mention = segments.find((s) => s.type === "mention");
    expect(mention).toMatchObject({ type: "mention", kind: "skill", name: "code-review" });
  });

  test("matches a plugin mention", () => {
    const segments = parseComposerSegments("use @acme please", catalog);
    expect(segments.find((s) => s.type === "mention")).toMatchObject({
      kind: "plugin",
      name: "acme",
    });
  });

  test("ignores @ that is not at a word boundary (e.g. an email)", () => {
    const segments = parseComposerSegments("ping me@code today", catalog);
    expect(segments.some((s) => s.type === "mention")).toBe(false);
  });

  test("does not match an unknown name that merely starts with a known one", () => {
    const segments = parseComposerSegments("the @codex thing", catalog);
    expect(segments.some((s) => s.type === "mention")).toBe(false);
  });

  test("matches at start of string and before trailing punctuation", () => {
    const segments = parseComposerSegments("@documents.", catalog);
    const mention = segments.find((s) => s.type === "mention");
    expect(mention).toMatchObject({ name: "documents", start: 0, end: 10 });
    expect(segments.at(-1)).toMatchObject({ type: "text", text: "." });
  });

  test("matches mention case-insensitively but keeps the canonical name", () => {
    const segments = parseComposerSegments("@Documents now", catalog);
    const mention = segments.find((s) => s.type === "mention");
    expect(mention).toMatchObject({ name: "documents", raw: "@Documents" });
  });
});

describe("composerMentions.extractReferencesFromText", () => {
  const catalog = buildMentionCatalog([skill("a"), skill("b")], pluginCatalog(["p"]));

  test("dedupes and preserves first-occurrence order", () => {
    const refs = extractReferencesFromText("@b then @a then @b and @p", catalog);
    expect(refs).toEqual([
      { kind: "skill", name: "b" },
      { kind: "skill", name: "a" },
      { kind: "plugin", name: "p" },
    ]);
  });

  test("returns nothing when there are no mentions", () => {
    expect(extractReferencesFromText("just plain text", catalog)).toEqual([]);
  });

  test("caps references at the server schema limit", () => {
    const skills = Array.from({ length: MAX_TURN_REFERENCES + 5 }, (_, index) =>
      skill(`s-${index}`),
    );
    const manyCatalog = buildMentionCatalog(skills, null);
    const text = skills.map((entry) => `@${entry.name}`).join(" ");
    const refs = extractReferencesFromText(text, manyCatalog);
    expect(refs).toHaveLength(MAX_TURN_REFERENCES);
    expect(refs.at(-1)).toEqual({ kind: "skill", name: `s-${MAX_TURN_REFERENCES - 1}` });
  });
});

describe("composerMentions.detectActiveMentionQuery", () => {
  test("detects an in-progress query at the caret", () => {
    const text = "hello @doc";
    expect(detectActiveMentionQuery(text, text.length)).toEqual({ start: 6, query: "doc" });
  });

  test("detects an empty query right after typing @", () => {
    const text = "hello @";
    expect(detectActiveMentionQuery(text, text.length)).toEqual({ start: 6, query: "" });
  });

  test("returns null after a completed token followed by a space", () => {
    const text = "hello @documents ";
    expect(detectActiveMentionQuery(text, text.length)).toBeNull();
  });

  test("returns null when @ is not at a word boundary", () => {
    const text = "mailto me@host";
    expect(detectActiveMentionQuery(text, text.length)).toBeNull();
  });

  test("returns null when there is no @ before the caret", () => {
    expect(detectActiveMentionQuery("plain words", 5)).toBeNull();
  });
});
