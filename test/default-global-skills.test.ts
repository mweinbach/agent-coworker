import { describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  type DefaultSkillSpec,
  defaultGlobalSkillsStateFile,
  ensureDefaultGlobalSkillsInstalled,
} from "../src/skills/defaultGlobalSkills";

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function textResponse(payload: string, status = 200): Response {
  return new Response(payload, {
    status,
    headers: { "content-type": "text/plain; charset=utf-8" },
  });
}

function createGitHubFetchStub(
  tree: Record<string, unknown>,
  files: Record<string, string>,
): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url = String(input);

    if (url.startsWith("https://api.github.com/")) {
      const key = Object.keys(tree)
        .sort((a, b) => b.length - a.length)
        .find((candidate) => url.includes(`/contents/${candidate}`));
      if (!key) return textResponse("not found", 404);
      return jsonResponse(tree[key]);
    }

    if (url in files) {
      return textResponse(files[url]!);
    }

    return textResponse("not found", 404);
  }) as typeof fetch;
}

describe("default global skills bootstrap", () => {
  test("installs curated skills into ~/.cowork/skills and records a one-time state file", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-default-skills-home-"));
    const skills: readonly DefaultSkillSpec[] = [
      { name: "alpha", githubPath: "skills/.curated/alpha" },
      { name: "beta", githubPath: "skills/.curated/beta" },
    ];

    const fetchImpl = createGitHubFetchStub(
      {
        "skills/.curated/alpha": [
          {
            type: "file",
            name: "SKILL.md",
            path: "skills/.curated/alpha/SKILL.md",
            url: "https://api.github.com/repos/test/repo/contents/skills/.curated/alpha/SKILL.md?ref=main",
            download_url: "https://download.test/alpha/SKILL.md",
          },
        ],
        "skills/.curated/beta": [
          {
            type: "file",
            name: "SKILL.md",
            path: "skills/.curated/beta/SKILL.md",
            url: "https://api.github.com/repos/test/repo/contents/skills/.curated/beta/SKILL.md?ref=main",
            download_url: "https://download.test/beta/SKILL.md",
          },
          {
            type: "dir",
            name: "assets",
            path: "skills/.curated/beta/assets",
            url: "https://api.github.com/repos/test/repo/contents/skills/.curated/beta/assets?ref=main",
            download_url: null,
          },
        ],
        "skills/.curated/beta/assets": [
          {
            type: "file",
            name: "example.txt",
            path: "skills/.curated/beta/assets/example.txt",
            url: "https://api.github.com/repos/test/repo/contents/skills/.curated/beta/assets/example.txt?ref=main",
            download_url: "https://download.test/beta/assets/example.txt",
          },
        ],
      },
      {
        "https://download.test/alpha/SKILL.md":
          "---\nname: alpha\ndescription: Alpha skill\n---\nAlpha body\n",
        "https://download.test/beta/SKILL.md":
          "---\nname: beta\ndescription: Beta skill\n---\nBeta body\n",
        "https://download.test/beta/assets/example.txt": "beta asset\n",
      },
    );

    try {
      const result = await ensureDefaultGlobalSkillsInstalled({
        homedir: home,
        repo: "test/repo",
        ref: "main",
        skills,
        fetchImpl,
      });

      expect(result.status).toBe("installed");
      expect(result.installed).toEqual(["alpha", "beta"]);
      expect(
        await fs.readFile(path.join(home, ".cowork", "skills", "alpha", "SKILL.md"), "utf-8"),
      ).toContain("Alpha body");
      expect(
        await fs.readFile(
          path.join(home, ".cowork", "skills", "beta", "assets", "example.txt"),
          "utf-8",
        ),
      ).toBe("beta asset\n");

      const stateFile = defaultGlobalSkillsStateFile(home);
      const state = JSON.parse(await fs.readFile(stateFile, "utf-8")) as {
        repo: string;
        ref: string;
        skills: string[];
      };
      expect(state.repo).toBe("test/repo");
      expect(state.ref).toBe("main");
      expect(state.skills).toEqual(["alpha", "beta"]);
    } finally {
      await fs.rm(home, { recursive: true, force: true });
    }
  });

  test("does not reinstall on later runs once the bootstrap state file exists", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-default-skills-once-"));
    const skills: readonly DefaultSkillSpec[] = [
      { name: "alpha", githubPath: "skills/.curated/alpha" },
    ];

    const fetchImpl = createGitHubFetchStub(
      {
        "skills/.curated/alpha": [
          {
            type: "file",
            name: "SKILL.md",
            path: "skills/.curated/alpha/SKILL.md",
            url: "https://api.github.com/repos/test/repo/contents/skills/.curated/alpha/SKILL.md?ref=main",
            download_url: "https://download.test/alpha/SKILL.md",
          },
        ],
      },
      {
        "https://download.test/alpha/SKILL.md":
          "---\nname: alpha\ndescription: Alpha skill\n---\nAlpha body\n",
      },
    );

    try {
      await ensureDefaultGlobalSkillsInstalled({
        homedir: home,
        repo: "test/repo",
        ref: "main",
        skills,
        fetchImpl,
      });

      await fs.rm(path.join(home, ".cowork", "skills", "alpha"), { recursive: true, force: true });

      const second = await ensureDefaultGlobalSkillsInstalled({
        homedir: home,
        repo: "test/repo",
        ref: "main",
        skills,
        fetchImpl: (async () => {
          throw new Error("should not fetch after one-time bootstrap");
        }) as typeof fetch,
      });

      expect(second.status).toBe("already_installed");
      await expect(fs.access(path.join(home, ".cowork", "skills", "alpha"))).rejects.toBeDefined();
    } finally {
      await fs.rm(home, { recursive: true, force: true });
    }
  });
});
