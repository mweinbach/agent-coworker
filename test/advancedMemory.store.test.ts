import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  AdvancedMemoryStore,
  CHATS_FOLDER,
  MAX_ADVANCED_MEMORY_BODY_LENGTH,
  MAX_ADVANCED_MEMORY_DESCRIPTION_LENGTH,
  MAX_ADVANCED_MEMORY_NAME_LENGTH,
  MEMORY_INDEX_HEADING,
  normalizeMemoryFolderName,
  resolveAdvancedMemoryAccessRoots,
  resolveMemoryFolderName,
  slugifyMemoryName,
} from "../src/advancedMemory/store";
import type { AgentConfig } from "../src/types";
import { pinHome } from "./helpers/platform";

let tmpDir: string;
let store: AdvancedMemoryStore;
let restoreHome: () => void;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "adv-mem-"));
  restoreHome = pinHome(tmpDir);
  store = new AdvancedMemoryStore(tmpDir);
});

afterEach(async () => {
  restoreHome();
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("AdvancedMemoryStore", () => {
  test("write → index regen → read round-trips frontmatter", async () => {
    const entry = await store.writeMemory("proj", {
      name: "cs-report skill",
      description: "editorial report skill",
      type: "project",
      originSessionId: "sess-1",
      body: "Built a skill named cs-report.",
    });
    expect(entry.slug).toBe("cs-report-skill");

    const read = await store.readMemory("proj", "cs-report-skill");
    expect(read).not.toBeNull();
    expect(read?.name).toBe("cs-report skill");
    expect(read?.description).toBe("editorial report skill");
    expect(read?.type).toBe("project");
    expect(read?.originSessionId).toBe("sess-1");
    expect(read?.body).toBe("Built a skill named cs-report.");

    const indexRaw = await fs.readFile(path.join(tmpDir, "proj", "MEMORY.md"), "utf-8");
    expect(indexRaw.startsWith(MEMORY_INDEX_HEADING)).toBe(true);
    expect(indexRaw).toContain("[cs-report skill](cs-report-skill.md)");
    expect(indexRaw).toContain("editorial report skill");
  });

  test("edit updates an existing memory and preserves untouched fields", async () => {
    await store.writeMemory("proj", {
      name: "rule",
      description: "first",
      type: "feedback",
      originSessionId: "sess-orig",
      body: "original",
    });
    const edited = await store.editMemory("proj", "rule", { body: "updated body" });
    expect(edited?.body).toBe("updated body");
    expect(edited?.description).toBe("first");
    expect(edited?.type).toBe("feedback");
    // originSessionId must survive an edit that doesn't supply one.
    expect(edited?.originSessionId).toBe("sess-orig");
  });

  test("concurrent edits preserve independent fields across store instances", async () => {
    await store.writeMemory("proj", {
      name: "rule",
      description: "original description",
      body: "original body",
    });
    const otherStore = new AdvancedMemoryStore(tmpDir);
    await Promise.all([
      store.editMemory("proj", "rule", { description: "updated description" }),
      otherStore.editMemory("proj", "rule", { body: "updated body" }),
    ]);

    expect(await store.readMemory("proj", "rule")).toMatchObject({
      description: "updated description",
      body: "updated body",
    });
    expect(await fs.readFile(path.join(tmpDir, "proj", "MEMORY.md"), "utf8")).toContain(
      "updated description",
    );
  });

  test("a failed atomic replacement leaves the existing memory intact", async () => {
    await store.writeMemory("proj", { name: "rule", description: "original", body: "keep me" });
    const filePath = path.join(tmpDir, "proj", "rule.md");
    const originalRename = fs.rename;
    const rename = spyOn(fs, "rename").mockImplementation(async (source, destination) => {
      if (String(destination) === filePath) {
        throw Object.assign(new Error("disk full"), { code: "ENOSPC" });
      }
      await originalRename(source, destination);
    });
    try {
      await expect(store.editMemory("proj", "rule", { body: "new body" })).rejects.toThrow(
        "disk full",
      );
    } finally {
      rename.mockRestore();
    }
    expect((await store.readMemory("proj", "rule"))?.body).toBe("keep me");
  });

  test("delete removes the file and regenerates the index", async () => {
    await store.writeMemory("proj", { name: "a", description: "da", body: "ba" });
    await store.writeMemory("proj", { name: "b", description: "db", body: "bb" });
    expect(await store.deleteMemory("proj", "a")).toBe(true);
    const remaining = await store.listMemories("proj");
    expect(remaining.map((m) => m.slug)).toEqual(["b"]);
    const indexRaw = await fs.readFile(path.join(tmpDir, "proj", "MEMORY.md"), "utf-8");
    expect(indexRaw).not.toContain("(a.md)");
    expect(indexRaw).toContain("(b.md)");
  });

  test.each(["write", "edit", "delete"] as const)(
    "%s rejects normalized index names without changing existing files",
    async (operation) => {
      await store.writeMemory("proj", { name: "existing", description: "keep", body: "keep me" });
      const folder = store.folderPath("proj");
      const names = (await fs.readdir(folder)).sort();
      const before = await Promise.all(
        names.map((name) => fs.readFile(path.join(folder, name), "utf8")),
      );
      for (const slug of [
        "memory",
        " MeMoRy.Md ",
        "./MEMORY.md",
        "../MEMORY.md",
        "\\MEMORY.MD",
        "MEMORY/",
        "!!!",
      ]) {
        const mutation =
          operation === "write"
            ? store.writeMemory("proj", {
                slug,
                name: "separate title",
                description: "changed",
                body: "overwrite",
              })
            : operation === "edit"
              ? store.editMemory("proj", slug, { body: "overwrite" })
              : store.deleteMemory("proj", slug);
        await expect(mutation).rejects.toThrow(/MEMORY\.md.*reserved/i);
      }
      expect((await fs.readdir(folder)).sort()).toEqual(names);
      expect(
        await Promise.all(names.map((name) => fs.readFile(path.join(folder, name), "utf8"))),
      ).toEqual(before);
    },
  );

  test("rejects index names inferred from a title before creating a memory folder", async () => {
    for (const name of ["Memory", "MEMORY.md", "!!!", ""]) {
      await expect(
        store.writeMemory("uncreated", { name, description: "", body: "overwrite" }),
      ).rejects.toThrow(/MEMORY\.md.*reserved/i);
    }
    await expect(fs.stat(store.folderPath("uncreated"))).rejects.toThrow();
  });

  test("never exposes a case-variant index as an ordinary memory", async () => {
    const folder = store.folderPath("proj");
    await fs.mkdir(folder, { recursive: true });
    const index = `${MEMORY_INDEX_HEADING}\n\n`;
    await fs.writeFile(path.join(folder, "memory.md"), index);
    expect(await store.readMemory("proj", "MEMORY.md")).toBeNull();
    expect(await store.listMemories("proj")).toEqual([]);
    expect(await store.renderIndex("proj")).toBe("");
    expect(await fs.readFile(path.join(folder, "memory.md"), "utf8")).toBe(index);
  });

  test("keeps distinct normalized filenames and display titles usable", async () => {
    const entry = await store.writeMemory("proj", {
      slug: "notes/MEMORY.md",
      name: "MEMORY.md",
      description: "safe path",
      body: "keep me",
    });
    expect(entry.slug).toBe("notes-memory");
    expect(
      (await store.editMemory("proj", "notes/MEMORY.md", { name: "Memory", body: "updated" }))
        ?.body,
    ).toBe("updated");
    expect(await store.deleteMemory("proj", "notes/MEMORY.md")).toBe(true);
    expect(
      await store.writeMemory("proj", {
        slug: " ",
        name: "ordinary",
        description: "blank slug falls back to name",
        body: "safe",
      }),
    ).toMatchObject({ slug: "ordinary", body: "safe" });
    expect(
      await store.writeMemory("proj", {
        slug: "memory.md.md",
        name: "distinct filename",
        description: "",
        body: "not the index",
      }),
    ).toMatchObject({ slug: "memory.md", body: "not the index" });
  });

  test("rejects folder names that escape the memories root", async () => {
    const outsideName = `outside-${path.basename(tmpDir)}`;
    await expect(
      store.writeMemory(`../${outsideName}`, {
        name: "escaped",
        description: "bad",
        body: "should not be written",
      }),
    ).rejects.toThrow("Invalid memory folder");
    await expect(fs.stat(path.join(path.dirname(tmpDir), outsideName))).rejects.toThrow();
  });

  test("rejects oversized memory fields in the shared store path", async () => {
    await expect(
      store.writeMemory("proj", {
        name: "n".repeat(MAX_ADVANCED_MEMORY_NAME_LENGTH + 1),
        description: "ok",
        body: "ok",
      }),
    ).rejects.toThrow(/advanced memory name/i);

    await expect(
      store.writeMemory("proj", {
        name: "ok",
        description: "d".repeat(MAX_ADVANCED_MEMORY_DESCRIPTION_LENGTH + 1),
        body: "ok",
      }),
    ).rejects.toThrow(/advanced memory description/i);

    await expect(
      store.writeMemory("proj", {
        name: "ok",
        description: "ok",
        body: "b".repeat(MAX_ADVANCED_MEMORY_BODY_LENGTH + 1),
      }),
    ).rejects.toThrow(/advanced memory body/i);
  });

  test("renderPromptSection surfaces active and chats indexes", async () => {
    await store.writeMemory("proj", { name: "p1", description: "proj memory", body: "x" });
    await store.writeMemory(CHATS_FOLDER, { name: "c1", description: "chat memory", body: "y" });
    const section = await store.renderPromptSection("proj");
    expect(section).toContain("## Memory");
    expect(section).toContain("recallMemory");
    expect(section).toContain("manageMemory");
    expect(section).toContain("proj memory");
    expect(section).toContain("chat memory");
  });

  test("renderPromptSection truncates oversized names and descriptions from existing files", async () => {
    const dir = path.join(tmpDir, "proj");
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(
      path.join(dir, "legacy.md"),
      [
        "---",
        `name: "${"n".repeat(MAX_ADVANCED_MEMORY_NAME_LENGTH + 20)}"`,
        `description: "${"d".repeat(MAX_ADVANCED_MEMORY_DESCRIPTION_LENGTH + 20)}"`,
        "metadata:",
        '  node_type: "memory"',
        '  type: "note"',
        "---",
        "",
        "body",
      ].join("\n"),
      "utf-8",
    );

    const section = await store.renderPromptSection("proj");
    expect(section).toContain("...[truncated]");
    expect(section).not.toContain("n".repeat(MAX_ADVANCED_MEMORY_NAME_LENGTH + 20));
    expect(section).not.toContain("d".repeat(MAX_ADVANCED_MEMORY_DESCRIPTION_LENGTH + 20));
  });

  test("renderPromptSection is empty when no memories exist", async () => {
    expect(await store.renderPromptSection("proj")).toBe("");
  });
});

describe("normalizeMemoryFolderName", () => {
  test("accepts only a single memories directory segment", () => {
    expect(normalizeMemoryFolderName(" proj ")).toBe("proj");
    expect(normalizeMemoryFolderName(CHATS_FOLDER)).toBe(CHATS_FOLDER);
    for (const folder of ["", ".", "..", "../project", "nested/project", "nested\\project"]) {
      expect(() => normalizeMemoryFolderName(folder)).toThrow("Invalid memory folder");
    }
  });
});

describe("slugifyMemoryName", () => {
  test("normalizes names the same way memory files do", () => {
    expect(slugifyMemoryName(" Preference Note.md ")).toBe("preference-note");
    expect(slugifyMemoryName("!!!")).toBe("memory");
  });
});

describe("resolveMemoryFolderName", () => {
  test("returns (chats) for one-off chat sessions", () => {
    const restoreHome = pinHome(tmpDir);
    try {
      const workspace = path.join(tmpDir, ".cowork", "chats", "20260101-x-abc");
      const config = {
        workingDirectory: workspace,
        projectCoworkDir: path.join(workspace, ".cowork"),
      } as AgentConfig;
      expect(resolveMemoryFolderName(config)).toBe(CHATS_FOLDER);
    } finally {
      restoreHome();
    }
  });

  test("derives a readable slug plus a stable path hash from the workspace root", () => {
    const workspace = path.join(tmpDir, "My Project");
    const config = {
      workingDirectory: workspace,
      projectCoworkDir: path.join(workspace, ".cowork"),
    } as AgentConfig;
    expect(resolveMemoryFolderName(config)).toMatch(/^my-project-[a-f0-9]{12}$/);
  });

  test("does not collide for unrelated projects with the same basename", () => {
    const firstWorkspace = path.join(tmpDir, "client-a", "app");
    const secondWorkspace = path.join(tmpDir, "client-b", "app");
    const first = {
      workingDirectory: firstWorkspace,
      projectCoworkDir: path.join(firstWorkspace, ".cowork"),
    } as AgentConfig;
    const second = {
      workingDirectory: secondWorkspace,
      projectCoworkDir: path.join(secondWorkspace, ".cowork"),
    } as AgentConfig;

    expect(resolveMemoryFolderName(first)).toMatch(/^app-[a-f0-9]{12}$/);
    expect(resolveMemoryFolderName(second)).toMatch(/^app-[a-f0-9]{12}$/);
    expect(resolveMemoryFolderName(first)).not.toBe(resolveMemoryFolderName(second));
  });
});

describe("resolveAdvancedMemoryAccessRoots", () => {
  test("project workspaces write active folder and read active plus chats", () => {
    const workspace = path.join(tmpDir, "My Project");
    const memoriesDir = path.join(tmpDir, ".cowork", "memories");
    const config = {
      workingDirectory: workspace,
      projectCoworkDir: path.join(workspace, ".cowork"),
      memoriesDir,
    } as AgentConfig;
    const activeFolder = resolveMemoryFolderName(config);

    expect(resolveAdvancedMemoryAccessRoots(config)).toEqual({
      memoriesDir,
      activeFolder,
      readableFolders: [activeFolder, CHATS_FOLDER],
      writableFolder: activeFolder,
      readRoots: [path.join(memoriesDir, activeFolder), path.join(memoriesDir, CHATS_FOLDER)],
      writeRoots: [path.join(memoriesDir, activeFolder)],
    });
  });
});
