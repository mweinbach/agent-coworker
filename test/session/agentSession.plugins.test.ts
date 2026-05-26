import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import type { AgentConfig } from "../../src/types";
import type { TodoItem } from "./agentSession.harness";
import {
  AgentSession,
  ASK_SKIP_TOKEN,
  createExperimentalA2uiSurfaceManager,
  createRuntime,
  defaultSupportedModel,
  flushAsyncWork,
  fs,
  getSupportedModel,
  isRecord,
  MAX_ATTACHMENT_BASE64_SIZE,
  MAX_ATTACHMENT_INLINE_BYTE_SIZE,
  MAX_TURN_ATTACHMENT_COUNT,
  MAX_TURN_ATTACHMENT_TOTAL_BASE64_SIZE,
  makeConfig,
  makeEmit,
  makeSession,
  makeSessionBackupFactory,
  mockClosePooledCodexAppServerClient,
  mockConnectModelProvider,
  mockGenerateSessionTitle,
  mockGetAiCoworkerPaths,
  mockRunTurn,
  mockWritePersistedSessionSnapshot,
  os,
  path,
  REAL_AGENT,
  resetAgentSessionMocks,
  SessionCostTracker,
  waitForCondition,
  withEnv,
} from "./agentSession.harness";

describe("AgentSession", () => {
  beforeEach(async () => {
    await resetAgentSessionMocks();
  });

  afterAll(() => {
    mock.module("../../src/agent", () => REAL_AGENT);
    mock.restore();
  });

  describe("plugins", () => {
    async function makeTmpDir(prefix = "session-plugins-test-"): Promise<string> {
      return await fs.mkdtemp(path.join(os.tmpdir(), prefix));
    }

    async function createPluginSource(rootDir: string, name = "figma-toolkit"): Promise<void> {
      await fs.mkdir(path.join(rootDir, ".codex-plugin"), { recursive: true });
      await fs.mkdir(path.join(rootDir, "skills", "import-frame"), { recursive: true });
      await fs.writeFile(
        path.join(rootDir, ".codex-plugin", "plugin.json"),
        `${JSON.stringify(
          {
            name,
            description: "Plugin helpers",
            interface: {
              displayName: "Figma Toolkit",
            },
          },
          null,
          2,
        )}\n`,
        "utf-8",
      );
      await fs.writeFile(
        path.join(rootDir, "skills", "import-frame", "SKILL.md"),
        [
          "---",
          "name: import-frame",
          "description: Import a frame",
          "---",
          "",
          "# Import frame",
        ].join("\n"),
        "utf-8",
      );
    }

    test("user-scoped plugin installs request shared workspace refresh propagation", async () => {
      const root = await makeTmpDir();
      const home = path.join(root, "home");
      const sourceRoot = path.join(root, "incoming", "figma-toolkit");
      const refreshSkillsAcrossWorkspaceSessionsImpl = mock(async () => {});
      await createPluginSource(sourceRoot);

      const cfg: AgentConfig = {
        ...makeConfig(root),
        workspaceAgentsDir: path.join(root, ".agents"),
        userAgentsDir: path.join(home, ".agents"),
        workspacePluginsDir: path.join(root, ".agents", "plugins"),
        userPluginsDir: path.join(home, ".agents", "plugins"),
      };
      const { session } = makeSession({
        config: cfg,
        refreshSkillsAcrossWorkspaceSessionsImpl,
      });

      await session.installPlugins(sourceRoot, "user");

      expect(refreshSkillsAcrossWorkspaceSessionsImpl).toHaveBeenCalledWith({
        workingDirectory: root,
        sourceSessionId: session.id,
        allWorkspaces: true,
      });
    });

    test("workspace-scoped plugin installs keep refresh propagation scoped to the current workspace", async () => {
      const root = await makeTmpDir();
      const home = path.join(root, "home");
      const sourceRoot = path.join(root, "incoming", "figma-toolkit");
      const refreshSkillsAcrossWorkspaceSessionsImpl = mock(async () => {});
      await createPluginSource(sourceRoot);

      const cfg: AgentConfig = {
        ...makeConfig(root),
        workspaceAgentsDir: path.join(root, ".agents"),
        userAgentsDir: path.join(home, ".agents"),
        workspacePluginsDir: path.join(root, ".agents", "plugins"),
        userPluginsDir: path.join(home, ".agents", "plugins"),
      };
      const { session } = makeSession({
        config: cfg,
        refreshSkillsAcrossWorkspaceSessionsImpl,
      });

      await session.installPlugins(sourceRoot, "workspace");

      expect(refreshSkillsAcrossWorkspaceSessionsImpl).toHaveBeenCalledWith({
        workingDirectory: root,
        sourceSessionId: session.id,
      });
    });

    test("plugin catalog reads emit local catalog before remote marketplace hydration finishes", async () => {
      const root = await makeTmpDir();
      const home = path.join(root, "home");
      const originalFetch = globalThis.fetch;
      const fetchCalls: string[] = [];
      let releaseMarketplaceContent!: (response: Response) => void;
      const pendingMarketplaceContent = new Promise<Response>((resolve) => {
        releaseMarketplaceContent = resolve;
      });
      const fetchImpl = mock(async (input: RequestInfo | URL) => {
        fetchCalls.push(String(input));
        if (fetchCalls.length === 1) {
          return await pendingMarketplaceContent;
        }
        return new Response(JSON.stringify({ name: "cowork-test", plugins: [] }), {
          headers: { "content-type": "application/json" },
        });
      });
      globalThis.fetch = fetchImpl as typeof fetch;

      try {
        const cfg: AgentConfig = {
          ...makeConfig(root),
          workspaceAgentsDir: path.join(root, ".agents"),
          userAgentsDir: path.join(home, ".agents"),
          workspacePluginsDir: path.join(root, ".agents", "plugins"),
          userPluginsDir: path.join(home, ".agents", "plugins"),
        };
        const { session, events } = makeSession({ config: cfg });

        const result = await Promise.race([
          session.getPluginsCatalog().then(() => "resolved"),
          new Promise<string>((resolve) => setTimeout(() => resolve("timeout"), 50)),
        ]);

        expect(result).toBe("resolved");
        expect(events.filter((event) => event.type === "plugins_catalog")).toHaveLength(1);
        await waitForCondition(() => fetchCalls.length === 1);
        expect(fetchCalls).toHaveLength(1);

        releaseMarketplaceContent(
          new Response(
            JSON.stringify({
              type: "file",
              name: "marketplace.json",
              path: ".agents/plugins/marketplace.json",
              url: "https://api.github.com/repos/mweinbach/cowork-skills-plugins/contents/.agents/plugins/marketplace.json?ref=main",
              download_url: "https://download.test/marketplace.json",
            }),
            { headers: { "content-type": "application/json" } },
          ),
        );
        await waitForCondition(
          () => events.filter((event) => event.type === "plugins_catalog").length >= 2,
        );
        expect(fetchCalls).toEqual([
          "https://api.github.com/repos/mweinbach/cowork-skills-plugins/contents/.agents/plugins/marketplace.json?ref=main",
          "https://download.test/marketplace.json",
        ]);
      } finally {
        globalThis.fetch = originalFetch;
        await fs.rm(root, { recursive: true, force: true });
      }
    });

    test("stale remote plugin catalog refreshes do not override later mutations", async () => {
      const root = await makeTmpDir();
      const home = path.join(root, "home");
      const sourceRoot = path.join(home, ".agents", "plugins", "figma-toolkit");
      const originalFetch = globalThis.fetch;
      const fetchCalls: string[] = [];
      let releaseMarketplaceContent!: (response: Response) => void;
      const pendingMarketplaceContent = new Promise<Response>((resolve) => {
        releaseMarketplaceContent = resolve;
      });
      const fetchImpl = mock(async (input: RequestInfo | URL) => {
        fetchCalls.push(String(input));
        if (fetchCalls.length === 1) {
          return await pendingMarketplaceContent;
        }
        return new Response(JSON.stringify({ name: "cowork-test", plugins: [] }), {
          headers: { "content-type": "application/json" },
        });
      });
      globalThis.fetch = fetchImpl as typeof fetch;

      try {
        await createPluginSource(sourceRoot);
        const cfg: AgentConfig = {
          ...makeConfig(root),
          workspaceAgentsDir: path.join(root, ".agents"),
          userAgentsDir: path.join(home, ".agents"),
          workspacePluginsDir: path.join(root, ".agents", "plugins"),
          userPluginsDir: path.join(home, ".agents", "plugins"),
        };
        const { session, events } = makeSession({ config: cfg });

        await session.getPluginsCatalog();
        await waitForCondition(() => fetchCalls.length === 1);
        expect(events.filter((event) => event.type === "plugins_catalog")).toHaveLength(1);

        await session.disablePlugin("figma-toolkit", "user");
        await waitForCondition(
          () => events.filter((event) => event.type === "plugins_catalog").length >= 2,
        );
        const mutationCatalog = events
          .filter((event) => event.type === "plugins_catalog")
          .at(-1);
        expect(mutationCatalog?.catalog.plugins[0]?.enabled).toBe(false);

        releaseMarketplaceContent(
          new Response(
            JSON.stringify({
              type: "file",
              name: "marketplace.json",
              path: ".agents/plugins/marketplace.json",
              url: "https://api.github.com/repos/mweinbach/cowork-skills-plugins/contents/.agents/plugins/marketplace.json?ref=main",
              download_url: "https://download.test/marketplace.json",
            }),
            { headers: { "content-type": "application/json" } },
          ),
        );
        await waitForCondition(() => fetchCalls.length === 2);
        await flushAsyncWork();

        const pluginCatalogs = events.filter((event) => event.type === "plugins_catalog");
        expect(pluginCatalogs).toHaveLength(2);
        expect(pluginCatalogs.at(-1)?.catalog.plugins[0]?.enabled).toBe(false);
      } finally {
        globalThis.fetch = originalFetch;
        await fs.rm(root, { recursive: true, force: true });
      }
    });
  });
});
