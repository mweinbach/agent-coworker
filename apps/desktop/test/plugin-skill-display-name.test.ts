import { describe, expect, test } from "bun:test";

import { pluginSkillDisplayName } from "../src/ui/settings/toolAccess/catalogShared";

describe("pluginSkillDisplayName", () => {
  test("prefers the declared interface displayName", () => {
    expect(
      pluginSkillDisplayName("workspace-tools", {
        name: "workspace-tools:documents",
        rawName: "documents",
        interface: { displayName: "Docs Studio" },
      }),
    ).toBe("Docs Studio");
  });

  test("ignores a whitespace-only interface displayName", () => {
    expect(
      pluginSkillDisplayName("workspace-tools", {
        name: "workspace-tools:documents",
        interface: { displayName: "   " },
      }),
    ).toBe("Documents");
  });

  test("prefers rawName over stripping the namespaced name", () => {
    expect(
      pluginSkillDisplayName("workspace-tools", {
        name: "workspace-tools:pdf-export",
        rawName: "apple-native-transcribe",
      }),
    ).toBe("Apple Native Transcribe");
  });

  test("strips the plugin id prefix and title-cases kebab-case names", () => {
    expect(pluginSkillDisplayName("workspace-tools", { name: "workspace-tools:documents" })).toBe(
      "Documents",
    );
    expect(pluginSkillDisplayName("media-kit", { name: "media-kit:apple-native-transcribe" })).toBe(
      "Apple Native Transcribe",
    );
  });

  test("title-cases names without a plugin prefix", () => {
    expect(pluginSkillDisplayName("workspace-tools", { name: "pdf-export" })).toBe("Pdf Export");
    expect(pluginSkillDisplayName("workspace-tools", { name: "documents" })).toBe("Documents");
  });

  test("only strips the prefix of the owning plugin", () => {
    expect(pluginSkillDisplayName("other-plugin", { name: "workspace-tools:documents" })).toBe(
      "Workspace Tools:documents",
    );
  });

  test("falls back to the raw name when nothing remains after splitting", () => {
    expect(pluginSkillDisplayName("workspace-tools", { name: "workspace-tools:---" })).toBe(
      "workspace-tools:---",
    );
  });
});
