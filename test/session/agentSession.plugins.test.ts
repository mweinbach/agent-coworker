import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import {
  REAL_AGENT,
  AgentSession,
  ASK_SKIP_TOKEN,
  SessionCostTracker,
  createExperimentalA2uiSurfaceManager,
  createRuntime,
  defaultSupportedModel,
  fs,
  getSupportedModel,
  MAX_ATTACHMENT_BASE64_SIZE,
  MAX_ATTACHMENT_INLINE_BYTE_SIZE,
  MAX_TURN_ATTACHMENT_COUNT,
  MAX_TURN_ATTACHMENT_TOTAL_BASE64_SIZE,
  mockClosePooledCodexAppServerClient,
  mockConnectModelProvider,
  mockGenerateSessionTitle,
  mockGetAiCoworkerPaths,
  mockRunTurn,
  mockWritePersistedSessionSnapshot,
  os,
  path,
  resetAgentSessionMocks,
  makeSession,
  makeConfig,
  makeEmit,
  makeSessionBackupFactory,
  flushAsyncWork,
  waitForCondition,
  withEnv,
  isRecord,
} from "./agentSession.harness";
import type { TodoItem } from "./agentSession.harness";

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
  });
});
